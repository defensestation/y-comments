import type { ThreadStore, ThreadStoreAuth } from "./store.js";
import type { Anchor, Comment, CommentBody, Thread } from "./types.js";

/**
 * A change feed over any push transport — WebSocket, gRPC server-side
 * stream (via grpc-web/Connect in browsers), socket.io, …
 *
 * Called once per subscribed doc. Call `notify` whenever the server signals
 * that the doc's threads changed: pass the fresh thread list if the
 * transport carries it, or call with no argument to have the store refetch
 * through the base store's `getThreads`. Return a cleanup that closes the
 * feed. Reconnection policy is the transport's own business.
 */
export type PushTransport = (
  docId: string,
  notify: (threads?: Thread[]) => void
) => () => void;

export interface PushThreadStoreOptions {
  /** Called when a notify-triggered refetch fails. Individual request
   *  errors still reject their own promises. */
  onSubscribeError?: (error: unknown) => void;
}

/**
 * Replaces a base store's `subscribe` (polling, for `RestThreadStore`) with
 * a push transport; everything else — reads, mutations, auth — delegates to
 * the base store. Mutations still refresh live subscriptions immediately,
 * so the caller's own actions never wait for the server to push.
 *
 *   const store = new PushThreadStore(
 *     new RestThreadStore({ baseUrl: "/api" }),
 *     (docId, notify) => {
 *       const ws = new WebSocket(`wss://…/docs/${docId}/comments`);
 *       ws.onmessage = () => notify();
 *       return () => ws.close();
 *     }
 *   );
 */
export class PushThreadStore implements ThreadStore {
  readonly auth: ThreadStoreAuth;
  readonly updateAnchor?: (input: { threadId: string; anchor: Anchor }) => Promise<void>;

  private readonly base: ThreadStore;
  private readonly transport: PushTransport;
  private readonly onSubscribeError?: (error: unknown) => void;
  private readonly activeRefetches = new Set<() => void>();

  constructor(base: ThreadStore, transport: PushTransport, options: PushThreadStoreOptions = {}) {
    this.base = base;
    this.transport = transport;
    this.onSubscribeError = options.onSubscribeError;
    this.auth = base.auth;
    if (base.updateAnchor) {
      this.updateAnchor = (input) => this.base.updateAnchor!(input);
    }
  }

  getThreads(docId: string): Promise<Thread[]> {
    return this.base.getThreads(docId);
  }

  async createThread(input: { docId: string; anchor: Anchor; body: CommentBody }): Promise<Thread> {
    const thread = await this.base.createThread(input);
    this.refreshSubscribers();
    return thread;
  }

  async addComment(input: { threadId: string; body: CommentBody }): Promise<Comment> {
    const comment = await this.base.addComment(input);
    this.refreshSubscribers();
    return comment;
  }

  async updateComment(input: { threadId: string; commentId: string; body: CommentBody }): Promise<Comment> {
    const comment = await this.base.updateComment(input);
    this.refreshSubscribers();
    return comment;
  }

  async deleteComment(input: { threadId: string; commentId: string }): Promise<void> {
    await this.base.deleteComment(input);
    this.refreshSubscribers();
  }

  async deleteThread(input: { threadId: string }): Promise<void> {
    await this.base.deleteThread(input);
    this.refreshSubscribers();
  }

  async resolveThread(input: { threadId: string }): Promise<void> {
    await this.base.resolveThread(input);
    this.refreshSubscribers();
  }

  async unresolveThread(input: { threadId: string }): Promise<void> {
    await this.base.unresolveThread(input);
    this.refreshSubscribers();
  }

  async addReaction(input: { threadId: string; commentId: string; emoji: string }): Promise<void> {
    await this.base.addReaction(input);
    this.refreshSubscribers();
  }

  async deleteReaction(input: { threadId: string; commentId: string; emoji: string }): Promise<void> {
    await this.base.deleteReaction(input);
    this.refreshSubscribers();
  }

  subscribe(docId: string, onChange: (threads: Thread[]) => void): () => void {
    let stopped = false;

    const refetch = () => {
      this.base.getThreads(docId).then(
        (threads) => {
          if (!stopped) {
            onChange(threads);
          }
        },
        (error) => {
          if (!stopped) {
            this.onSubscribeError?.(error);
          }
        }
      );
    };

    refetch();
    this.activeRefetches.add(refetch);

    const disconnect = this.transport(docId, (threads) => {
      if (stopped) {
        return;
      }
      if (threads !== undefined) {
        onChange(threads);
      } else {
        refetch();
      }
    });

    return () => {
      stopped = true;
      this.activeRefetches.delete(refetch);
      disconnect();
    };
  }

  private refreshSubscribers(): void {
    for (const refetch of this.activeRefetches) {
      refetch();
    }
  }
}
