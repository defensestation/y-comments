import { findQuote } from "./quote-match.js";
import type { Resolution, Thread } from "./types.js";

/**
 * The two editor hooks the resolution chain needs, supplied by an editor
 * adapter package (e.g. @defensestation/y-comments-prosemirror). Core never
 * assumes ProseMirror: positions are opaque `RelResolved` values and text
 * offsets are plain character offsets into the strings this adapter returns.
 */
export interface DocAdapter {
  /** Decode+resolve a relative position; null if unresolvable. */
  resolveRel(encoded: Uint8Array): import("./types.js").RelResolved | null;
  /**
   * Plain text of a container (for BlockNote: a block, by block ID);
   * null if the container no longer exists.
   */
  containerText(containerId: string): string | null;
  /** Plain text of the whole document. */
  docText(): string;
  /**
   * Map a (containerId?, textOffset) — an offset into `containerText` when
   * containerId is given, into `docText` otherwise — back to an editor
   * position. Null if the offset cannot be mapped.
   */
  fromTextOffset(containerId: string | null, offset: number): import("./types.js").RelResolved | null;
}

/**
 * Resolve a thread's anchor against the current document.
 *
 * Fallback chain — each step only runs if the previous failed:
 * 1. exact:      both relative positions resolve, same type, from < to
 * 2. container:  quote search within the anchor's container → reanchored
 * 3. document:   quote search over the whole document → reanchored.
 *                Runs even when the container survives: splitting a block
 *                (Enter before the commented text) moves the quote into a
 *                *new* block, and stopping at the surviving-but-empty
 *                container would wrongly outdate the thread.
 * 4. container:  container alive but quote nowhere → pin to the container
 * 5. orphaned
 *
 * Resolution never deletes anything: `container`/`orphaned` threads stay in
 * the sidebar with their quoted text ("Outdated", the GitHub
 * outdated-review-comment pattern).
 */
export function resolveThread(thread: Thread, doc: DocAdapter): Resolution {
  const { anchor } = thread;

  const from = doc.resolveRel(anchor.relFrom);
  const to = doc.resolveRel(anchor.relTo);
  if (from !== null && to !== null && from.type === to.type && from.index < to.index) {
    return { kind: "exact", from, to };
  }

  let containerAlive = false;
  if (anchor.containerId !== undefined) {
    const text = doc.containerText(anchor.containerId);
    if (text !== null) {
      containerAlive = true;
      const match = findQuote(text, anchor.quotedText, anchor.prefix, anchor.suffix);
      if (match) {
        const mFrom = doc.fromTextOffset(anchor.containerId, match.start);
        const mTo = doc.fromTextOffset(anchor.containerId, match.end);
        if (mFrom !== null && mTo !== null) {
          return { kind: "reanchored", from: mFrom, to: mTo };
        }
      }
    }
  }

  const match = findQuote(doc.docText(), anchor.quotedText, anchor.prefix, anchor.suffix);
  if (match) {
    const mFrom = doc.fromTextOffset(null, match.start);
    const mTo = doc.fromTextOffset(null, match.end);
    if (mFrom !== null && mTo !== null) {
      return { kind: "reanchored", from: mFrom, to: mTo };
    }
  }

  return containerAlive ? { kind: "container" } : { kind: "orphaned" };
}
