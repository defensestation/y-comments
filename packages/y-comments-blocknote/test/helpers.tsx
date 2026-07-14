import { BlockNoteEditor } from "@blocknote/core";
import type { User } from "@defensestation/y-comments-core";
import { TextSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import * as Y from "yjs";

export interface TestEditorHandle {
  editor: BlockNoteEditor;
  ydoc: Y.Doc;
  destroy: () => void;
}

/**
 * Headless collaborative BlockNote editor mounted into jsdom, seeded with
 * one paragraph per entry of `paragraphs`.
 */
export async function createCollabEditor(paragraphs: string[]): Promise<TestEditorHandle> {
  const ydoc = new Y.Doc();
  const fragment = ydoc.getXmlFragment("document-store");

  const editor = BlockNoteEditor.create({
    collaboration: {
      fragment,
      user: { name: "Tester", color: "#ff0000" },
    },
  });

  const mount = document.createElement("div");
  document.body.appendChild(mount);
  editor.mount(mount);

  editor.replaceBlocks(
    editor.document,
    paragraphs.map((text) => ({ type: "paragraph" as const, content: text }))
  );

  return {
    editor,
    ydoc,
    destroy: () => {
      editor.unmount();
      mount.remove();
    },
  };
}

export function rangeOf(view: EditorView, text: string): { from: number; to: number } {
  let result: { from: number; to: number } | null = null;
  view.state.doc.descendants((node, pos) => {
    if (result || !node.isText || node.text === undefined) {
      return result === null;
    }
    const idx = node.text.indexOf(text);
    if (idx !== -1) {
      result = { from: pos + idx, to: pos + idx + text.length };
    }
    return false;
  });
  if (!result) {
    throw new Error(`text not found in doc: ${text}`);
  }
  return result;
}

export function selectText(editor: BlockNoteEditor, text: string): { from: number; to: number } {
  const view = editor.prosemirrorView;
  const range = rangeOf(view, text);
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, range.from, range.to)));
  return range;
}

export const testResolveUsers = async (userIds: string[]): Promise<User[]> =>
  userIds.map((id) => ({ id, username: `user-${id}` }));
