import { resolveThread } from "@defensestation/y-comments-core";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { anchorFromSelection } from "../src/anchors.js";
import { createDocAdapter } from "../src/doc-adapter.js";
import {
  applyRemoteEdit,
  createTestEditor,
  firstXmlText,
  makeThread,
  rangeOf,
  select,
  type TestEditor,
} from "./helpers.js";

let editor: TestEditor;
afterEach(() => editor?.destroy());

const BLOCKS = [
  { id: "block-1", text: "The quick brown fox jumps over the lazy dog" },
  { id: "block-2", text: "Second block mentions the fox too" },
];

describe("anchorFromSelection", () => {
  it("captures quote, clamped context and the enclosing block id", () => {
    editor = createTestEditor(BLOCKS);
    const { from, to } = rangeOf(editor.view, "brown fox");
    select(editor.view, from, to);

    const anchor = anchorFromSelection(editor.view);
    expect(anchor.quotedText).toBe("brown fox");
    expect(anchor.prefix).toBe("The quick ");
    expect(anchor.suffix).toBe(" jumps over the lazy dog");
    expect(anchor.containerId).toBe("block-1");
    expect(anchor.relFrom).toBeInstanceOf(Uint8Array);
    expect(anchor.relTo).toBeInstanceOf(Uint8Array);
  });

  it("round-trips through the adapter to the original positions", () => {
    editor = createTestEditor(BLOCKS);
    const { from, to } = rangeOf(editor.view, "brown fox");
    select(editor.view, from, to);
    const anchor = anchorFromSelection(editor.view);

    const adapter = createDocAdapter(editor.view.state);
    expect(adapter.resolveRel(anchor.relFrom)?.index).toBe(from);
    expect(adapter.resolveRel(anchor.relTo)?.index).toBe(to);
  });

  it("rejects empty and whitespace-only selections", () => {
    editor = createTestEditor(BLOCKS);
    const { from } = rangeOf(editor.view, "brown");
    select(editor.view, from, from);
    expect(() => anchorFromSelection(editor.view)).toThrow(/empty/);
  });

  it("refuses selections beyond the quote cap instead of truncating", () => {
    editor = createTestEditor([{ id: "block-1", text: "x".repeat(50) }]);
    const { from, to } = rangeOf(editor.view, "x".repeat(50));
    select(editor.view, from, to);
    expect(() => anchorFromSelection(editor.view, { maxQuoteLength: 10 })).toThrow(/refusing/);
  });

  it("throws a descriptive error without a y-prosemirror binding", async () => {
    const { EditorState } = await import("prosemirror-state");
    const { EditorView } = await import("prosemirror-view");
    const { blockNoteishSchema, docFromBlocks } = await import("./helpers.js");
    const view = new EditorView(document.createElement("div"), {
      state: EditorState.create({ schema: blockNoteishSchema, doc: docFromBlocks(BLOCKS) }),
    });
    select(view, 4, 9);
    expect(() => anchorFromSelection(view)).toThrow(/collaborative/);
    view.destroy();
  });

  it("creates anchors without producing any Yjs document updates", () => {
    editor = createTestEditor(BLOCKS);
    const { from, to } = rangeOf(editor.view, "brown fox");
    select(editor.view, from, to);
    let updates = 0;
    editor.ydoc.on("update", () => updates++);
    anchorFromSelection(editor.view);
    expect(updates).toBe(0);
  });
});

describe("resolution against a live binding", () => {
  it("tracks concurrent remote edits (before / inside / after)", () => {
    editor = createTestEditor(BLOCKS);
    const { from, to } = rangeOf(editor.view, "brown fox");
    select(editor.view, from, to);
    const thread = makeThread(anchorFromSelection(editor.view));

    applyRemoteEdit(editor.ydoc, (remote) => {
      const text = firstXmlText(remote.getXmlFragment("doc"));
      text.insert(0, "PREFIX ");
      text.insert("PREFIX The quick brown".length, "ish");
      text.insert(text.length, " SUFFIX");
    });

    const state = editor.view.state;
    const resolution = resolveThread(thread, createDocAdapter(state));
    expect(resolution.kind).toBe("exact");
    if (resolution.kind === "exact") {
      expect(state.doc.textBetween(resolution.from.index, resolution.to.index)).toBe("brownish fox");
    }
  });

  it("re-anchors via quote search after delete + retype", () => {
    editor = createTestEditor(BLOCKS);
    const { from, to } = rangeOf(editor.view, "brown fox");
    select(editor.view, from, to);
    const thread = makeThread(anchorFromSelection(editor.view));

    editor.view.dispatch(editor.view.state.tr.delete(from, to));
    editor.view.dispatch(editor.view.state.tr.insertText("brown fox", from));

    const state = editor.view.state;
    const resolution = resolveThread(thread, createDocAdapter(state));
    expect(resolution.kind).toBe("reanchored");
    if (resolution.kind === "reanchored") {
      expect(state.doc.textBetween(resolution.from.index, resolution.to.index)).toBe("brown fox");
    }
  });

  it("falls back to the container when the quote is deleted", () => {
    editor = createTestEditor(BLOCKS);
    const { from, to } = rangeOf(editor.view, "brown fox");
    select(editor.view, from, to);
    const thread = makeThread(anchorFromSelection(editor.view));

    editor.view.dispatch(editor.view.state.tr.delete(from, to));

    expect(resolveThread(thread, createDocAdapter(editor.view.state)).kind).toBe("container");
  });

  it("finds the quote in another block when the original block is gone", () => {
    editor = createTestEditor(BLOCKS);
    const { from, to } = rangeOf(editor.view, "brown fox");
    select(editor.view, from, to);
    const thread = makeThread(anchorFromSelection(editor.view));

    // Move the quote into block-2 and delete block-1 entirely.
    const b2 = rangeOf(editor.view, "fox too");
    editor.view.dispatch(editor.view.state.tr.insertText(" brown fox appears", b2.to));
    const state = editor.view.state;
    let containerPos = -1;
    let containerNode: import("prosemirror-model").Node | null = null;
    state.doc.descendants((node, pos) => {
      if (node.attrs?.id === "block-1") {
        containerPos = pos;
        containerNode = node;
        return false;
      }
      return true;
    });
    expect(containerNode).not.toBeNull();
    editor.view.dispatch(state.tr.delete(containerPos, containerPos + containerNode!.nodeSize));

    const resolution = resolveThread(thread, createDocAdapter(editor.view.state));
    expect(resolution.kind).toBe("reanchored");
    if (resolution.kind === "reanchored") {
      expect(
        editor.view.state.doc.textBetween(resolution.from.index, resolution.to.index)
      ).toBe("brown fox");
    }
  });
});
