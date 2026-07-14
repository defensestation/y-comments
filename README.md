# y-comments

Comments for [BlockNote](https://www.blocknotejs.org/) (and other
y-prosemirror editors) that **never write to the document**. Anchors are Yjs
relative positions stored in an external store; highlights are ProseMirror
decorations: view-only overlays, never marks.

| Package | What it is |
| --- | --- |
| `@defensestation/y-comments-core` | Editor-agnostic data model, `ThreadStore` interface, `InMemoryThreadStore`, `RestThreadStore`, quote matching, anchor resolution chain. Depends only on `yjs`. |
| `@defensestation/y-comments-prosemirror` | Anchor creation from selections, decorations plugin, `DocAdapter` binding the resolution chain to a live editor. |
| `@defensestation/y-comments-blocknote` | React UI for BlockNote ≥ 0.51: provider, toolbar button, floating composer/thread, sidebar. |

## Documentation

- [Quick start](#quick-start-blocknote) and [UI behavior](#ui-behavior) — wire up the BlockNote UI.
- [How anchoring works](#how-anchoring-works) — the relative-position + quote fallback chain.
- [Thread stores](#thread-stores) and the [REST contract](#rest-contract) — the storage interface and the reference HTTP shape.
- [Transports & store wrappers](docs/transports.md) — WebSocket / gRPC-stream adapters (`PushThreadStore`), optimistic updates (`OptimisticThreadStore`), and a production composition.
- [Example app](example/README.md) — runnable BlockNote + comments demo with multi-user auth and cross-tab sync.
- [Reference server](example/server/README.md) — Go + SQLite implementation of the REST contract.

## Why decorations, not marks?

Every existing option (BlockNote comments, Liveblocks, Tiptap Comments)
anchors comments with a **mark inside the document**. In a collaborative
Yjs document synced through a backend, that has three structural defects:

1. **Creating a comment is indistinguishable from editing content.** The
   backend sees opaque Yjs update bytes, so commenting breaks any workflow
   that locks editing server-side (or forces a hole in the lock that a
   malicious client can abuse to edit content).
2. **Comment data lives in the CRDT, so it has no ACLs.** Any client that
   can open the doc can forge or vandalize any comment. Thread bodies
   belong in a database behind an authenticated API.
3. **Comment activity pollutes content-change detection.** Approval flows
   pinned to document update sequences get false "changed after approval"
   signals from mere comment activity.

y-comments fixes all three at the root: **the content document stays
byte-pure content.** Comment threads live behind a `ThreadStore`; anchors
are Yjs relative positions (the primitive behind remote cursors) plus
fallback selectors; highlights are rendered as decorations.

## Quick start (BlockNote)

```bash
npm install @defensestation/y-comments-blocknote
```

```tsx
import { BlockNoteView } from "@blocknote/mantine";
import {
  FormattingToolbar, FormattingToolbarController,
  getFormattingToolbarItems, useCreateBlockNote,
} from "@blocknote/react";
import {
  CommentsProvider, CreateCommentButton, FloatingComposer,
  FloatingThread, InMemoryThreadStore, ThreadsSidebar,
} from "@defensestation/y-comments-blocknote";
import "@defensestation/y-comments-blocknote/style.css";

const store = new InMemoryThreadStore({ userId: "alice" });
const resolveUsers = async (ids) => ids.map((id) => ({ id, username: id }));

function Editor({ ydoc, provider }) {
  const editor = useCreateBlockNote({
    // comments require collaboration mode (that's where relative positions live)
    collaboration: { fragment: ydoc.getXmlFragment("document-store"), user: { name: "Alice", color: "#f6a" }, provider },
  });

  return (
    <CommentsProvider editor={editor} store={store} docId="my-doc" resolveUsers={resolveUsers}>
      <BlockNoteView editor={editor} formattingToolbar={false}>
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
      <ThreadsSidebar />
    </CommentsProvider>
  );
}
```

Highlight colors and chrome are themed via CSS variables
(`--y-comments-*`, falling back to BlockNote's `--bn-*` variables); override
them to re-skin.

### UI behavior

- The composer textarea focuses itself when opened from the toolbar button.
- **Enter** submits (new comment, reply, edit); **Shift+Enter** inserts a
  newline; **Escape** dismisses the popover, or cancels just the edit while
  a comment is being edited.
- Long threads scroll inside the popover/card and follow the newest comment
  as replies arrive, unless the reader scrolled up (scrolling back to the
  bottom re-pins). Cap the scroll area with
  `--y-comments-thread-max-height` (default 280px).
- Failed store calls surface inline, next to the action, with the draft
  preserved for retry.

## How anchoring works

An `Anchor` stores, in fidelity order:

1. `relFrom`/`relTo`, encoded **Y.RelativePosition**s. These follow the
   text through concurrent remote edits and survive update-log compaction.
2. `containerId`, the BlockNote block ID, a stable container hint.
3. `quotedText` plus 32 chars of `prefix`/`suffix` context.

Resolution walks the same order: exact relative positions, then a quote
search within the container, then a quote search across the document, then
pinning to the surviving container, and finally orphaned. (The doc-wide
search runs before settling for the container so that splitting a block,
such as pressing Enter before a comment, re-anchors instead of outdating the
thread.) Ambiguous quote matches are treated as not found; the resolver
never guesses. Nothing is ever deleted: threads whose text is gone appear in
the sidebar under **Outdated** with their quote (the GitHub
outdated-review-comment pattern), and `thread.outdated` set by your backend
is rendered regardless.

Optional **self-healing** (`selfHeal` on `CommentsProvider`) persists a
fresh anchor after a successful re-anchor, but only when the re-resolved
text equals the stored quote exactly. It is off by default because it
writes to the store on read.

## Thread stores

- `InMemoryThreadStore`: demos and tests.
- `RestThreadStore`: plain `fetch` against the REST contract below;
  `subscribe` polls (default 10 s) or upgrades to SSE via `sseUrl`.
- `PushThreadStore(base, transport)`: replaces polling with your own push
  channel (WebSocket, gRPC server stream, socket.io, and so on); reads and
  mutations delegate to the base store.
- `OptimisticThreadStore(base, { userId })`: local-first wrapper where your
  own actions render immediately and reconcile (or roll back) when the
  server answers.
- Or implement `ThreadStore` yourself (method names mirror BlockNote's, so
  mental models transfer).

Every store refreshes live subscriptions immediately after a successful
mutation, so polling/push cadence only affects how fast you see *other*
people's changes. Transport recipes, the wrapper semantics, and a
production composition live in [`docs/transports.md`](docs/transports.md).

```ts
// production shape: REST reads/writes, push stream, instant local UI
const store = new OptimisticThreadStore(
  new PushThreadStore(new RestThreadStore({ baseUrl: "/api" }), transport),
  { userId: me.id }
);
```

`ThreadStoreAuth` (e.g. `DefaultThreadStoreAuth(userId, "editor" | "commenter")`)
only drives UI affordances; real authorization is your backend's job.

### REST contract

```
GET    {base}/docs/{docId}/threads                 → Thread[]
POST   {base}/docs/{docId}/threads                 { anchor, body }  → Thread
POST   {base}/threads/{id}/comments                { body }          → Comment
PATCH  {base}/threads/{id}/comments/{cid}          { body }          → Comment
DELETE {base}/threads/{id}/comments/{cid}
DELETE {base}/threads/{id}
POST   {base}/threads/{id}/resolve | /unresolve
POST   {base}/threads/{id}/comments/{cid}/reactions    { emoji }
DELETE {base}/threads/{id}/comments/{cid}/reactions/{emoji}
PATCH  {base}/threads/{id}/anchor                  { anchor }        (optional, selfHeal)
```

`anchor.relFrom`/`relTo` cross the wire base64-encoded; cap the blob size
server-side (a forged anchor can only misplace a highlight, never modify
content, but bound it anyway). A reference Go + SQLite implementation lives
in [`example/server/`](example/server/README.md).

## Development

```bash
npm install
npm test          # vitest across all packages
npm run build     # builds the three packages

# run the example (see example/README.md for the full tour):
npm run server    # Go + SQLite comments backend on :8787 (terminal 1)
npm run dev       # vite app on :5173, proxying /api to it   (terminal 2)

# or without Go:
VITE_COMMENTS_API=memory npm run dev
```

## Guarantees (tested)

- Creating/replying/resolving/reacting produces **zero Yjs document
  updates** (asserted via `doc.on("update")` in tests).
- Highlights track concurrent remote edits and survive compaction of the
  update log into a fresh doc.
- Deleting commented text never loses the thread; it shows as Outdated
  with its quote, and undoing the deletion re-anchors it so the highlight
  returns.
- Own mutations reach subscribers in one round-trip (no waiting for a poll
  tick); the optimistic wrapper makes them instant and rolls back on
  failure.
- `y-comments-core` builds and tests with only `yjs` installed.

## Non-goals

Fuzzy quote matching (exact only; the seam is `core/src/quote-match.ts`),
Slate/Lexical/CodeMirror adapters, offline queueing of thread writes,
notifications/mentions.

## License

MIT
