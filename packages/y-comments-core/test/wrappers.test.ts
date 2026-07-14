import { describe, expect, it, vi } from "vitest";
import { InMemoryThreadStore } from "../src/memory-store.js";
import { OptimisticThreadStore } from "../src/optimistic-store.js";
import { PushThreadStore, type PushTransport } from "../src/push-store.js";
import type { ThreadStore } from "../src/store.js";
import type { Anchor, Thread } from "../src/types.js";

const anchor: Anchor = {
  relFrom: new Uint8Array([1, 2, 3]),
  relTo: new Uint8Array([4, 5, 6]),
  containerId: "block-1",
  quotedText: "brown fox",
  prefix: "The quick ",
  suffix: " jumps",
};

/**
 * InMemoryThreadStore with every mutation held until `release()` — lets a
 * test observe the optimistic window while the "server" hasn't answered.
 * Failure injection: set `failNext` to reject the next mutation.
 */
function gatedStore(userId: string) {
  const inner = new InMemoryThreadStore({ userId });
  let gates: (() => void)[] = [];
  const control = {
    failNext: false,
    release: () => {
      const pending = gates;
      gates = [];
      for (const open of pending) {
        open();
      }
    },
  };
  const MUTATIONS = new Set([
    "createThread",
    "addComment",
    "updateComment",
    "deleteComment",
    "deleteThread",
    "resolveThread",
    "unresolveThread",
    "addReaction",
    "deleteReaction",
  ]);
  const store = new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop !== "string" || !MUTATIONS.has(prop) || typeof value !== "function") {
        return typeof value === "function" ? value.bind(target) : value;
      }
      return async (...args: unknown[]) => {
        await new Promise<void>((resolve) => gates.push(resolve));
        if (control.failNext) {
          control.failNext = false;
          throw new Error("injected failure");
        }
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as ThreadStore;
  return { store, control };
}

describe("PushThreadStore", () => {
  it("delivers transport payloads, refetches on empty notify, and never polls", async () => {
    const base = new InMemoryThreadStore({ userId: "alice" });
    let notify!: (threads?: Thread[]) => void;
    const disconnect = vi.fn();
    const transport: PushTransport = (_docId, n) => {
      notify = n;
      return disconnect;
    };
    const store = new PushThreadStore(base, transport);

    const seen: Thread[][] = [];
    const unsubscribe = store.subscribe("doc1", (threads) => seen.push(threads));
    await vi.waitFor(() => expect(seen).toHaveLength(1)); // initial fetch
    expect(seen[0]).toEqual([]);

    // out-of-band change (another client), then a push ping → refetch
    await base.createThread({ docId: "doc1", anchor, body: { text: "remote" } });
    notify();
    await vi.waitFor(() => expect(seen.length).toBeGreaterThanOrEqual(2));
    expect(seen[seen.length - 1]).toHaveLength(1);

    // transports that carry the payload skip the refetch entirely
    notify([]);
    expect(seen[seen.length - 1]).toEqual([]);

    unsubscribe();
    expect(disconnect).toHaveBeenCalledTimes(1);
    notify();
    await new Promise((r) => setTimeout(r, 10));
    expect(seen[seen.length - 1]).toEqual([]); // no emission after unsubscribe
  });

  it("refreshes subscribers immediately after own mutations", async () => {
    const base = new InMemoryThreadStore({ userId: "alice" });
    const store = new PushThreadStore(base, () => () => {});
    const seen: Thread[][] = [];
    store.subscribe("doc1", (threads) => seen.push(threads));
    await vi.waitFor(() => expect(seen).toHaveLength(1));

    await store.createThread({ docId: "doc1", anchor, body: { text: "mine" } });
    await vi.waitFor(() => expect(seen[seen.length - 1]).toHaveLength(1));
    expect(seen[seen.length - 1][0].comments[0].body.text).toBe("mine");
  });
});

