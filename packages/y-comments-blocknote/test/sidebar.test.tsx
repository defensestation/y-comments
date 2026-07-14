import { DefaultThreadStoreAuth, InMemoryThreadStore } from "@defensestation/y-comments-core";
import { anchorFromRange, yCommentsPluginKey } from "@defensestation/y-comments-prosemirror";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { CommentsProvider, ThreadsSidebar } from "../src/index.js";
import { createCollabEditor, rangeOf, testResolveUsers, type TestEditorHandle } from "./helpers.js";

let handle: TestEditorHandle;

afterEach(() => {
  cleanup();
  handle?.destroy();
});

async function seedThread(store: InMemoryThreadStore, docId: string, text: string, body: string) {
  const state = handle.editor.prosemirrorState;
  const { from, to } = rangeOf(handle.editor.prosemirrorView, text);
  const anchor = anchorFromRange(state, from, to);
  return store.createThread({ docId, anchor, body: { text: body } });
}

describe("ThreadsSidebar", () => {
  it("orders threads by document position and groups outdated last with quotes", async () => {
    handle = await createCollabEditor([
      "alpha paragraph first",
      "beta paragraph second",
      "gamma paragraph third",
    ]);
    const store = new InMemoryThreadStore({ userId: "alice" });

    render(
      <CommentsProvider editor={handle.editor} store={store} docId="doc1" resolveUsers={testResolveUsers}>
        <ThreadsSidebar />
      </CommentsProvider>
    );
    await waitFor(() => {
      expect(yCommentsPluginKey.getState(handle.editor.prosemirrorState)).toBeDefined();
    });

    // created deliberately out of document order
    await seedThread(store, "doc1", "gamma", "comment on gamma");
    await seedThread(store, "doc1", "alpha", "comment on alpha");
    const orphan = await seedThread(store, "doc1", "beta paragraph", "comment on beta");

    // delete beta's text so its thread orphans (block survives → container)
    const view = handle.editor.prosemirrorView;
    const beta = rangeOf(view, "beta paragraph second");
    view.dispatch(view.state.tr.delete(beta.from, beta.to));

    await waitFor(() => {
      const cards = document.querySelectorAll("[data-thread-card]");
      expect(cards).toHaveLength(3);
      // positioned threads in document order first, outdated last
      const bodies = [...cards].map((c) => c.textContent ?? "");
      expect(bodies[0]).toContain("comment on alpha");
      expect(bodies[1]).toContain("comment on gamma");
      expect(bodies[2]).toContain("comment on beta");
    });

    expect(screen.getByText("Outdated")).toBeDefined();
    const orphanCard = document.querySelector(`[data-thread-card="${orphan.id}"]`)!;
    expect(within(orphanCard as HTMLElement).getByText("beta paragraph")).toBeDefined();
  });

  it("filters resolved threads and shows them under the Resolved filter", async () => {
    handle = await createCollabEditor(["alpha paragraph", "beta paragraph"]);
    const store = new InMemoryThreadStore({ userId: "alice" });

    render(
      <CommentsProvider editor={handle.editor} store={store} docId="doc1" resolveUsers={testResolveUsers}>
        <ThreadsSidebar />
      </CommentsProvider>
    );
    await waitFor(() => {
      expect(yCommentsPluginKey.getState(handle.editor.prosemirrorState)).toBeDefined();
    });

    await seedThread(store, "doc1", "alpha", "open one");
    const resolved = await seedThread(store, "doc1", "beta", "resolved one");
    await store.resolveThread({ threadId: resolved.id });

    await waitFor(() => {
      expect(screen.getByText("open one")).toBeDefined();
      expect(screen.queryByText("resolved one")).toBeNull();
    });

    screen.getByRole("tab", { name: "Resolved" }).click();
    await waitFor(() => {
      expect(screen.getByText("resolved one")).toBeDefined();
      expect(screen.queryByText("open one")).toBeNull();
    });

    screen.getByRole("tab", { name: "All" }).click();
    await waitFor(() => {
      expect(screen.getByText("resolved one")).toBeDefined();
      expect(screen.getByText("open one")).toBeDefined();
    });
  });

  it("shows an error and keeps the draft when a reply fails", async () => {
    handle = await createCollabEditor(["alpha paragraph"]);
    const store = new InMemoryThreadStore({ userId: "alice" });
    const failingStore = new Proxy(store, {
      get(target, prop, receiver) {
        if (prop === "addComment") {
          return async () => {
            throw new Error("boom");
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    render(
      <CommentsProvider
        editor={handle.editor}
        store={failingStore}
        docId="doc1"
        resolveUsers={testResolveUsers}
      >
        <ThreadsSidebar />
      </CommentsProvider>
    );
    await waitFor(() => {
      expect(yCommentsPluginKey.getState(handle.editor.prosemirrorState)).toBeDefined();
    });
    await seedThread(store, "doc1", "alpha", "root comment");
    await waitFor(() => expect(screen.getByText("root comment")).toBeDefined());

    const textarea = screen.getByPlaceholderText("Reply…") as HTMLTextAreaElement;
    textarea.focus();
    // controlled input: drive through the change event
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.change(textarea, { target: { value: "my reply" } });
    fireEvent.submit(textarea.closest("form")!);

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("Sending the reply failed");
    });
    // the draft survives so the user can retry
    expect((screen.getByPlaceholderText("Reply…") as HTMLTextAreaElement).value).toBe("my reply");
  });

  it("edits a comment (Enter saves, Escape cancels) and deletes comments", async () => {
    handle = await createCollabEditor(["alpha paragraph"]);
    const store = new InMemoryThreadStore({ userId: "alice" });
    const user = userEvent.setup();

    render(
      <CommentsProvider editor={handle.editor} store={store} docId="doc1" resolveUsers={testResolveUsers}>
        <ThreadsSidebar />
      </CommentsProvider>
    );
    await waitFor(() => {
      expect(yCommentsPluginKey.getState(handle.editor.prosemirrorState)).toBeDefined();
    });
    const thread = await seedThread(store, "doc1", "alpha", "first version");
    await store.addComment({ threadId: thread.id, body: { text: "second comment" } });
    await waitFor(() => expect(screen.getByText("second comment")).toBeDefined());

    // Escape cancels without saving
    await user.click(screen.getAllByLabelText("Edit comment")[0]);
    let editBox = screen.getByDisplayValue("first version");
    fireEvent.change(editBox, { target: { value: "discarded" } });
    fireEvent.keyDown(editBox, { key: "Escape" });
    expect(screen.getByText("first version")).toBeDefined();
    expect((await store.getThreads("doc1"))[0].comments[0].body.text).toBe("first version");

    // Enter saves and marks the comment edited
    await user.click(screen.getAllByLabelText("Edit comment")[0]);
    editBox = screen.getByDisplayValue("first version");
    fireEvent.change(editBox, { target: { value: "second version" } });
    fireEvent.keyDown(editBox, { key: "Enter" });
    await waitFor(() => expect(screen.getByText("second version")).toBeDefined());
    expect(screen.getByText(/\(edited\)/)).toBeDefined();

    // delete one comment; the thread survives with the other
    await user.click(screen.getAllByLabelText("Delete comment")[1]);
    await waitFor(() => expect(screen.queryByText("second comment")).toBeNull());
    expect((await store.getThreads("doc1"))[0].comments).toHaveLength(1);
  });

  it("resolves, reopens and deletes threads from the header actions", async () => {
    handle = await createCollabEditor(["alpha paragraph"]);
    const store = new InMemoryThreadStore({ userId: "alice" });
    const user = userEvent.setup();

    render(
      <CommentsProvider editor={handle.editor} store={store} docId="doc1" resolveUsers={testResolveUsers}>
        <ThreadsSidebar defaultFilter="all" />
      </CommentsProvider>
    );
    await waitFor(() => {
      expect(yCommentsPluginKey.getState(handle.editor.prosemirrorState)).toBeDefined();
    });
    await seedThread(store, "doc1", "alpha", "lifecycle comment");
    await waitFor(() => expect(screen.getByText("lifecycle comment")).toBeDefined());

    await user.click(screen.getByLabelText("Resolve thread"));
    // the badge, as opposed to the "Resolved" filter tab
    await waitFor(() => expect(document.querySelector(".y-comments-badge-resolved")).not.toBeNull());
    expect((await store.getThreads("doc1"))[0].resolved).toBe(true);

    await user.click(screen.getByLabelText("Reopen thread"));
    await waitFor(() => expect(screen.queryByLabelText("Reopen thread")).toBeNull());
    expect((await store.getThreads("doc1"))[0].resolved).toBe(false);

    await user.click(screen.getByLabelText("Delete thread"));
    await waitFor(() => expect(screen.getByText("No comments")).toBeDefined());
    expect(await store.getThreads("doc1")).toHaveLength(0);
  });

  it("adds and removes reactions; the picker closes on outside pointer-down", async () => {
    handle = await createCollabEditor(["alpha paragraph"]);
    const store = new InMemoryThreadStore({ userId: "alice" });
    const user = userEvent.setup();

    render(
      <CommentsProvider editor={handle.editor} store={store} docId="doc1" resolveUsers={testResolveUsers}>
        <ThreadsSidebar />
      </CommentsProvider>
    );
    await waitFor(() => {
      expect(yCommentsPluginKey.getState(handle.editor.prosemirrorState)).toBeDefined();
    });
    const thread = await seedThread(store, "doc1", "alpha", "react to me");
    await waitFor(() => expect(screen.getByText("react to me")).toBeDefined());

    // outside pointer-down closes the palette without reacting
    await user.click(screen.getByLabelText("Add reaction"));
    expect(screen.getByRole("menu")).toBeDefined();
    fireEvent.mouseDown(document.body);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

    // pick an emoji → chip appears with a count
    await user.click(screen.getByLabelText("Add reaction"));
    await user.click(within(screen.getByRole("menu")).getByText("👍"));
    await waitFor(() => expect(screen.getByText(/👍\s*1/)).toBeDefined());
    let [stored] = await store.getThreads("doc1");
    expect(stored.comments[0].reactions).toEqual([{ emoji: "👍", userIds: ["alice"] }]);
    expect(stored.id).toBe(thread.id);

    // clicking your own chip removes the reaction
    await user.click(screen.getByText(/👍\s*1/));
    await waitFor(() => expect(screen.queryByText(/👍\s*1/)).toBeNull());
    [stored] = await store.getThreads("doc1");
    expect(stored.comments[0].reactions).toEqual([]);
  });

  it("does not re-select the thread when interacting with controls inside a card", async () => {
    handle = await createCollabEditor(["alpha paragraph", "beta paragraph"]);
    const store = new InMemoryThreadStore({ userId: "alice" });
    const user = userEvent.setup();

    render(
      <CommentsProvider editor={handle.editor} store={store} docId="doc1" resolveUsers={testResolveUsers}>
        <ThreadsSidebar />
      </CommentsProvider>
    );
    await waitFor(() => {
      expect(yCommentsPluginKey.getState(handle.editor.prosemirrorState)).toBeDefined();
    });
    const thread = await seedThread(store, "doc1", "alpha", "guard me");
    await waitFor(() => expect(screen.getByText("guard me")).toBeDefined());
    const card = () => document.querySelector(`[data-thread-card="${thread.id}"]`)!;

    // typing a reply (including Enter) must not select the card...
    const replyBox = screen.getByPlaceholderText("Reply…");
    await user.type(replyBox, "a reply{Enter}");
    await waitFor(async () => {
      expect((await store.getThreads("doc1"))[0].comments).toHaveLength(2);
    });
    expect(card().className).not.toContain("y-comments-card-selected");

    // ...but clicking the card body does
    await user.click(within(card() as HTMLElement).getByText("guard me"));
    await waitFor(() => expect(card().className).toContain("y-comments-card-selected"));
  });

  it("gates actions by ThreadStoreAuth", async () => {
    handle = await createCollabEditor(["alpha paragraph"]);
    // writes attributed to alice, but UI affordances evaluated for bob (commenter)
    const store = new InMemoryThreadStore({
      userId: "alice",
      auth: new DefaultThreadStoreAuth("bob", "commenter"),
    });

    render(
      <CommentsProvider editor={handle.editor} store={store} docId="doc1" resolveUsers={testResolveUsers}>
        <ThreadsSidebar />
      </CommentsProvider>
    );
    await waitFor(() => {
      expect(yCommentsPluginKey.getState(handle.editor.prosemirrorState)).toBeDefined();
    });
    await seedThread(store, "doc1", "alpha", "alice's comment");

    await waitFor(() => expect(screen.getByText("alice's comment")).toBeDefined());
    // bob (commenter) may not edit/delete alice's comment nor resolve her thread
    expect(screen.queryByLabelText("Edit comment")).toBeNull();
    expect(screen.queryByLabelText("Delete comment")).toBeNull();
    expect(screen.queryByLabelText("Resolve thread")).toBeNull();
    expect(screen.queryByLabelText("Delete thread")).toBeNull();
    // but may reply and react
    expect(screen.getByPlaceholderText("Reply…")).toBeDefined();
    expect(screen.getByLabelText("Add reaction")).toBeDefined();
  });
});
