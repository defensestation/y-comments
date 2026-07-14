import "@blocknote/core/fonts/inter.css";
import { BlockNoteView } from "@blocknote/mantine";
import "@blocknote/mantine/style.css";
import {
  FormattingToolbar,
  FormattingToolbarController,
  getFormattingToolbarItems,
  useCreateBlockNote,
} from "@blocknote/react";
import {
  CommentsProvider,
  CreateCommentButton,
  DefaultThreadStoreAuth,
  FloatingComposer,
  FloatingThread,
  InMemoryThreadStore,
  RestThreadStore,
  ThreadsSidebar,
  type ThreadStore,
  type User,
} from "@defensestation/y-comments-blocknote";
import "@defensestation/y-comments-blocknote/style.css";
import { useEffect, useMemo, useState } from "react";
import * as Y from "yjs";
import { connectLocalTabs } from "./sync.js";

const DOC_ID = "demo-doc";

// Pick an identity per tab: http://localhost:5173/?user=bob
// alice acts as an editor (may resolve/delete anything), everyone else as a
// commenter (may only touch their own comments) — exercises the auth gates.
const ME = new URLSearchParams(window.location.search).get("user") ?? "alice";
const ROLE = ME === "alice" ? ("editor" as const) : ("commenter" as const);

const KNOWN_USERS: Record<string, User> = {
  alice: { id: "alice", username: "Alice (editor)", avatarUrl: "https://i.pravatar.cc/40?u=alice" },
  bob: { id: "bob", username: "Bob", avatarUrl: "https://i.pravatar.cc/40?u=bob" },
};
const resolveUsers = async (ids: string[]) =>
  ids.map((id) => KNOWN_USERS[id] ?? { id, username: id });

/**
 * Store selection:
 * - default: RestThreadStore against the Go+SQLite server (example/server),
 *   reached through vite's /api proxy — threads persist across reloads and
 *   sync between tabs via polling.
 * - `VITE_COMMENTS_API=memory npm run dev`: in-memory, no server needed.
 * - any other VITE_COMMENTS_API value is used as the API base URL directly.
 */
function createStore(handlers: { onDown: () => void; onUp: () => void }): ThreadStore {
  const auth = new DefaultThreadStoreAuth(ME, ROLE);
  const api = (import.meta.env.VITE_COMMENTS_API as string | undefined) ?? "/api";
  if (api === "memory") {
    return new InMemoryThreadStore({ userId: ME, auth });
  }
  return new RestThreadStore({
    baseUrl: api,
    auth,
    headers: { "X-User-Id": ME },
    pollIntervalMs: 2000,
    onSubscribeError: handlers.onDown,
    onSubscribeRecover: handlers.onUp,
  });
}

export function App() {
  const ydoc = useMemo(() => new Y.Doc(), []);
  const [apiDown, setApiDown] = useState(false);
  const store = useMemo(
    () => createStore({ onDown: () => setApiDown(true), onUp: () => setApiDown(false) }),
    []
  );

  const editor = useCreateBlockNote({
    collaboration: {
      fragment: ydoc.getXmlFragment("document-store"),
      user: { name: KNOWN_USERS[ME]?.username ?? ME, color: ME === "alice" ? "#e91e63" : "#2196f3" },
    },
  });

  // Cross-tab collaboration without a network provider, and demo content
  // seeded only if no other tab supplied state first.
  useEffect(() => {
    const disconnect = connectLocalTabs(ydoc, `y-comments-demo:${DOC_ID}`);
    const seedTimer = setTimeout(() => {
      const blocks = editor.document;
      const empty =
        blocks.length === 1 &&
        Array.isArray(blocks[0].content) &&
        blocks[0].content.length === 0;
      if (empty) {
        editor.replaceBlocks(blocks, [
          { type: "heading", content: "Decoration-anchored comments" },
          {
            type: "paragraph",
            content:
              "Select some text and use the comment button in the formatting toolbar to start a thread. " +
              "Comments live in an external store — the document itself is never modified.",
          },
          {
            type: "paragraph",
            content:
              "Try editing around a highlight: anchors are Yjs relative positions, so they follow the text. " +
              "Delete a commented range entirely and the thread survives in the sidebar as Outdated.",
          },
          {
            type: "paragraph",
            content:
              "Open a second tab as another user (append ?user=bob to the URL) to test replies, " +
              "reactions and permission gating against the Go server.",
          },
        ]);
      }
    }, 400);
    return () => {
      clearTimeout(seedTimer);
      disconnect();
    };
  }, [editor, ydoc]);

  return (
    // selfHeal: after a quote-search re-anchor (e.g. a block split moved the
    // text), persist a fresh anchor so the thread returns to exact tracking —
    // without it, later copies of the same text can make the quote ambiguous
    // and outdate the thread.
    <CommentsProvider editor={editor} store={store} docId={DOC_ID} resolveUsers={resolveUsers} selfHeal>
      <div style={{ maxWidth: 1200, margin: "24px auto", padding: "0 16px" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 16 }}>
          <h3 style={{ margin: 0, fontFamily: "Inter, sans-serif" }}>y-comments demo</h3>
          <span style={{ fontFamily: "Inter, sans-serif", fontSize: 13, opacity: 0.7 }}>
            you are <b>{KNOWN_USERS[ME]?.username ?? ME}</b> · switch with ?user=bob
          </span>
        </div>
        {apiDown && (
          <div
            role="alert"
            style={{
              fontFamily: "Inter, sans-serif",
              fontSize: 13,
              padding: "8px 12px",
              marginBottom: 12,
              borderRadius: 6,
              background: "#fdecea",
              color: "#b3261e",
              border: "1px solid #f5c6c2",
            }}
          >
            ⚠ Comments server unreachable — showing the last known threads, retrying in the
            background. Start it with <code>npm run server</code>.
          </div>
        )}
        <div style={{ display: "flex", gap: 24 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            {/* theme pinned so the demo doesn't follow the OS; pair theme="dark"
                with data-y-comments-theme="dark" on a wrapper to go dark */}
            <BlockNoteView editor={editor} theme="light" formattingToolbar={false}>
              <FormattingToolbarController
                formattingToolbar={() => (
                  <FormattingToolbar>
                    {...getFormattingToolbarItems()}
                    <CreateCommentButton key="createCommentButton" />
                  </FormattingToolbar>
                )}
              />
            </BlockNoteView>
            <FloatingComposer />
            <FloatingThread />
          </div>
          <div style={{ width: 320, flex: "none" }}>
            <ThreadsSidebar defaultFilter="open" />
          </div>
        </div>
      </div>
    </CommentsProvider>
  );
}
