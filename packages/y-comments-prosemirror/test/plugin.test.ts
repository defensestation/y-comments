import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { anchorFromSelection } from "../src/anchors.js";
import {
  getResolutions,
  getSelectedThreadId,
  selectThread,
  setPendingRange,
  setThreads,
  yCommentsPluginKey,
} from "../src/plugin.js";
import { createTestEditor, makeThread, rangeOf, select, type TestEditor } from "./helpers.js";

const BLOCKS = [
  { id: "block-1", text: "The quick brown fox jumps over the lazy dog" },
  { id: "block-2", text: "Second block mentions the fox too" },
];

let editor: TestEditor;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  editor?.destroy();
  vi.useRealTimers();
});

function anchorThread(text: string, id = "t1") {
  const { from, to } = rangeOf(editor.view, text);
  select(editor.view, from, to);
  return makeThread(anchorFromSelection(editor.view), id);
}

function decorationsIn(state = editor.view.state) {
  const decos = yCommentsPluginKey.getState(state)!.decorations;
  return decos.find(0, state.doc.content.size);
}

describe("yCommentsPlugin", () => {
  it("renders inline decorations for threads after the debounced resolve", () => {
    editor = createTestEditor(BLOCKS);
    const thread = anchorThread("brown fox");
    setThreads(editor.view, [thread]);

    expect(decorationsIn()).toHaveLength(0); // not resolved yet
    vi.advanceTimersByTime(200);
    const decos = decorationsIn();
    expect(decos).toHaveLength(1);

    const { from, to } = rangeOf(editor.view, "brown fox");
    expect(decos[0].from).toBe(from);
    expect(decos[0].to).toBe(to);
    expect(getResolutions(editor.view.state).get("t1")?.kind).toBe("exact");
  });

  it("maps decorations through keystrokes instantly, before the debounce", () => {
    editor = createTestEditor(BLOCKS);
    const thread = anchorThread("brown fox");
    setThreads(editor.view, [thread]);
    vi.advanceTimersByTime(200);

    const before = decorationsIn()[0];
    editor.view.dispatch(editor.view.state.tr.insertText("Hello ", 3)); // start of block-1 text
    const after = decorationsIn()[0];
    expect(after.from).toBe(before.from + "Hello ".length);
    expect(after.to).toBe(before.to + "Hello ".length);

    // trailing re-resolve agrees
    vi.advanceTimersByTime(200);
    const settled = decorationsIn()[0];
    expect(settled.from).toBe(before.from + "Hello ".length);
  });

  it("drops the highlight when the quoted text is deleted (thread pins to container)", () => {
    editor = createTestEditor(BLOCKS);
    const thread = anchorThread("brown fox");
    setThreads(editor.view, [thread]);
    vi.advanceTimersByTime(200);
    expect(decorationsIn()).toHaveLength(1);

    const { from, to } = rangeOf(editor.view, "brown fox");
    editor.view.dispatch(editor.view.state.tr.delete(from, to));
    vi.advanceTimersByTime(200);

    expect(decorationsIn()).toHaveLength(0);
    expect(getResolutions(editor.view.state).get("t1")?.kind).toBe("container");
  });

  it("renders no decoration for resolved threads", () => {
    editor = createTestEditor(BLOCKS);
    const thread = { ...anchorThread("brown fox"), resolved: true };
    setThreads(editor.view, [thread]);
    vi.advanceTimersByTime(200);
    expect(decorationsIn()).toHaveLength(0);
  });

  it("marks the selected thread's decoration active", () => {
    editor = createTestEditor(BLOCKS);
    setThreads(editor.view, [anchorThread("brown fox", "t1"), anchorThread("lazy dog", "t2")]);
    vi.advanceTimersByTime(200);

    selectThread(editor.view, "t2");
    expect(getSelectedThreadId(editor.view.state)).toBe("t2");
    expect(decorationsIn()).toHaveLength(2);

    const dom = editor.view.dom.querySelectorAll("[data-thread-id]");
    expect(dom).toHaveLength(2);
    const active = editor.view.dom.querySelectorAll(".y-comments-active");
    expect(active).toHaveLength(1);
    expect(active[0].getAttribute("data-thread-id")).toBe("t2");
  });

  it("re-resolves when the thread list changes", () => {
    editor = createTestEditor(BLOCKS);
    setThreads(editor.view, [anchorThread("brown fox", "t1")]);
    vi.advanceTimersByTime(200);
    expect(decorationsIn()).toHaveLength(1);

    setThreads(editor.view, [anchorThread("brown fox", "t1"), anchorThread("the fox too", "t2")]);
    vi.advanceTimersByTime(200);
    expect(decorationsIn()).toHaveLength(2);

    setThreads(editor.view, []);
    vi.advanceTimersByTime(200);
    expect(decorationsIn()).toHaveLength(0);
  });

  it("self-heals re-anchored threads only when opted in and text matches exactly", async () => {
    const updateAnchor = vi.fn(async () => {});
    editor = createTestEditor(BLOCKS, { selfHeal: true, store: { updateAnchor } });
    const thread = anchorThread("brown fox");
    setThreads(editor.view, [thread]);
    vi.advanceTimersByTime(200);
    expect(updateAnchor).not.toHaveBeenCalled(); // exact needs no healing

    const { from, to } = rangeOf(editor.view, "brown fox");
    editor.view.dispatch(editor.view.state.tr.delete(from, to));
    editor.view.dispatch(editor.view.state.tr.insertText("brown fox", from));
    vi.advanceTimersByTime(200);

    expect(updateAnchor).toHaveBeenCalledTimes(1);
    const arg = updateAnchor.mock.calls[0]![0] as unknown as {
      threadId: string;
      anchor: { quotedText: string };
    };
    expect(arg.threadId).toBe("t1");
    expect(arg.anchor.quotedText).toBe("brown fox");
  });

  it("shows a pending highlight for the range being commented on and maps it through edits", () => {
    editor = createTestEditor(BLOCKS);
    const { from, to } = rangeOf(editor.view, "brown fox");
    setPendingRange(editor.view, { from, to });

    const pending = () => editor.view.dom.querySelector(".y-comments-pending");
    expect(pending()?.textContent).toBe("brown fox");

    editor.view.dispatch(editor.view.state.tr.insertText("Hello ", 3));
    expect(pending()?.textContent).toBe("brown fox");

    setPendingRange(editor.view, null);
    expect(pending()).toBeNull();
  });

  it("never writes to the Y.Doc from any plugin path", () => {
    editor = createTestEditor(BLOCKS);
    let updates = 0;
    editor.ydoc.on("update", () => updates++);

    setThreads(editor.view, [anchorThread("brown fox")]);
    vi.advanceTimersByTime(200);
    selectThread(editor.view, "t1");
    selectThread(editor.view, null);
    setThreads(editor.view, []);
    vi.advanceTimersByTime(200);

    expect(updates).toBe(0);
  });
});
