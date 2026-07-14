import * as Y from "yjs";
import type { Anchor, RelResolved } from "../src/types.js";
import type { DocAdapter } from "../src/resolve.js";

/**
 * Test DocAdapter over a Y.Doc whose "containers" are named Y.Text roots —
 * the simplest editor-shaped structure expressible with only yjs. docText()
 * joins containers with "\n", mirroring how a real adapter flattens blocks.
 */
export class YTextAdapter implements DocAdapter {
  constructor(
    private readonly doc: Y.Doc,
    /** insertion-ordered containerId → Y.Text; delete an entry to simulate a removed block */
    readonly containers: Map<string, Y.Text>
  ) {}

  resolveRel(encoded: Uint8Array): RelResolved | null {
    const abs = Y.createAbsolutePositionFromRelativePosition(
      Y.decodeRelativePosition(encoded),
      this.doc
    );
    return abs ? { type: abs.type, index: abs.index } : null;
  }

  containerText(containerId: string): string | null {
    const text = this.containers.get(containerId);
    return text ? text.toString() : null;
  }

  docText(): string {
    return [...this.containers.values()].map((t) => t.toString()).join("\n");
  }

  fromTextOffset(containerId: string | null, offset: number): RelResolved | null {
    if (containerId !== null) {
      const text = this.containers.get(containerId);
      return text ? { type: text, index: offset } : null;
    }
    let start = 0;
    for (const text of this.containers.values()) {
      const len = text.toString().length;
      if (offset <= start + len) {
        return { type: text, index: offset - start };
      }
      start += len + 1; // the "\n" join separator
    }
    return null;
  }
}

export const CONTEXT_LEN = 32;

/** Build an Anchor over [from, to) of a Y.Text the way an editor adapter would. */
export function makeAnchor(
  text: Y.Text,
  from: number,
  to: number,
  containerId?: string
): Anchor {
  const s = text.toString();
  return {
    // from associates right, to associates left, so typing at the edges
    // does not grow the highlight
    relFrom: Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, from, 0)),
    relTo: Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, to, -1)),
    containerId,
    quotedText: s.slice(from, to),
    prefix: s.slice(Math.max(0, from - CONTEXT_LEN), from),
    suffix: s.slice(to, to + CONTEXT_LEN),
  };
}

export function makeThread(anchor: Anchor, overrides: Partial<import("../src/types.js").Thread> = {}) {
  return {
    id: "t1",
    docId: "doc1",
    anchor,
    comments: [],
    resolved: false,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

/** Two-way sync between docs (full state exchange). */
export function sync(a: Y.Doc, b: Y.Doc): void {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
}

/** Text of the type a RelResolved range points into, between from and to. */
export function rangeText(from: RelResolved, to: RelResolved): string {
  return (from.type as Y.Text).toString().slice(from.index, to.index);
}
