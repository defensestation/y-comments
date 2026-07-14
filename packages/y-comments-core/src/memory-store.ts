import { AllowAllThreadStoreAuth, type ThreadStore, type ThreadStoreAuth } from "./store.js";
import type { Anchor, Comment, CommentBody, Thread } from "./types.js";

let idCounter = 0;

function generateId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c?.randomUUID) {
    return c.randomUUID();
  }
  return `id-${Date.now()}-${idCounter++}`;
}

function cloneThread(thread: Thread): Thread {
  return {
    ...thread,
    anchor: { ...thread.anchor },
    comments: thread.comments.map((c) => ({
      ...c,
      body: { ...c.body },
      reactions: c.reactions.map((r) => ({ emoji: r.emoji, userIds: [...r.userIds] })),
    })),
  };
}

export interface InMemoryThreadStoreOptions {
  userId: string;
  auth?: ThreadStoreAuth;
  now?: () => string;
}

/**
 * ThreadStore backed by process memory, for the example app and tests.
 * Change notifications fire synchronously on a microtask after each write.
 */
export class InMemoryThreadStore implements ThreadStore {
  readonly auth: ThreadStoreAuth;

  private readonly userId: string;
  private readonly now: () => string;
  private readonly threads = new Map<string, Thread>();
  private readonly subscribers = new Map<string, Set<(threads: Thread[]) => void>>();

  constructor(options: InMemoryThreadStoreOptions) {
    this.userId = options.userId;
    this.auth = options.auth ?? new AllowAllThreadStoreAuth();
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async getThreads(docId: string): Promise<Thread[]> {
    return this.snapshot(docId);
  }

  async createThread(input: { docId: string; anchor: Anchor; body: CommentBody }): Promise<Thread> {
    const timestamp = this.now();
    const thread: Thread = {
      id: generateId(),
      docId: input.docId,
      anchor: input.anchor,
      comments: [
        {
          id: generateId(),
          userId: this.userId,
          body: input.body,
          createdAt: timestamp,
          reactions: [],
        },
      ],
      resolved: false,
      createdAt: timestamp,
    };
    this.threads.set(thread.id, thread);
    this.notify(thread.docId);
    return cloneThread(thread);
  }

  async addComment(input: { threadId: string; body: CommentBody }): Promise<Comment> {
    const thread = this.getThread(input.threadId);
    const comment: Comment = {
      id: generateId(),
      userId: this.userId,
      body: input.body,
      createdAt: this.now(),
      reactions: [],
    };
    thread.comments.push(comment);
    this.notify(thread.docId);
    return { ...comment };
  }

  async updateComment(input: { threadId: string; commentId: string; body: CommentBody }): Promise<Comment> {
    const thread = this.getThread(input.threadId);
    const comment = thread.comments.find((c) => c.id === input.commentId);
    if (!comment) {
      throw new Error(`Comment not found: ${input.commentId}`);
    }
    comment.body = input.body;
    comment.updatedAt = this.now();
    this.notify(thread.docId);
    return { ...comment };
  }

  async deleteComment(input: { threadId: string; commentId: string }): Promise<void> {
    const thread = this.getThread(input.threadId);
    const index = thread.comments.findIndex((c) => c.id === input.commentId);
    if (index === -1) {
      throw new Error(`Comment not found: ${input.commentId}`);
    }
    thread.comments.splice(index, 1);
    if (thread.comments.length === 0) {
      this.threads.delete(thread.id);
    }
    this.notify(thread.docId);
  }

  async deleteThread(input: { threadId: string }): Promise<void> {
    const thread = this.getThread(input.threadId);
    this.threads.delete(thread.id);
    this.notify(thread.docId);
  }

  async resolveThread(input: { threadId: string }): Promise<void> {
    const thread = this.getThread(input.threadId);
    thread.resolved = true;
    thread.resolvedBy = this.userId;
    thread.resolvedAt = this.now();
    this.notify(thread.docId);
  }

  async unresolveThread(input: { threadId: string }): Promise<void> {
    const thread = this.getThread(input.threadId);
    thread.resolved = false;
    thread.resolvedBy = undefined;
    thread.resolvedAt = undefined;
    this.notify(thread.docId);
  }

  async addReaction(input: { threadId: string; commentId: string; emoji: string }): Promise<void> {
    const comment = this.getComment(input.threadId, input.commentId);
    let reaction = comment.reactions.find((r) => r.emoji === input.emoji);
    if (!reaction) {
      reaction = { emoji: input.emoji, userIds: [] };
      comment.reactions.push(reaction);
    }
    if (!reaction.userIds.includes(this.userId)) {
      reaction.userIds.push(this.userId);
    }
    this.notify(this.getThread(input.threadId).docId);
  }

  async deleteReaction(input: { threadId: string; commentId: string; emoji: string }): Promise<void> {
    const comment = this.getComment(input.threadId, input.commentId);
    const reaction = comment.reactions.find((r) => r.emoji === input.emoji);
    if (reaction) {
      reaction.userIds = reaction.userIds.filter((u) => u !== this.userId);
      if (reaction.userIds.length === 0) {
        comment.reactions = comment.reactions.filter((r) => r !== reaction);
      }
    }
    this.notify(this.getThread(input.threadId).docId);
  }

  async updateAnchor(input: { threadId: string; anchor: Anchor }): Promise<void> {
    const thread = this.getThread(input.threadId);
    thread.anchor = input.anchor;
    this.notify(thread.docId);
  }

  subscribe(docId: string, onChange: (threads: Thread[]) => void): () => void {
    let subs = this.subscribers.get(docId);
    if (!subs) {
      subs = new Set();
      this.subscribers.set(docId, subs);
    }
    subs.add(onChange);
    onChange(this.snapshot(docId));
    return () => {
      subs.delete(onChange);
    };
  }

  private snapshot(docId: string): Thread[] {
    return [...this.threads.values()].filter((t) => t.docId === docId).map(cloneThread);
  }

  private notify(docId: string): void {
    const subs = this.subscribers.get(docId);
    if (!subs || subs.size === 0) {
      return;
    }
    const threads = this.snapshot(docId);
    for (const cb of subs) {
      cb(threads);
    }
  }

  private getThread(threadId: string): Thread {
    const thread = this.threads.get(threadId);
    if (!thread) {
      throw new Error(`Thread not found: ${threadId}`);
    }
    return thread;
  }

  private getComment(threadId: string, commentId: string): Comment {
    const comment = this.getThread(threadId).comments.find((c) => c.id === commentId);
    if (!comment) {
      throw new Error(`Comment not found: ${commentId}`);
    }
    return comment;
  }
}
