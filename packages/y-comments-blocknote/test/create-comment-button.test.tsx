import { ComponentsContext } from "@blocknote/react";
import type { Components } from "@blocknote/react";
import { DefaultThreadStoreAuth, InMemoryThreadStore } from "@defensestation/y-comments-core";
import { yCommentsPluginKey } from "@defensestation/y-comments-prosemirror";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TextSelection } from "prosemirror-state";
import { forwardRef, type ComponentProps, type ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  CommentsProvider,
  CreateCommentButton,
  FloatingComposer,
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

// Minimal stand-in for a BlockNote UI kit: just enough for
// FormattingToolbar.Button, which is all CreateCommentButton renders.
const TestButton = forwardRef<HTMLButtonElement, ComponentProps<"button"> & { label?: string; isDisabled?: boolean }>(
  ({ label, isDisabled, onClick }, ref) => (
    <button ref={ref} aria-label={label} disabled={isDisabled} onClick={onClick}>
      {label}
    </button>
  )
);
const testComponents = {
  FormattingToolbar: { Button: TestButton },
} as unknown as Components;

async function setup(children: ReactNode, auth?: DefaultThreadStoreAuth) {
  handle = await createCollabEditor(["The quick brown fox jumps over the lazy dog"]);
  const store = new InMemoryThreadStore({ userId: "alice", auth });

  render(
    <CommentsProvider editor={handle.editor} store={store} docId="doc1" resolveUsers={testResolveUsers}>
      <ComponentsContext.Provider value={testComponents}>
        <CaptureContext />
        {children}
      </ComponentsContext.Provider>
    </CommentsProvider>
  );
  await waitFor(() => {
    expect(yCommentsPluginKey.getState(handle.editor.prosemirrorState)).toBeDefined();
  });
  return store;
}

const button = () => screen.getByLabelText("Add comment") as HTMLButtonElement;

describe("CreateCommentButton", () => {
  it("is disabled without a selection and enables when text is selected", async () => {
    await setup(<CreateCommentButton />);
    expect(button().disabled).toBe(true);

    const { from } = selectText(handle.editor, "brown fox");
    await waitFor(() => expect(button().disabled).toBe(false));

    // collapse the selection again — the button must follow
    const view = handle.editor.prosemirrorView;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from)));
    await waitFor(() => expect(button().disabled).toBe(true));
  });

  it("stays disabled when auth denies thread creation", async () => {
    class NoCreateAuth extends DefaultThreadStoreAuth {
      override canCreateThread(): boolean {
        return false;
      }
    }
    await setup(<CreateCommentButton />, new NoCreateAuth("alice", "editor"));

    selectText(handle.editor, "brown fox");
    // selection exists, but auth still forbids creating a thread
    await new Promise((r) => setTimeout(r, 20));
    expect(button().disabled).toBe(true);
  });

  it("opens the composer over the captured selection on click", async () => {
    await setup(
      <>
        <CreateCommentButton />
        <FloatingComposer />
      </>
    );
    const user = userEvent.setup();

    const range = selectText(handle.editor, "brown fox");
    await waitFor(() => expect(button().disabled).toBe(false));

    await user.click(button());
    expect(ctx.composer).toEqual({ from: range.from, to: range.to });
    const input = await screen.findByPlaceholderText("Add a comment…");
    await waitFor(() => expect(document.activeElement).toBe(input));
  });
});
