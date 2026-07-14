import { fromBase64, toBase64 } from "./base64.js";
import { AllowAllThreadStoreAuth, type ThreadStore, type ThreadStoreAuth } from "./store.js";
import type { Anchor, Comment, CommentBody, Thread } from "./types.js";

/** Anchor as it crosses the wire: relative positions are base64 strings. */
export interface AnchorDTO extends Omit<Anchor, "relFrom" | "relTo"> {
  relFrom: string;
  relTo: string;
}

export interface ThreadDTO extends Omit<Thread, "anchor"> {
  anchor: AnchorDTO;
}

export function anchorToDTO(anchor: Anchor): AnchorDTO {
  return { ...anchor, relFrom: toBase64(anchor.relFrom), relTo: toBase64(anchor.relTo) };
}

export function anchorFromDTO(dto: AnchorDTO): Anchor {
  return { ...dto, relFrom: fromBase64(dto.relFrom), relTo: fromBase64(dto.relTo) };
}

export function threadFromDTO(dto: ThreadDTO): Thread {
  return { ...dto, anchor: anchorFromDTO(dto.anchor) };
}

type HeadersInput = Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);

export interface RestThreadStoreOptions {
  /** e.g. "https://api.example.com/v1/comments" — no trailing slash needed. */
  baseUrl: string;
  auth?: ThreadStoreAuth;
  /** Custom fetch (for auth wrappers, tests). Defaults to globalThis.fetch. */
  fetch?: typeof fetch;
  /** Static headers or an (async) factory, e.g. for bearer tokens. */
  headers?: HeadersInput;
  /** Polling interval for subscribe(). Default 10 000 ms. */
  pollIntervalMs?: number;
  /**
   * Optional SSE upgrade: URL of an EventSource per docId. Any received
   * event triggers a refetch of the thread list (the event payload is not
   * interpreted). Polling is disabled while the source is open.
   */
  sseUrl?: (docId: string) => string;
  /**
   * Called when a subscribe() refetch fails (server unreachable, 5xx…) —
   * fires once per outage, not per failed poll. Use it to show an
   * "offline / retrying" indicator; individual request errors still reject
   * their own promises.
   */
  onSubscribeError?: (error: unknown) => void;
  /** Called when polling succeeds again after onSubscribeError fired. */
  onSubscribeRecover?: () => void;
}

/**
 * ThreadStore over a plain REST backend — works against any server that
 * implements the documented contract (see README §REST contract):
 *
 *   GET    {base}/docs/{docId}/threads                        → ThreadDTO[]
 *   POST   {base}/docs/{docId}/threads         { anchor, body } → ThreadDTO
 *   POST   {base}/threads/{id}/comments        { body }         → Comment
 *   PATCH  {base}/threads/{id}/comments/{cid}  { body }         → Comment
 *   DELETE {base}/threads/{id}/comments/{cid}
 *   DELETE {base}/threads/{id}
 *   POST   {base}/threads/{id}/resolve | /unresolve
 *   POST   {base}/threads/{id}/comments/{cid}/reactions  { emoji }
 *   DELETE {base}/threads/{id}/comments/{cid}/reactions/{emoji}
 *   PATCH  {base}/threads/{id}/anchor           { anchor }        (optional, self-heal)
 *
 * All authorization is server-side; the client `auth` gates UI only.
 */
export class RestThreadStore implements ThreadStore {
  readonly auth: ThreadStoreAuth;

  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly headers?: HeadersInput;
  private readonly pollIntervalMs: number;
  private readonly sseUrl?: (docId: string) => string;
  private readonly onSubscribeError?: (error: unknown) => void;
  private readonly onSubscribeRecover?: () => void;
  /** Refetchers of live subscriptions, poked after each successful mutation
   *  so the UI reflects the user's own action immediately instead of on the
   *  next poll tick. */
  private readonly activeRefetches = new Set<() => void>();

  constructor(options: RestThreadStoreOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.auth = options.auth ?? new AllowAllThreadStoreAuth();
    this.fetchFn = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.headers = options.headers;
    this.pollIntervalMs = options.pollIntervalMs ?? 10_000;
    this.sseUrl = options.sseUrl;
    this.onSubscribeError = options.onSubscribeError;
    this.onSubscribeRecover = options.onSubscribeRecover;
  }

  async getThreads(docId: string): Promise<Thread[]> {
    const dtos = await this.request<ThreadDTO[]>("GET", `/docs/${encodeURIComponent(docId)}/threads`);
    return dtos.map(threadFromDTO);
  }

