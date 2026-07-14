import type { DocAdapter, RelResolved } from "@defensestation/y-comments-core";
import type { Node as PMNode } from "prosemirror-model";
import type { EditorState } from "prosemirror-state";
import { relativePositionToAbsolutePosition } from "y-prosemirror";
import * as Y from "yjs";
import { BLOCK_SEPARATOR, LEAF_TEXT } from "./anchors.js";
import { getYSyncState } from "./ysync.js";

interface TextSegment {
  /** Offset of this textblock's text within the joined string. */
  textStart: number;
  /** PM position of the textblock's first content position. */
  pmStart: number;
  length: number;
}

interface TextMap {
  text: string;
  segments: TextSegment[];
}

/**
 * Flatten every textblock under `root` into one string, joined with
 * BLOCK_SEPARATOR, recording enough to map text offsets back to PM
 * positions. Inline leaves count as one LEAF_TEXT char, matching how
 * anchors capture quoted text.
 */
function buildTextMap(root: PMNode, contentBase: number): TextMap {
  let text = "";
  const segments: TextSegment[] = [];

  const addTextblock = (node: PMNode, pmStart: number) => {
    if (text.length > 0) {
      text += BLOCK_SEPARATOR;
    }
    const blockText = node.textBetween(0, node.content.size, BLOCK_SEPARATOR, LEAF_TEXT);
    segments.push({ textStart: text.length, pmStart, length: blockText.length });
    text += blockText;
  };

  if (root.isTextblock) {
    addTextblock(root, contentBase);
  } else {
    root.descendants((node, pos) => {
      if (node.isTextblock) {
        addTextblock(node, contentBase + pos + 1);
        return false;
      }
      return true;
    });
  }
  return { text, segments };
}

function offsetToPmPos(map: TextMap, offset: number): number | null {
  for (const seg of map.segments) {
    if (offset >= seg.textStart && offset <= seg.textStart + seg.length) {
      return seg.pmStart + (offset - seg.textStart);
    }
  }
  return null;
}

/**
 * DocAdapter over a live y-prosemirror-bound EditorState. All resolved
 * positions are ProseMirror document positions (`RelResolved.index`) inside
 * a single shared position space (`RelResolved.type`), so core's
 * "same type, from < to" exact check keeps working.
 *
 * Build a fresh adapter per resolution pass — text maps are cached for the
 * lifetime of the adapter and go stale with the next document change.
 */
export function createDocAdapter(state: EditorState): DocAdapter {
  const ystate = getYSyncState(state);
  const positionSpace = { doc: state.doc };
  let docMap: TextMap | null = null;
  const containerMaps = new Map<string, TextMap | null>();

  const getDocMap = (): TextMap => {
    if (docMap === null) {
      docMap = buildTextMap(state.doc, 0);
    }
    return docMap;
  };

  const getContainerMap = (containerId: string): TextMap | null => {
    if (!containerMaps.has(containerId)) {
      let found: TextMap | null = null;
      state.doc.descendants((node, pos) => {
        if (found !== null) {
          return false;
        }
        if (node.attrs?.id === containerId) {
          found = buildTextMap(node, pos + 1);
          return false;
        }
        return true;
      });
      containerMaps.set(containerId, found);
    }
    return containerMaps.get(containerId) ?? null;
  };

  return {
    resolveRel(encoded: Uint8Array): RelResolved | null {
      const relPos = Y.decodeRelativePosition(encoded);
      const pos = relativePositionToAbsolutePosition(
        ystate.doc,
        ystate.type,
        relPos,
        ystate.binding.mapping
      );
      if (pos === null || pos < 0 || pos > state.doc.content.size) {
        return null;
      }
      return { type: positionSpace, index: pos };
    },

    containerText(containerId: string): string | null {
      return getContainerMap(containerId)?.text ?? null;
    },

    docText(): string {
      return getDocMap().text;
    },

    fromTextOffset(containerId: string | null, offset: number): RelResolved | null {
      const map = containerId === null ? getDocMap() : getContainerMap(containerId);
      if (map === null) {
        return null;
      }
      const pos = offsetToPmPos(map, offset);
      return pos === null ? null : { type: positionSpace, index: pos };
    },
  };
}
