import {
  anchorToDTO,
  InMemoryThreadStore,
  threadFromDTO,
  type ThreadDTO,
} from "@defensestation/y-comments-core";
import {
  anchorFromRange,
  yCommentsPluginKey,
} from "@defensestation/y-comments-prosemirror";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import {
  CommentsProvider,
  FloatingComposer,
  useComments,
  type CommentsContextValue,
} from "../src/index.js";
import {
  createCollabEditor,
  rangeOf,
  selectText,
  testResolveUsers,
  type TestEditorHandle,
} from "./helpers.js";

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

describe("CommentsProvider", () => {
  it("installs the plugin and turns store threads into decorations", async () => {
    handle = await createCollabEditor(["The quick brown fox", "Second paragraph"]);
    const store = new InMemoryThreadStore({ userId: "alice" });

    render(
      <CommentsProvider editor={handle.editor} store={store} docId="doc1" resolveUsers={testResolveUsers}>
        <CaptureContext />
      </CommentsProvider>
    );

    await waitFor(() => {
      expect(yCommentsPluginKey.getState(handle.editor.prosemirrorState)).toBeDefined();
    });

    const { from, to } = selectText(handle.editor, "brown fox");
    const anchor = anchorFromRange(handle.editor.prosemirrorState, from, to);
    await store.createThread({ docId: "doc1", anchor, body: { text: "note" } });

    await waitFor(() => {
      const span = handle.editor.prosemirrorView.dom.querySelector("[data-thread-id]");
      expect(span?.textContent).toBe("brown fox");
    });
    expect(ctx.threads).toHaveLength(1);
    await waitFor(() => expect(ctx.resolutions.get(ctx.threads[0].id)?.kind).toBe("exact"));
  });

  it("composer flow creates an anchored thread with zero Yjs document updates", async () => {
    handle = await createCollabEditor(["The quick brown fox jumps over the lazy dog"]);
    const store = new InMemoryThreadStore({ userId: "alice" });
    const user = userEvent.setup();

    render(
      <CommentsProvider editor={handle.editor} store={store} docId="doc1" resolveUsers={testResolveUsers}>
        <CaptureContext />
        <FloatingComposer />
      </CommentsProvider>
    );
    await waitFor(() => {
      expect(yCommentsPluginKey.getState(handle.editor.prosemirrorState)).toBeDefined();
    });

    let updates = 0;
    handle.ydoc.on("update", () => updates++);

    selectText(handle.editor, "brown fox");
    ctx.openComposer();

    const input = await screen.findByPlaceholderText("Add a comment…");
    await user.type(input, "does this track edits?");
    await user.click(screen.getByRole("button", { name: "Comment" }));

    await waitFor(async () => {
      expect(await store.getThreads("doc1")).toHaveLength(1);
    });
    const [thread] = await store.getThreads("doc1");
    expect(thread.anchor.quotedText).toBe("brown fox");
    expect(thread.anchor.prefix).toBe("The quick ");
    expect(thread.comments[0].body.text).toBe("does this track edits?");
    expect(thread.comments[0].userId).toBe("alice");

    // the composer must close and the new thread become selected
    expect(screen.queryByPlaceholderText("Add a comment…")).toBeNull();
    await waitFor(() => expect(ctx.selectedThreadId).toBe(thread.id));

    // acceptance criterion #1: comment flows produce zero Yjs updates
    expect(updates).toBe(0);
  });

  it("focuses the composer textarea when it opens and submits on Enter", async () => {
    handle = await createCollabEditor(["The quick brown fox jumps over the lazy dog"]);
    const store = new InMemoryThreadStore({ userId: "alice" });
    const user = userEvent.setup();

    render(
      <CommentsProvider editor={handle.editor} store={store} docId="doc1" resolveUsers={testResolveUsers}>
        <CaptureContext />
        <FloatingComposer />
      </CommentsProvider>
    );
    await waitFor(() => {
      expect(yCommentsPluginKey.getState(handle.editor.prosemirrorState)).toBeDefined();
    });

    selectText(handle.editor, "brown fox");
    ctx.openComposer();

    // the textarea must receive focus once the popover is positioned
    const input = await screen.findByPlaceholderText("Add a comment…");
    await waitFor(() => expect(document.activeElement).toBe(input));

    // Enter submits; Shift+Enter would insert a newline instead
    await user.type(input, "quick note{Enter}");
    await waitFor(async () => {
      expect(await store.getThreads("doc1")).toHaveLength(1);
    });
    const [thread] = await store.getThreads("doc1");
    expect(thread.comments[0].body.text).toBe("quick note");
    expect(screen.queryByPlaceholderText("Add a comment…")).toBeNull();
  });

  it("keeps the highlight while the document is edited after commenting (server-shaped anchor)", async () => {
    handle = await createCollabEditor(["The quick brown fox jumps over the lazy dog"]);
    const store = new InMemoryThreadStore({ userId: "alice" });

    render(
      <CommentsProvider editor={handle.editor} store={store} docId="doc1" resolveUsers={testResolveUsers}>
        <CaptureContext />
      </CommentsProvider>
    );
    await waitFor(() => {
      expect(yCommentsPluginKey.getState(handle.editor.prosemirrorState)).toBeDefined();
    });

    // Round-trip the anchor through JSON exactly like the REST server
    // stores it, so this covers the persistence path too.
    const { from, to } = selectText(handle.editor, "brown fox");
    const anchor = anchorFromRange(handle.editor.prosemirrorState, from, to);
    const dto = JSON.parse(
      JSON.stringify({
        id: "t-roundtrip",
        docId: "doc1",
        anchor: anchorToDTO(anchor),
        comments: [],
        resolved: false,
        createdAt: new Date().toISOString(),
      })
    ) as ThreadDTO;
    await store.createThread({
      docId: "doc1",
      anchor: threadFromDTO(dto).anchor,
      body: { text: "watch me survive edits" },
    });

    const highlighted = () =>
      handle.editor.prosemirrorView.dom.querySelector("[data-thread-id]")?.textContent ?? null;
    await waitFor(() => expect(highlighted()).toBe("brown fox"));

    // Edit before, inside and after the range, letting the debounce settle
    // in between — the flow a user reported as losing the highlight.
    const view = handle.editor.prosemirrorView;
    const type = (text: string, at: number) =>
      view.dispatch(view.state.tr.insertText(text, at));

    type("Hello ", from); // before
    expect(highlighted()).toBe("brown fox"); // instant mapping, pre-debounce
    await waitFor(() => {
      expect(ctx.resolutions.get(ctx.threads[0].id)?.kind).toBe("exact");
      expect(highlighted()).toBe("brown fox");
    });

    const inside = rangeOf(view, "brown").to;
    type("ish", inside); // inside the range
    await waitFor(() => expect(highlighted()).toBe("brownish fox"));

    const end = view.state.doc.content.size - 1;
    type(" The end.", end); // after
    await waitFor(() => {
      expect(highlighted()).toBe("brownish fox");
      expect(ctx.resolutions.get(ctx.threads[0].id)?.kind).toBe("exact");
    });

    // still selectable + resolvable: the thread is intact in the store
    const [thread] = await store.getThreads("doc1");
    await store.resolveThread({ threadId: thread.id });
    const [resolved] = await store.getThreads("doc1");
    expect(resolved.resolved).toBe(true);
  });

  it("keeps the highlight when Enter splits the block before the comment", async () => {
    handle = await createCollabEditor(["The quick brown fox jumps over the lazy dog"]);
    const store = new InMemoryThreadStore({ userId: "alice" });

    render(
      <CommentsProvider editor={handle.editor} store={store} docId="doc1" resolveUsers={testResolveUsers}>
        <CaptureContext />
      </CommentsProvider>
    );
    await waitFor(() => {
      expect(yCommentsPluginKey.getState(handle.editor.prosemirrorState)).toBeDefined();
    });

    const { from, to } = selectText(handle.editor, "brown fox");
    const anchor = anchorFromRange(handle.editor.prosemirrorState, from, to);
    const thread = await store.createThread({ docId: "doc1", anchor, body: { text: "split me" } });

    const highlighted = () =>
      handle.editor.prosemirrorView.dom.querySelector("[data-thread-id]")?.textContent ?? null;
    await waitFor(() => expect(highlighted()).toBe("brown fox"));

    // Enter before "brown": split paragraph + blockContainer, and give the
    // second half a fresh block id like BlockNote's unique-id plugin does.
    const view = handle.editor.prosemirrorView;
    view.dispatch(view.state.tr.split(from, 2));
    let newContainerPos = -1;
    view.state.doc.descendants((node, pos) => {
      if (node.type.name === "blockContainer") {
        newContainerPos = pos; // last one wins — the split-off block
      }
      return true;
    });
    const container = view.state.doc.nodeAt(newContainerPos)!;
    view.dispatch(
      view.state.tr.setNodeMarkup(newContainerPos, undefined, {
        ...container.attrs,
        id: "fresh-block-id",
      })
    );

    await waitFor(() => {
      const kind = ctx.resolutions.get(thread.id)?.kind;
      expect(kind === "exact" || kind === "reanchored").toBe(true);
      expect(highlighted()).toBe("brown fox");
    });
  });

  it("restores the highlight when deleted commented text comes back (undo)", async () => {
    handle = await createCollabEditor(["The quick brown fox jumps"]);
    const store = new InMemoryThreadStore({ userId: "alice" });

    render(
      <CommentsProvider editor={handle.editor} store={store} docId="doc1" resolveUsers={testResolveUsers}>
        <CaptureContext />
      </CommentsProvider>
    );
    await waitFor(() => {
      expect(yCommentsPluginKey.getState(handle.editor.prosemirrorState)).toBeDefined();
    });

    const { from, to } = selectText(handle.editor, "brown fox");
    const anchor = anchorFromRange(handle.editor.prosemirrorState, from, to);
    const thread = await store.createThread({ docId: "doc1", anchor, body: { text: "come back" } });

    const highlighted = () =>
      handle.editor.prosemirrorView.dom.querySelector("[data-thread-id]")?.textContent ?? null;
    await waitFor(() => expect(highlighted()).toBe("brown fox"));

    const view = handle.editor.prosemirrorView;
    view.dispatch(view.state.tr.delete(from, to));
    await waitFor(() => {
      const kind = ctx.resolutions.get(thread.id)?.kind;
      expect(kind === "container" || kind === "orphaned").toBe(true);
    });

    // Undo re-inserts the text as new Yjs items (the originals are
    // tombstones), which is exactly what re-inserting does — the relative
    // positions are dead either way and only the quote fallback can recover.
    view.dispatch(view.state.tr.insertText("brown fox", from));
    await waitFor(() => {
      const kind = ctx.resolutions.get(thread.id)?.kind;
      expect(kind === "exact" || kind === "reanchored").toBe(true);
      expect(highlighted()).toBe("brown fox");
    });
  });

  it("keeps threads when the commented text is deleted (no data loss)", async () => {
    handle = await createCollabEditor(["The quick brown fox jumps"]);
    const store = new InMemoryThreadStore({ userId: "alice" });

    render(
      <CommentsProvider editor={handle.editor} store={store} docId="doc1" resolveUsers={testResolveUsers}>
        <CaptureContext />
      </CommentsProvider>
    );
    await waitFor(() => {
      expect(yCommentsPluginKey.getState(handle.editor.prosemirrorState)).toBeDefined();
    });

    const { from, to } = selectText(handle.editor, "brown fox");
    const anchor = anchorFromRange(handle.editor.prosemirrorState, from, to);
    const thread = await store.createThread({ docId: "doc1", anchor, body: { text: "gone soon" } });

    await waitFor(() => {
      expect(handle.editor.prosemirrorView.dom.querySelector("[data-thread-id]")).not.toBeNull();
    });

    const view = handle.editor.prosemirrorView;
    view.dispatch(view.state.tr.delete(from, to));

    await waitFor(() => {
      const kind = ctx.resolutions.get(thread.id)?.kind;
      expect(kind === "container" || kind === "orphaned").toBe(true);
    });
    expect(ctx.threads).toHaveLength(1);
    expect(ctx.threads[0].anchor.quotedText).toBe("brown fox");
  });
});
