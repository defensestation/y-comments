# y-comments example

BlockNote + y-comments demo with a real backend: the Go + SQLite reference
server in [`server/`](server/README.md) implements the REST contract, and
the app talks to it through vite's `/api` proxy.

## Run it

Two terminals from the repo root (Go ≥ 1.22 required):

```bash
# 1: the comments backend (SQLite file appears at example/server/comments.db)
npm run server --workspace=example

# 2: the app
npm run dev
```

Open http://localhost:5173. To try it without Go:

```bash
VITE_COMMENTS_API=memory npm run dev
```

### Direct HTTP calls (skip the vite proxy)

By default the browser calls `/api/...` and vite's dev server forwards to
the Go server. To have the browser call the backend directly (e.g. when the
Go server runs on another host/container, which sends permissive CORS
headers), point the app at its base URL:

```bash
VITE_COMMENTS_API=http://172.17.0.3:8787 npm run dev
```

Every request then goes straight from the UI to that address; check the
Network tab to see the raw REST contract in action.

## What to test

- **Create**: select text, click the 💬 button in the formatting toolbar,
  write, and hit Comment. A highlight appears; the thread shows in the
  sidebar and in a popover when you click the highlight.
- **Anchors track edits**: type before, inside, or after a highlight and it
  follows. Reload the page: threads come back from SQLite and re-anchor.
- **Outdated**: delete a whole commented sentence. The highlight disappears
  but the thread moves to the sidebar's *Outdated* group with its quote.
- **Multiple users**: open a second tab at
  `http://localhost:5173/?user=bob`. Tabs share the document (BroadcastChannel)
  and the thread store (polling every 2 s). Bob can reply and react, but
  gets no edit/delete/resolve buttons on Alice's comments, while Alice
  (role `editor`) can moderate everything. The server enforces the same
  rules (`X-User-Id` header), not just the UI.
- **Zero document writes**: comment all you like, then check the Network
  tab: only `/api` traffic, no Yjs updates. The document bytes never
  change because of comments.

## Notes

- Identity is per-tab via `?user=<id>`; unknown ids work too.
- The cross-tab sync (`src/sync.ts`) is a demo stand-in for a real Yjs
  provider; comments never touch the doc either way.
- Data lives in `example/server/comments.db`; delete the file to reset.
