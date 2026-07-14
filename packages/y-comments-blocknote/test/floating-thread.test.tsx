import { InMemoryThreadStore } from "@defensestation/y-comments-core";
import { anchorFromRange, yCommentsPluginKey } from "@defensestation/y-comments-prosemirror";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import {
  CommentsProvider,
  FloatingThread,
  useComments,
  type CommentsContextValue,
} from "../src/index.js";
import { createCollabEditor, selectText, testResolveUsers, type TestEditorHandle } from "./helpers.js";

let handle: TestEditorHandle;
let ctx: CommentsContextValue;

function CaptureContext() {
  ctx = useComments();
  return null;
}

afterEach(() => {
  cleanup();
  handle?.destroy();
});

const popover = () => document.querySelector("[data-y-comments-floating-thread]");

async function setup(body = "root comment") {
  handle = await createCollabEditor(["The quick brown fox jumps over the lazy dog"]);
  const store = new InMemoryThreadStore({ userId: "alice" });

  render(
    <CommentsProvider editor={handle.editor} store={store} docId="doc1" resolveUsers={testResolveUsers}>
      <CaptureContext />
      <FloatingThread />
    </CommentsProvider>
  );
  await waitFor(() => {
    expect(yCommentsPluginKey.getState(handle.editor.prosemirrorState)).toBeDefined();
  });

  const { from, to } = selectText(handle.editor, "brown fox");
  const anchor = anchorFromRange(handle.editor.prosemirrorState, from, to);
  const thread = await store.createThread({ docId: "doc1", anchor, body: { text: body } });
  await waitFor(() => {
    expect(handle.editor.prosemirrorView.dom.querySelector("[data-thread-id]")).not.toBeNull();
  });
  return { store, thread };
}

describe("FloatingThread", () => {
  it("opens on thread selection, anchored to the highlight, and shows the comments", async () => {
    const { thread } = await setup();
    expect(popover()).toBeNull();

    ctx.selectThread(thread.id);
    await waitFor(() => expect(popover()).not.toBeNull());
    expect(screen.getByText("root comment")).toBeDefined();

    ctx.selectThread(null);
    await waitFor(() => expect(popover()).toBeNull());
  });

  it("survives decoration rebuilds (spans replaced) while the document is edited", async () => {
    const { thread } = await setup();
    ctx.selectThread(thread.id);
    await waitFor(() => expect(popover()).not.toBeNull());

    // typing rebuilds the decoration spans; the popover must re-query the
    // new span rather than hold the detached one (the 0,0-corner bug)
    const view = handle.editor.prosemirrorView;
    view.dispatch(view.state.tr.insertText("Hello ", 3));
    await waitFor(() => {
      const kind = ctx.resolutions.get(thread.id)?.kind;
      expect(kind === "exact" || kind === "reanchored").toBe(true);
    });
    expect(popover()).not.toBeNull();
    expect(screen.getByText("root comment")).toBeDefined();
  });

  it("dismisses on Escape and on outside pointer-down, but not on inside clicks", async () => {
    const { thread } = await setup();

    ctx.selectThread(thread.id);
    await waitFor(() => expect(popover()).not.toBeNull());
    fireEvent.mouseDown(popover()!);
    expect(popover()).not.toBeNull();

    fireEvent.mouseDown(document.body);
    await waitFor(() => expect(popover()).toBeNull());
    expect(ctx.selectedThreadId).toBeNull();

    ctx.selectThread(thread.id);
    await waitFor(() => expect(popover()).not.toBeNull());
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => expect(popover()).toBeNull());
  });

  it("does not render for resolved threads", async () => {
    const { store, thread } = await setup();
    await store.resolveThread({ threadId: thread.id });
    await waitFor(() => expect(ctx.threads[0]?.resolved).toBe(true));

    ctx.selectThread(thread.id);
    // give positioning a beat — the popover must still refuse to render
    await new Promise((r) => setTimeout(r, 50));
    expect(popover()).toBeNull();
  });

  it("Escape while editing a comment cancels the edit without closing the popover", async () => {
    const { thread } = await setup();
    const user = userEvent.setup();

    ctx.selectThread(thread.id);
    await waitFor(() => expect(popover()).not.toBeNull());

    await user.click(screen.getByLabelText("Edit comment"));
    const editBox = screen.getByDisplayValue("root comment");
    fireEvent.keyDown(editBox, { key: "Escape" });

    expect(screen.queryByDisplayValue("root comment")).toBeNull(); // edit form gone
    expect(popover()).not.toBeNull(); // popover stayed open
    expect(screen.getByText("root comment")).toBeDefined();
  });

  it("replies from the popover, submitting with Enter", async () => {
    const { store, thread } = await setup();
    const user = userEvent.setup();

    ctx.selectThread(thread.id);
    await waitFor(() => expect(popover()).not.toBeNull());

    await user.type(screen.getByPlaceholderText("Reply…"), "a reply{Enter}");
    await waitFor(async () => {
      const [t] = await store.getThreads("doc1");
      expect(t.comments).toHaveLength(2);
    });
    const [t] = await store.getThreads("doc1");
    expect(t.id).toBe(thread.id);
    expect(t.comments[1].body.text).toBe("a reply");
    // the draft cleared and the thread re-rendered with the new comment
    await waitFor(() => expect(screen.getByText("a reply")).toBeDefined());
    expect((screen.getByPlaceholderText("Reply…") as HTMLTextAreaElement).value).toBe("");
  });
});
