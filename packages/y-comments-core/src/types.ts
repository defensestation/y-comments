/** Everything needed to find a comment's range again, in fidelity order. */
export interface Anchor {
  /** Y.RelativePosition, encoded with Y.encodeRelativePosition. Primary. */
  relFrom: Uint8Array;
  relTo: Uint8Array;
  /**
   * Stable container hint. For BlockNote: the block ID. Optional for
   * other editors. Used by fallback step 2.
   */
  containerId?: string;
  /**
   * Exact text selected at creation time. Used by fallback steps 2-3 and
   * as the human-readable quote for orphaned threads.
   */
  quotedText: string;
  /**
   * Up to 32 chars of plain text immediately before/after the selection,
   * to disambiguate repeated quotes.
   */
  prefix: string;
  suffix: string;
}

/** Portable rich-ish comment body. */
export interface CommentBody {
  /** Plain text (always present). */
  text: string;
  /** Optional rich body, opaque to core. */
  json?: unknown;
}

export interface CommentReaction {
  emoji: string;
  userIds: string[];
}

export interface Comment {
  id: string;
  userId: string;
  body: CommentBody;
  /** ISO-8601. */
  createdAt: string;
  updatedAt?: string;
  reactions: CommentReaction[];
}

export interface Thread {
  id: string;
  docId: string;
  anchor: Anchor;
  /** [0] is the root comment. */
  comments: Comment[];
  resolved: boolean;
  resolvedBy?: string;
  resolvedAt?: string;
  /** Set server-side or by the resolver sweep; the UI renders it regardless. */
  outdated?: boolean;
  createdAt: string;
}

/** Editor-agnostic resolved position. */
export interface RelResolved {
  /** The Y.AbstractType (or editor-defined space) the position is in. */
  type: unknown;
  /** Character index within that type. */
  index: number;
}

/** Where a resolved thread lands in the current document. */
export type Resolution =
  | { kind: "exact"; from: RelResolved; to: RelResolved }
  | { kind: "reanchored"; from: RelResolved; to: RelResolved }
  /** Container exists, text gone → pin to it. */
  | { kind: "container" }
  /** Nothing found → sidebar-only + quote. */
  | { kind: "orphaned" };

/** Consumer-supplied user lookup for avatars/names. */
export interface User {
  id: string;
  username: string;
  avatarUrl?: string;
}

export type ResolveUsersFn = (userIds: string[]) => Promise<User[]>;
