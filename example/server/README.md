# y-comments reference server (Go + SQLite)

A minimal implementation of the y-comments REST contract for local
development and as a reference for real backends. Threads and comments live
in SQLite; the document itself is never touched.

```bash
npm run server            # from the repo root, or:
cd example/server && go run . -addr :8787 -db comments.db
```

The example app reaches it through vite's `/api` proxy; just `npm run dev`
in a second terminal. To point the app at a differently-hosted instance,
set `VITE_COMMENTS_API=<base url>`.

## Identity & authorization

Identity comes from the `X-User-Id` header (default `anonymous`), a
stand-in for your real session auth. Enforced rules mirror
`DefaultThreadStoreAuth`:

- anyone may create threads, reply, and react;
- only the author may edit or delete a comment;
- only the thread author may delete a thread (resolve is open to all here).

All *real* authorization belongs server-side like this; the client-side
`ThreadStoreAuth` only drives UI affordances.

## Endpoints

```
GET    /docs/{docId}/threads                        → Thread[]
POST   /docs/{docId}/threads    { anchor, body }    → Thread (201)
POST   /threads/{id}/comments   { body }            → Comment (201)
PATCH  /threads/{id}/comments/{cid}  { body }       → Comment
DELETE /threads/{id}/comments/{cid}                  (last comment deletes the thread)
DELETE /threads/{id}
POST   /threads/{id}/resolve | /unresolve
POST   /threads/{id}/comments/{cid}/reactions  { emoji }
DELETE /threads/{id}/comments/{cid}/reactions/{emoji}
PATCH  /threads/{id}/anchor     { anchor }           (optional; used by selfHeal)
```

`anchor.relFrom` / `anchor.relTo` are base64-encoded Yjs relative positions,
capped at 4 KB decoded: a forged anchor can only misplace a highlight,
never modify content, but it is bounded anyway.
