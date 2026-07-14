# Transports & store wrappers

How thread data moves between the UI and your backend, and how to plug in
your own transport (WebSocket, gRPC streaming, SSE, socket.io, and so on).

## The contract

Everything above the store talks to one interface:

```ts
interface ThreadStore {
  auth: ThreadStoreAuth;
  getThreads(docId): Promise<Thread[]>;
  createThread(...); addComment(...); updateComment(...); // and the rest
  subscribe(docId, onChange: (threads: Thread[]) => void): () => void;
}
```

`subscribe` is the only "live" part: call `onChange` with the full thread
list whenever there's news, return an unsubscribe function. The UI diffs
emissions, so emitting an unchanged list is cheap but pointless.

## What ships in core

| Store | Transport | Latency for your own action | Latency for others' actions |
| --- | --- | --- | --- |
| `InMemoryThreadStore` | none (process memory) | immediate | immediate (same process) |
| `RestThreadStore` | fetch + polling | one round-trip¹ | poll interval (default 10 s) |
| `RestThreadStore` + `sseUrl` | fetch + SSE pings | one round-trip¹ | SSE latency + one GET |
| `PushThreadStore(base, transport)` | your push channel | one round-trip¹ | push latency (+ one GET unless the payload carries threads) |
| `OptimisticThreadStore(base, opts)` | wraps any of the above | **immediate** (reconciled in background) | same as `base` |

¹ Every successful mutation immediately refetches all live subscriptions, so
nothing waits for the next poll tick.

## Custom push transport (`PushThreadStore`)

`PushThreadStore` keeps a base store's reads/mutations (typically
`RestThreadStore`) and replaces its polling `subscribe` with your channel:

```ts
type PushTransport = (docId: string, notify: (threads?: Thread[]) => void) => () => void;
```

Call `notify()` when the server signals a change (the store refetches via
`base.getThreads`), or `notify(threads)` if your transport carries the data
(no refetch). Return a cleanup. Reconnection is your transport's job:
`EventSource`-style auto-retry, a backoff loop, whatever your stack does.

### WebSocket

```ts
import { PushThreadStore, RestThreadStore } from "@defensestation/y-comments-core";

const store = new PushThreadStore(
  new RestThreadStore({ baseUrl: "/api", headers: authHeaders }),
  (docId, notify) => {
    const ws = new WebSocket(`wss://example.com/docs/${docId}/comments/watch`);
    ws.onmessage = () => notify(); // any message = "threads changed"
    return () => ws.close();
  }
);
```

### gRPC server-side stream (Connect / grpc-web)

Browsers can't speak native gRPC; use [Connect](https://connectrpc.com/) or
grpc-web. With Connect:

```ts
const client = createClient(CommentsService, transport);

const store = new PushThreadStore(
  new RestThreadStore({ baseUrl: "/api" }),
  (docId, notify) => {
    const abort = new AbortController();
    (async () => {
      for await (const event of client.watchThreads({ docId }, { signal: abort.signal })) {
        // if your stream carries the full list, map it and pass it through:
        // notify(event.threads.map(threadFromDTO))
        notify();
      }
    })().catch(() => {
      /* reconnect policy lives here */
    });
    return () => abort.abort();
  }
);
```

Mutations can stay REST, or go gRPC unary too: implement `ThreadStore`
directly instead of wrapping `RestThreadStore` if you want gRPC end-to-end.
The server's mutation response is your durability ack; don't make the UI
wait for the change to echo back on the stream (if the stream hiccups, the
"Saving" state hangs on a write that actually succeeded).

## Optimistic updates (`OptimisticThreadStore`)

Wrap any store to get local-first UI, the way BlockNote's built-in comments
feel:

```ts
import { OptimisticThreadStore } from "@defensestation/y-comments-core";

const store = new OptimisticThreadStore(baseStore, { userId: "alice" });
```

Semantics:

- **Subscribers see every mutation immediately**, applied to the last
  server snapshot. Fabricated objects (new threads/comments) carry an
  `optimistic-` id until the server confirms, then swap for the real id.
  Reconciliation dedupes by id, so the temp/real handoff can't double-render.
- **Mutation promises still resolve with the server's answer**, so `busy`
  spinners and inline error handling in the UI keep working unchanged.
- **On failure the overlay rolls back** (subscribers see the pre-mutation
  state) and the error is rethrown.
- `userId` must match the id your backend attributes writes to, or the
  author line flickers on confirm.

Caveat: acting on a not-yet-confirmed thread (replying to it, resolving it)
sends its temporary id to the backend and fails cleanly with the inline
error. The window is one mutation round-trip; gate affordances on
non-`optimistic-` ids if that matters to you.

## Composing for production

```ts
const store = new OptimisticThreadStore(
  new PushThreadStore(
    new RestThreadStore({ baseUrl: "/api", headers: authHeaders }),
    grpcTransport
  ),
  { userId: me.id }
);
```

Reading inside-out: REST does reads + mutations, the push stream replaces
polling for other users' changes, and the optimistic layer makes your own
actions render instantly.