  async createThread(input: { docId: string; anchor: Anchor; body: CommentBody }): Promise<Thread> {
    const dto = await this.request<ThreadDTO>("POST", `/docs/${encodeURIComponent(input.docId)}/threads`, {
      anchor: anchorToDTO(input.anchor),
      body: input.body,
    });
    this.refreshSubscribers();
    return threadFromDTO(dto);
  }

  async addComment(input: { threadId: string; body: CommentBody }): Promise<Comment> {
    const comment = await this.request<Comment>(
      "POST",
      `/threads/${encodeURIComponent(input.threadId)}/comments`,
      { body: input.body }
    );
    this.refreshSubscribers();
    return comment;
  }

  async updateComment(input: { threadId: string; commentId: string; body: CommentBody }): Promise<Comment> {
    const comment = await this.request<Comment>(
      "PATCH",
      `/threads/${encodeURIComponent(input.threadId)}/comments/${encodeURIComponent(input.commentId)}`,
      { body: input.body }
    );
    this.refreshSubscribers();
    return comment;
  }

  async deleteComment(input: { threadId: string; commentId: string }): Promise<void> {
    await this.request(
      "DELETE",
      `/threads/${encodeURIComponent(input.threadId)}/comments/${encodeURIComponent(input.commentId)}`
    );
    this.refreshSubscribers();
  }

  async deleteThread(input: { threadId: string }): Promise<void> {
    await this.request("DELETE", `/threads/${encodeURIComponent(input.threadId)}`);
    this.refreshSubscribers();
  }

  async resolveThread(input: { threadId: string }): Promise<void> {
    await this.request("POST", `/threads/${encodeURIComponent(input.threadId)}/resolve`);
    this.refreshSubscribers();
  }

  async unresolveThread(input: { threadId: string }): Promise<void> {
    await this.request("POST", `/threads/${encodeURIComponent(input.threadId)}/unresolve`);
    this.refreshSubscribers();
  }

  async addReaction(input: { threadId: string; commentId: string; emoji: string }): Promise<void> {
    await this.request(
      "POST",
      `/threads/${encodeURIComponent(input.threadId)}/comments/${encodeURIComponent(input.commentId)}/reactions`,
      { emoji: input.emoji }
    );
    this.refreshSubscribers();
  }

  async deleteReaction(input: { threadId: string; commentId: string; emoji: string }): Promise<void> {
    await this.request(
      "DELETE",
      `/threads/${encodeURIComponent(input.threadId)}/comments/${encodeURIComponent(
        input.commentId
      )}/reactions/${encodeURIComponent(input.emoji)}`
    );
    this.refreshSubscribers();
  }

  async updateAnchor(input: { threadId: string; anchor: Anchor }): Promise<void> {
    await this.request("PATCH", `/threads/${encodeURIComponent(input.threadId)}/anchor`, {
      anchor: anchorToDTO(input.anchor),
    });
  }

  subscribe(docId: string, onChange: (threads: Thread[]) => void): () => void {
    let stopped = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    let source: EventSource | undefined;
    let failing = false;

    const refetch = () => {
      this.getThreads(docId).then(
        (threads) => {
          if (stopped) {
            return;
          }
          if (failing) {
            failing = false;
            this.onSubscribeRecover?.();
          }
          onChange(threads);
        },
        (error) => {
          if (stopped || failing) {
            return; // next tick retries; report only the outage transition
          }
          failing = true;
          this.onSubscribeError?.(error);
        }
      );
    };

    refetch();
    this.activeRefetches.add(refetch);

    if (this.sseUrl && typeof EventSource !== "undefined") {
      source = new EventSource(this.sseUrl(docId));
      source.onmessage = refetch;
      source.onerror = () => {
        // EventSource retries automatically; nothing to do.
      };
    } else {
      timer = setInterval(refetch, this.pollIntervalMs);
    }

    return () => {
      stopped = true;
      this.activeRefetches.delete(refetch);
      if (timer !== undefined) {
        clearInterval(timer);
      }
      source?.close();
    };
  }

  /** Refetch every live subscription now (a mutation just succeeded).
   *  updateAnchor is deliberately excluded: self-healing writes on read
   *  paths, where an extra refetch per heal is just traffic. */
  private refreshSubscribers(): void {
    for (const refetch of this.activeRefetches) {
      refetch();
    }
  }

  private async request<T = void>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      ...(typeof this.headers === "function" ? await this.headers() : this.headers),
    };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    const response = await this.fetchFn(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) {
      throw new Error(`RestThreadStore: ${method} ${path} failed with ${response.status}`);
    }
    if (response.status === 204) {
      return undefined as T;
    }
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
}
