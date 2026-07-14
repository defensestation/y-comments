import type { ThreadStore, ThreadStoreAuth } from "./store.js";
import type { Anchor, Comment, CommentBody, Thread } from "./types.js";

let tempCounter = 0;
const tempId = () => `optimistic-${++tempCounter}`;

export interface OptimisticThreadStoreOptions {
  /** Author attributed to locally fabricated comments — must match the id
   *  the backend will attribute writes to, or the UI flickers on confirm. */
  userId: string;
  now?: () => string;
}

/**
 * One pending local mutation, replayed on top of the latest server state.
 * `apply` must be pure (no mutation of the input) and idempotent where the
 * op has no fabricated id — reapplying over server state that already
 * contains the change must be a visual no-op.
 */
type PendingOp = {
  confirmed: boolean;
  /** Ops that insert fabricated objects (create/add) are dropped when the
   *  server state contains their (post-confirm, real) id; the rest are
   *  dropped on the first server emission after confirmation. */
  insertedId?: () => { threadId?: string; commentId?: string };
  apply: (threads: Thread[]) => Thread[];
};

/**
 * Wraps any ThreadStore with local-first emissions: every mutation is
 * applied to the last server snapshot and pushed to subscribers
 * immediately, then reconciled when the base store confirms (fabricated
 * ids are swapped for server ids; duplicates are impossible because ops
 * dedupe by id). On failure the overlay is rolled back, subscribers see
 * the pre-mutation state again, and the error is rethrown so the UI's
 * inline error handling still runs.
 *
 * Mutation promises still resolve with the *server's* answer — only the
 * subscription feed is optimistic.
 *
 *   const store = new OptimisticThreadStore(
 *     new PushThreadStore(new RestThreadStore({ baseUrl: "/api" }), transport),
 *     { userId: "alice" }
 *   );
 *
 * Caveat: threads/comments created optimistically carry a temporary id
 * until the server confirms. Acting on them during that window (reply,
 * resolve, react) hits the backend with an id it doesn't know — the action
 * fails cleanly and the UI shows its inline error, but if your users are
 * fast enough to hit this, gate those affordances on non-`optimistic-` ids.
 */
export class OptimisticThreadStore implements ThreadStore {
  readonly auth: ThreadStoreAuth;
  readonly updateAnchor?: (input: { threadId: string; anchor: Anchor }) => Promise<void>;

  private readonly base: ThreadStore;
  private readonly userId: string;
  private readonly now: () => string;
  private pending: PendingOp[] = [];
  private readonly cache = new Map<string, Thread[]>();
  private readonly docs = new Map<
    string,
    { listeners: Set<(threads: Thread[]) => void>; unsubBase: () => void }
  >();

  constructor(base: ThreadStore, options: OptimisticThreadStoreOptions) {
    this.base = base;
    this.userId = options.userId;
    this.now = options.now ?? (() => new Date().toISOString());
    this.auth = base.auth;
    if (base.updateAnchor) {
      this.updateAnchor = (input) => this.base.updateAnchor!(input);
    }
  }

  getThreads(docId: string): Promise<Thread[]> {
    return this.base.getThreads(docId);
  }

  async createThread(input: { docId: string; anchor: Anchor; body: CommentBody }): Promise<Thread> {
    const timestamp = this.now();
    let thread: Thread = {
      id: tempId(),
      docId: input.docId,
      anchor: input.anchor,
      comments: [
        { id: tempId(), userId: this.userId, body: input.body, createdAt: timestamp, reactions: [] },
      ],
      resolved: false,
      createdAt: timestamp,
    };
    const op: PendingOp = {
      confirmed: false,
      insertedId: () => ({ threadId: thread.id }),
      apply: (threads) =>
        threads.some((t) => t.id === thread.id) ? threads : [...threads, thread],
    };
    return this.run(op, async () => {
      const created = await this.base.createThread(input);
      thread = created; // swap the fabricated thread for the server's
      return created;
    });
  }

  async addComment(input: { threadId: string; body: CommentBody }): Promise<Comment> {
    let comment: Comment = {
      id: tempId(),
      userId: this.userId,
      body: input.body,
      createdAt: this.now(),
      reactions: [],
    };
    const op: PendingOp = {
      confirmed: false,
      insertedId: () => ({ threadId: input.threadId, commentId: comment.id }),
      apply: (threads) =>
        threads.map((t) =>
          t.id !== input.threadId || t.comments.some((c) => c.id === comment.id)
            ? t
            : { ...t, comments: [...t.comments, comment] }
        ),
    };
    return this.run(op, async () => {
      const created = await this.base.addComment(input);
      comment = created;
      return created;
    });
  }

  async updateComment(input: { threadId: string; commentId: string; body: CommentBody }): Promise<Comment> {
    const at = this.now();
    const op: PendingOp = {
      confirmed: false,
      apply: (threads) =>
        threads.map((t) =>
          t.id !== input.threadId
            ? t
            : {
                ...t,
                comments: t.comments.map((c) =>
                  c.id === input.commentId ? { ...c, body: input.body, updatedAt: at } : c
                ),
              }
        ),
    };
    return this.run(op, () => this.base.updateComment(input));
  }

  async deleteComment(input: { threadId: string; commentId: string }): Promise<void> {
    const op: PendingOp = {
      confirmed: false,
      apply: (threads) =>
        threads
          .map((t) =>
            t.id !== input.threadId
              ? t
              : { ...t, comments: t.comments.filter((c) => c.id !== input.commentId) }
          )
          // mirror stores that drop a thread with its last comment
          .filter((t) => t.id !== input.threadId || t.comments.length > 0),
    };
    return this.run(op, () => this.base.deleteComment(input));
  }

