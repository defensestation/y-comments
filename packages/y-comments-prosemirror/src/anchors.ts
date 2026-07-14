import type { Anchor } from "@defensestation/y-comments-core";
import type { EditorState } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { absolutePositionToRelativePosition } from "y-prosemirror";
import * as Y from "yjs";
import { getYSyncState } from "./ysync.js";

export const MAX_QUOTE_LENGTH = 2000;
export const DEFAULT_CONTEXT_LENGTH = 32;

/**
 * Block separator used for every plain-text projection of the document
 * (quoted text, prefix/suffix, DocAdapter docText/containerText). All of
 * them must agree, or a quote that spans blocks could never re-anchor.
 */
export const BLOCK_SEPARATOR = "\n";
/** Inline leaf nodes project to one character, keeping offsets aligned. */
export const LEAF_TEXT = " ";

export interface AnchorFromSelectionOptions {
  /** Max chars of prefix/suffix context stored. Default 32. */
  contextLen?: number;
  /**
   * Max selection size (chars) we are willing to anchor. Larger selections
   * are refused rather than truncated — a truncated quote would silently
   * degrade re-anchoring. Default 2000.
   */
  maxQuoteLength?: number;
}

/** Build an Anchor for the current selection. Throws on empty selections. */
export function anchorFromSelection(view: EditorView, opts?: AnchorFromSelectionOptions): Anchor {
  const { from, to } = view.state.selection;
  return anchorFromRange(view.state, from, to, opts);
}

/** Build an Anchor for an arbitrary document range. */
export function anchorFromRange(
  state: EditorState,
  from: number,
  to: number,
  opts?: AnchorFromSelectionOptions
): Anchor {
  const contextLen = opts?.contextLen ?? DEFAULT_CONTEXT_LENGTH;
  const maxQuoteLength = opts?.maxQuoteLength ?? MAX_QUOTE_LENGTH;
  const ystate = getYSyncState(state);

  const quotedText = state.doc.textBetween(from, to, BLOCK_SEPARATOR, LEAF_TEXT);
  if (quotedText.trim().length === 0) {
    throw new Error("y-comments: cannot create an anchor for an empty or whitespace-only selection.");
  }
  if (quotedText.length > maxQuoteLength) {
    throw new Error(
      `y-comments: refusing to anchor a selection of ${quotedText.length} chars ` +
        `(limit ${maxQuoteLength}). Comment on a smaller selection instead.`
    );
  }

  const $from = state.doc.resolve(from);
  const $to = state.doc.resolve(to);

  // Context clamped to the enclosing textblock on each side.
  const prefixStart = Math.max($from.start(), from - contextLen);
  const prefix = state.doc.textBetween(prefixStart, from, BLOCK_SEPARATOR, LEAF_TEXT);
  const suffixEnd = Math.min($to.end(), to + contextLen);
  const suffix = state.doc.textBetween(to, suffixEnd, BLOCK_SEPARATOR, LEAF_TEXT);

  // Nearest ancestor with a stable id attr — BlockNote's blockContainer.
  let containerId: string | undefined;
  for (let depth = $from.depth; depth > 0; depth--) {
    const id = $from.node(depth).attrs?.id;
    if (typeof id === "string" && id.length > 0) {
      containerId = id;
      break;
    }
  }

  // `from` associates right and `to` associates left, so typing at the
  // edges of the range does not grow the highlight.
  const relFrom = absolutePositionToRelativePosition(from, ystate.type, ystate.binding.mapping);
  const relTo = withLeftAssociation(
    absolutePositionToRelativePosition(to, ystate.type, ystate.binding.mapping),
    ystate.doc
  );

  return {
    relFrom: Y.encodeRelativePosition(relFrom),
    relTo: Y.encodeRelativePosition(relTo),
    containerId,
    quotedText,
    prefix,
    suffix,
  };
}

/**
 * y-prosemirror always creates right-associated relative positions; rebuild
 * the range end as left-associated so it sticks to the last selected
 * character instead of whatever follows it.
 */
function withLeftAssociation(relPos: Y.RelativePosition, doc: Y.Doc): Y.RelativePosition {
  const abs = Y.createAbsolutePositionFromRelativePosition(relPos, doc);
  if (abs === null || !(abs.type instanceof Y.XmlText)) {
    return relPos;
  }
  return Y.createRelativePositionFromTypeIndex(abs.type, abs.index, -1);
}
