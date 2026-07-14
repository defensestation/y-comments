import type { Anchor, Thread } from "@defensestation/y-comments-core";
import { Schema, type Node as PMNode } from "prosemirror-model";
import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { ySyncPlugin } from "y-prosemirror";
import * as Y from "yjs";
import { yCommentsPlugin, type YCommentsPluginOptions } from "../src/plugin.js";

/** Minimal BlockNote-shaped schema: doc > blockGroup > blockContainer+ > paragraph blockGroup? */
export const blockNoteishSchema = new Schema({
  nodes: {
    doc: { content: "blockGroup" },
    blockGroup: { content: "blockContainer+", toDOM: () => ["div", { class: "bn-group" }, 0] },
    blockContainer: {
      content: "paragraph blockGroup?",
      attrs: { id: { default: null } },
      toDOM: (node) => ["div", { "data-id": node.attrs.id }, 0],
    },
    paragraph: { content: "inline*", toDOM: () => ["p", 0] },
    text: { group: "inline" },
  },
});

export function docFromBlocks(blocks: { id: string; text: string }[]): PMNode {
  return blockNoteishSchema.nodeFromJSON({
    type: "doc",
    content: [
      {
        type: "blockGroup",
        content: blocks.map((b) => ({
          type: "blockContainer",
          attrs: { id: b.id },
          content: [
            {
              type: "paragraph",
              content: b.text.length > 0 ? [{ type: "text", text: b.text }] : [],
            },
          ],
        })),
      },
    ],
  });
}

export interface TestEditor {
  view: EditorView;
  ydoc: Y.Doc;
  fragment: Y.XmlFragment;
  destroy: () => void;
}

/**
 * A collaborative editor in jsdom: EditorView bound to a Y.Doc via
 * ySyncPlugin, seeded with the given blocks (the seeding transaction goes
 * through the binding, populating the Y.XmlFragment).
 */
export function createTestEditor(
  blocks: { id: string; text: string }[],
  pluginOptions?: YCommentsPluginOptions
): TestEditor {
  const ydoc = new Y.Doc();
  ydoc.clientID = 1;
  const fragment = ydoc.getXmlFragment("doc");

  const mount = document.createElement("div");
  document.body.appendChild(mount);

  const state = EditorState.create({
    schema: blockNoteishSchema,
    plugins: [ySyncPlugin(fragment), yCommentsPlugin(pluginOptions)],
  });
  const view = new EditorView(mount, { state });

  const doc = docFromBlocks(blocks);
  view.dispatch(view.state.tr.replaceWith(0, view.state.doc.content.size, doc.content));

  return {
    view,
    ydoc,
    fragment,
    destroy: () => {
      view.destroy();
      mount.remove();
    },
  };
}

/** PM positions of `text` within the current doc (first occurrence). */
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

export function select(view: EditorView, from: number, to: number): void {
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)));
}

export function makeThread(anchor: Anchor, id = "t1"): Thread {
  return {
    id,
    docId: "doc1",
    anchor,
    comments: [],
    resolved: false,
    createdAt: new Date().toISOString(),
  };
}

/** Apply a remote peer's edit function and sync it back into the editor doc. */
export function applyRemoteEdit(local: Y.Doc, edit: (remote: Y.Doc) => void): void {
  const remote = new Y.Doc();
  remote.clientID = 2;
  Y.applyUpdate(remote, Y.encodeStateAsUpdate(local));
  edit(remote);
  Y.applyUpdate(local, Y.encodeStateAsUpdate(remote));
}

/** The first (and in these tests, only) Y.XmlText under a blockContainer. */
export function firstXmlText(fragment: Y.XmlFragment): Y.XmlText {
  let found: Y.XmlText | null = null;
  const walk = (node: Y.XmlFragment | Y.XmlElement) => {
    for (let i = 0; i < node.length; i++) {
      const child = node.get(i);
      if (found) {
        return;
      }
      if (child instanceof Y.XmlText) {
        found = child;
        return;
      }
      if (child instanceof Y.XmlElement) {
        walk(child);
      }
    }
  };
  walk(fragment);
  if (!found) {
    throw new Error("no Y.XmlText in fragment");
  }
  return found;
}