  async deleteThread(input: { threadId: string }): Promise<void> {
    const op: PendingOp = {
      confirmed: false,
      apply: (threads) => threads.filter((t) => t.id !== input.threadId),
    };
    return this.run(op, () => this.base.deleteThread(input));
  }

  async resolveThread(input: { threadId: string }): Promise<void> {
    return this.run(this.resolveOp(input.threadId, true), () => this.base.resolveThread(input));
  }

  async unresolveThread(input: { threadId: string }): Promise<void> {
    return this.run(this.resolveOp(input.threadId, false), () => this.base.unresolveThread(input));
  }

  async addReaction(input: { threadId: string; commentId: string; emoji: string }): Promise<void> {
    const op: PendingOp = {
      confirmed: false,
      apply: (threads) =>
        this.mapComment(threads, input.threadId, input.commentId, (c) => {
          const existing = c.reactions.find((r) => r.emoji === input.emoji);
          if (existing?.userIds.includes(this.userId)) {
            return c;
          }
          const reactions = existing
            ? c.reactions.map((r) =>
                r.emoji === input.emoji ? { ...r, userIds: [...r.userIds, this.userId] } : r
              )
            : [...c.reactions, { emoji: input.emoji, userIds: [this.userId] }];
          return { ...c, reactions };
        }),
    };
    return this.run(op, () => this.base.addReaction(input));
  }

  async deleteReaction(input: { threadId: string; commentId: string; emoji: string }): Promise<void> {
    const op: PendingOp = {
      confirmed: false,
      apply: (threads) =>
        this.mapComment(threads, input.threadId, input.commentId, (c) => ({
          ...c,
          reactions: c.reactions
            .map((r) =>
              r.emoji === input.emoji
                ? { ...r, userIds: r.userIds.filter((u) => u !== this.userId) }
                : r
            )
            .filter((r) => r.userIds.length > 0),
        })),
    };
    return this.run(op, () => this.base.deleteReaction(input));
  }

  subscribe(docId: string, onChange: (threads: Thread[]) => void): () => void {
    let entry = this.docs.get(docId);
    if (!entry) {
      // register before base.subscribe — stores that emit synchronously on
      // subscribe (InMemoryThreadStore) must reach this listener
      entry = { listeners: new Set([onChange]), unsubBase: () => {} };
      this.docs.set(docId, entry);
      entry.unsubBase = this.base.subscribe(docId, (threads) => {
        this.cache.set(docId, threads);
        this.prune("emission");
        this.emit(docId);
      });
    } else {
      entry.listeners.add(onChange);
      if (this.cache.has(docId)) {
        onChange(this.derive(docId)); // base only emits initially for the first subscriber
      }
    }

    return () => {
      const current = this.docs.get(docId);
      if (!current) {
        return;
      }
      current.listeners.delete(onChange);
      if (current.listeners.size === 0) {
        current.unsubBase();
        this.docs.delete(docId);
      }
    };
  }

  /** Optimistic emission → base call → reconcile (or roll back + rethrow). */
  private async run<T>(op: PendingOp, mutate: () => Promise<T>): Promise<T> {
    this.pending.push(op);
    this.emitAll();
    try {
      const result = await mutate();
      op.confirmed = true;
      this.prune("confirm");
      this.emitAll();
      return result;
    } catch (error) {
      this.pending = this.pending.filter((p) => p !== op);
      this.emitAll();
      throw error;
    }
  }

  /**
   * Drop overlay ops the server state now covers. Insert ops go by id
   * presence (safe under any emission ordering). The rest are idempotent
   * and drop on the first emission after confirmation — with the shipped
   * stores that emission is the mutation-triggered refetch, so it already
   * contains the change.
   */
  private prune(cause: "emission" | "confirm"): void {
    this.pending = this.pending.filter((op) => {
      if (op.insertedId) {
        const { threadId, commentId } = op.insertedId();
        for (const threads of this.cache.values()) {
          const thread = threads.find((t) => t.id === threadId);
          if (commentId === undefined ? thread : thread?.comments.some((c) => c.id === commentId)) {
            return false;
          }
        }
        return true;
      }
      return !(op.confirmed && cause === "emission");
    });
  }

  private derive(docId: string): Thread[] {
    // ops referencing threads outside this doc are natural no-ops
    return this.pending.reduce((threads, op) => op.apply(threads), this.cache.get(docId) ?? []);
  }

  private emit(docId: string): void {
    const entry = this.docs.get(docId);
    if (!entry) {
      return;
    }
    const derived = this.derive(docId);
    for (const listener of entry.listeners) {
      listener(derived);
    }
  }

  private emitAll(): void {
    for (const docId of this.docs.keys()) {
      this.emit(docId);
    }
  }

  private resolveOp(threadId: string, resolved: boolean): PendingOp {
    const at = this.now();
    return {
      confirmed: false,
      apply: (threads) =>
        threads.map((t) =>
          t.id !== threadId
            ? t
            : {
                ...t,
                resolved,
                resolvedBy: resolved ? this.userId : undefined,
                resolvedAt: resolved ? at : undefined,
              }
        ),
    };
  }

  private mapComment(
    threads: Thread[],
    threadId: string,
    commentId: string,
    fn: (comment: Comment) => Comment
  ): Thread[] {
    return threads.map((t) =>
      t.id !== threadId
        ? t
        : { ...t, comments: t.comments.map((c) => (c.id === commentId ? fn(c) : c)) }
    );
  }
}