describe("OptimisticThreadStore", () => {
  async function subscribed(store: ThreadStore) {
    const emissions: Thread[][] = [];
    store.subscribe("doc1", (threads) => emissions.push(threads));
    await vi.waitFor(() => expect(emissions.length).toBeGreaterThanOrEqual(1));
    const latest = () => emissions[emissions.length - 1];
    return { emissions, latest };
  }

  it("shows a reply immediately, then reconciles to the server id without duplicates", async () => {
    const { store: base, control } = gatedStore("alice");
    const store = new OptimisticThreadStore(base, { userId: "alice" });

    const createPromise = store.createThread({ docId: "doc1", anchor, body: { text: "root" } });
    control.release();
    const thread = await createPromise;

    const { latest } = await subscribed(store);
    await vi.waitFor(() => expect(latest()).toHaveLength(1));

    const replyPromise = store.addComment({ threadId: thread.id, body: { text: "instant" } });
    // before the server answers: the reply is already visible, marked local
    expect(latest()[0].comments).toHaveLength(2);
    expect(latest()[0].comments[1].id).toMatch(/^optimistic-/);
    expect(latest()[0].comments[1].userId).toBe("alice");

    control.release();
    await replyPromise;
    await vi.waitFor(() => {
      const comments = latest()[0].comments;
      expect(comments).toHaveLength(2); // exactly two — no temp/server duplicate
      expect(comments[1].id).not.toMatch(/^optimistic-/);
      expect(comments[1].body.text).toBe("instant");
    });
  });

  it("rolls back and rethrows when the server rejects", async () => {
    const { store: base, control } = gatedStore("alice");
    const store = new OptimisticThreadStore(base, { userId: "alice" });
    const createPromise = store.createThread({ docId: "doc1", anchor, body: { text: "root" } });
    control.release();
    const thread = await createPromise;
    const { latest } = await subscribed(store);
    await vi.waitFor(() => expect(latest()).toHaveLength(1));

    control.failNext = true;
    const replyPromise = store.addComment({ threadId: thread.id, body: { text: "doomed" } });
    expect(latest()[0].comments).toHaveLength(2); // optimistic
    control.release();
    await expect(replyPromise).rejects.toThrow("injected failure");
    expect(latest()[0].comments).toHaveLength(1); // rolled back
  });

  it("creates threads optimistically with a temp id that swaps for the server's", async () => {
    const { store: base, control } = gatedStore("alice");
    const store = new OptimisticThreadStore(base, { userId: "alice" });
    const { latest } = await subscribed(store);

    const createPromise = store.createThread({ docId: "doc1", anchor, body: { text: "new" } });
    expect(latest()).toHaveLength(1);
    expect(latest()[0].id).toMatch(/^optimistic-/);

    control.release();
    const thread = await createPromise;
    await vi.waitFor(() => {
      expect(latest()).toHaveLength(1); // still exactly one
      expect(latest()[0].id).toBe(thread.id);
    });
  });

  it("applies resolve and reactions optimistically and converges with the server", async () => {
    const { store: base, control } = gatedStore("alice");
    const store = new OptimisticThreadStore(base, { userId: "alice" });
    const createPromise = store.createThread({ docId: "doc1", anchor, body: { text: "root" } });
    control.release();
    const thread = await createPromise;
    const { latest } = await subscribed(store);
    await vi.waitFor(() => expect(latest()).toHaveLength(1));
    const commentId = latest()[0].comments[0].id;

    const resolvePromise = store.resolveThread({ threadId: thread.id });
    const reactPromise = store.addReaction({ threadId: thread.id, commentId, emoji: "👍" });
    expect(latest()[0].resolved).toBe(true); // both visible pre-ack
    expect(latest()[0].comments[0].reactions).toEqual([{ emoji: "👍", userIds: ["alice"] }]);

    control.release();
    await Promise.all([resolvePromise, reactPromise]);
    await vi.waitFor(() => {
      expect(latest()[0].resolved).toBe(true); // still true from pure server state
      expect(latest()[0].comments[0].reactions).toEqual([{ emoji: "👍", userIds: ["alice"] }]);
    });
    const [serverThread] = await base.getThreads("doc1");
    expect(serverThread.resolved).toBe(true);
  });
});
