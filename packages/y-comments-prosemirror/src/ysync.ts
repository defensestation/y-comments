import type { Node as PMNode } from "prosemirror-model";
import type { EditorState } from "prosemirror-state";
import { ySyncPluginKey } from "y-prosemirror";
import type * as Y from "yjs";

/** ProsemirrorMapping from y-prosemirror (Y type → PM node). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type YSyncMapping = Map<Y.AbstractType<any>, PMNode | PMNode[]>;

export interface YSyncState {
  type: Y.XmlFragment;
  doc: Y.Doc;
  binding: { mapping: YSyncMapping } | null;
}

/**
 * Read the y-prosemirror sync plugin state, throwing a descriptive error if
 * the editor is not collaborative. This package requires the y-prosemirror
 * binding that BlockNote's collaboration mode installs — without it there
 * are no Yjs relative positions to anchor to.
 */
export function getYSyncState(state: EditorState): YSyncState & { binding: { mapping: YSyncMapping } } {
  const ystate = ySyncPluginKey.getState(state) as YSyncState | undefined;
  if (!ystate || !ystate.type || !ystate.doc || !ystate.binding) {
    throw new Error(
      "y-comments: y-prosemirror sync plugin state not found. " +
        "Decoration-anchored comments require a collaborative editor bound to a Y.Doc " +
        "(for BlockNote, pass the `collaboration` option when creating the editor)."
    );
  }
  return ystate as YSyncState & { binding: { mapping: YSyncMapping } };
}
