import type { Anchor, Comment, CommentBody, Thread } from "./types.js";

/**
 * UI affordance gates. Method names mirror BlockNote's ThreadStoreAuth so
 * mental models map and a migration in either direction stays cheap.
 *
 * These drive what the UI shows/enables only — real authorization is the
 * backend's job (thread bodies live behind an authenticated API, never in
 * the document).
 */
export interface ThreadStoreAuth {
  canCreateThread(): boolean;
  canAddComment(thread: Thread): boolean;
  canUpdateComment(comment: Comment): boolean;
  canDeleteComment(comment: Comment): boolean;
  canResolveThread(thread: Thread): boolean;
  canUnresolveThread(thread: Thread): boolean;
  canDeleteThread(thread: Thread): boolean;
  canAddReaction(comment: Comment, emoji?: string): boolean;
  canDeleteReaction(comment: Comment, emoji?: string): boolean;
}

/**
 * External comment storage. Method names mirror BlockNote's ThreadStore.
 *
 * Implementations must never touch the Y.Doc: the content document stays
 * byte-pure content, which is the reason this package family exists.
 */
export interface ThreadStore {
  readonly auth: ThreadStoreAuth;
  getThreads(docId: string): Promise<Thread[]>;
  createThread(input: { docId: string; anchor: Anchor; body: CommentBody }): Promise<Thread>;
  addComment(input: { threadId: string; body: CommentBody }): Promise<Comment>;
  updateComment(input: { threadId: string; commentId: string; body: CommentBody }): Promise<Comment>;
  deleteComment(input: { threadId: string; commentId: string }): Promise<void>;
  deleteThread(input: { threadId: string }): Promise<void>;
  resolveThread(input: { threadId: string }): Promise<void>;
  unresolveThread(input: { threadId: string }): Promise<void>;
  addReaction(input: { threadId: string; commentId: string; emoji: string }): Promise<void>;
  deleteReaction(input: { threadId: string; commentId: string; emoji: string }): Promise<void>;
  /**
   * Live updates. Implementations may poll, SSE, or websocket.
   * Returns an unsubscribe function.
   */
  subscribe(docId: string, onChange: (threads: Thread[]) => void): () => void;
  /**
   * Optional: replace a thread's anchor after a successful re-anchor
   * (self-healing). Only called when the adapter opted in via `selfHeal`.
   */
  updateAnchor?(input: { threadId: string; anchor: Anchor }): Promise<void>;
}

export type ThreadStoreAuthRole = "editor" | "commenter";

/** Sensible default gates, mirroring BlockNote's DefaultThreadStoreAuth. */
export class DefaultThreadStoreAuth implements ThreadStoreAuth {
  constructor(
    private readonly userId: string,
    private readonly role: ThreadStoreAuthRole = "commenter"
  ) {}

  canCreateThread(): boolean {
    return true;
  }

  canAddComment(_thread: Thread): boolean {
    return true;
  }

  canUpdateComment(comment: Comment): boolean {
    return comment.userId === this.userId;
  }

  canDeleteComment(comment: Comment): boolean {
    return comment.userId === this.userId || this.role === "editor";
  }

  canResolveThread(thread: Thread): boolean {
    return this.role === "editor" || thread.comments[0]?.userId === this.userId;
  }

  canUnresolveThread(thread: Thread): boolean {
    return this.canResolveThread(thread);
  }

  canDeleteThread(thread: Thread): boolean {
    return this.role === "editor" || thread.comments[0]?.userId === this.userId;
  }

  canAddReaction(_comment: Comment, _emoji?: string): boolean {
    return true;
  }

  canDeleteReaction(comment: Comment, emoji?: string): boolean {
    if (emoji === undefined) {
      return comment.reactions.some((r) => r.userIds.includes(this.userId));
    }
    return comment.reactions.some((r) => r.emoji === emoji && r.userIds.includes(this.userId));
  }
}

/** Permit-everything gates, for demos and tests. */
export class AllowAllThreadStoreAuth implements ThreadStoreAuth {
  canCreateThread(): boolean {
    return true;
  }
  canAddComment(): boolean {
    return true;
  }
  canUpdateComment(): boolean {
    return true;
  }
  canDeleteComment(): boolean {
    return true;
  }
  canResolveThread(): boolean {
    return true;
  }
  canUnresolveThread(): boolean {
    return true;
  }
  canDeleteThread(): boolean {
    return true;
  }
  canAddReaction(): boolean {
    return true;
  }
  canDeleteReaction(): boolean {
    return true;
  }
}
