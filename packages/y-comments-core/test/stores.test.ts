import { describe, expect, it, vi } from "vitest";
import { InMemoryThreadStore } from "../src/memory-store.js";
import { RestThreadStore, anchorToDTO, threadFromDTO, type ThreadDTO } from "../src/rest-store.js";
import { DefaultThreadStoreAuth } from "../src/store.js";
import type { Anchor } from "../src/types.js";

const anchor: Anchor = {
  relFrom: new Uint8Array([1, 2, 3]),
  relTo: new Uint8Array([4, 5, 6]),
  containerId: "block-1",
  quotedText: "brown fox",
  prefix: "The quick ",
  suffix: " jumps",
};

describe("InMemoryThreadStore", () => {
  it("supports the full thread lifecycle and notifies subscribers", async () => {
    const store = new InMemoryThreadStore({ userId: "alice" });
    const seen: number[] = [];
    const unsubscribe = store.subscribe("doc1", (threads) => seen.push(threads.length));

    const thread = await store.createThread({ docId: "doc1", anchor, body: { text: "root" } });
    expect(thread.comments[0].body.text).toBe("root");
    expect(thread.comments[0].userId).toBe("alice");

    const reply = await store.addComment({ threadId: thread.id, body: { text: "reply" } });
    await store.updateComment({ threadId: thread.id, commentId: reply.id, body: { text: "edited" } });
    await store.addReaction({ threadId: thread.id, commentId: reply.id, emoji: "👍" });
    await store.resolveThread({ threadId: thread.id });

    const [loaded] = await store.getThreads("doc1");
    expect(loaded.comments).toHaveLength(2);
    expect(loaded.comments[1].body.text).toBe("edited");
    expect(loaded.comments[1].reactions).toEqual([{ emoji: "👍", userIds: ["alice"] }]);
    expect(loaded.resolved).toBe(true);
    expect(loaded.resolvedBy).toBe("alice");

    await store.deleteReaction({ threadId: thread.id, commentId: reply.id, emoji: "👍" });
    await store.unresolveThread({ threadId: thread.id });
    await store.deleteComment({ threadId: thread.id, commentId: reply.id });
    await store.deleteThread({ threadId: thread.id });
    expect(await store.getThreads("doc1")).toHaveLength(0);

    expect(seen[0]).toBe(0); // initial emit on subscribe
    expect(seen[seen.length - 1]).toBe(0);
    expect(seen).toContain(1);
    unsubscribe();
  });

  it("deletes the thread when its last comment is deleted", async () => {
    const store = new InMemoryThreadStore({ userId: "alice" });
    const thread = await store.createThread({ docId: "doc1", anchor, body: { text: "root" } });
    await store.deleteComment({ threadId: thread.id, commentId: thread.comments[0].id });
    expect(await store.getThreads("doc1")).toHaveLength(0);
  });
});

describe("DefaultThreadStoreAuth", () => {
  it("gates by ownership and role", async () => {
    const store = new InMemoryThreadStore({ userId: "alice" });
    const thread = await store.createThread({ docId: "doc1", anchor, body: { text: "root" } });
    const comment = thread.comments[0];

    const commenter = new DefaultThreadStoreAuth("bob", "commenter");
    expect(commenter.canCreateThread()).toBe(true);
    expect(commenter.canUpdateComment(comment)).toBe(false);
    expect(commenter.canDeleteComment(comment)).toBe(false);
    expect(commenter.canResolveThread(thread)).toBe(false);

    const author = new DefaultThreadStoreAuth("alice", "commenter");
    expect(author.canUpdateComment(comment)).toBe(true);
    expect(author.canResolveThread(thread)).toBe(true);

    const editor = new DefaultThreadStoreAuth("bob", "editor");
    expect(editor.canDeleteComment(comment)).toBe(true);
    expect(editor.canDeleteThread(thread)).toBe(true);
  });
});

describe("RestThreadStore", () => {
  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(body === undefined ? null : JSON.stringify(body), { status });
  }

  it("serializes anchors as base64 and deserializes thread DTOs", async () => {
    const dto: ThreadDTO = {
      id: "t1",
      docId: "doc1",
      anchor: anchorToDTO(anchor),
      comments: [],
      resolved: false,
      createdAt: "2026-01-01T00:00:00Z",
    };
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchFn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return String(url).endsWith("/threads") && init?.method === "GET"
        ? jsonResponse([dto])
        : jsonResponse(dto);
    });

    const store = new RestThreadStore({ baseUrl: "https://api.test/comments/", fetch: fetchFn });
    const created = await store.createThread({ docId: "doc1", anchor, body: { text: "hi" } });
    expect(created.anchor.relFrom).toEqual(anchor.relFrom);
    expect(created.anchor.relTo).toEqual(anchor.relTo);

    const posted = JSON.parse(String(calls[0].init.body));
    expect(typeof posted.anchor.relFrom).toBe("string");
    expect(calls[0].url).toBe("https://api.test/comments/docs/doc1/threads");

    const threads = await store.getThreads("doc1");
    expect(threads[0].anchor.quotedText).toBe("brown fox");
    expect(threads[0].anchor.relFrom).toEqual(anchor.relFrom);
  });

  it("hits the documented endpoints", async () => {
    const urls: string[] = [];
    const fetchFn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      urls.push(`${init?.method} ${String(url)}`);
      return jsonResponse(undefined, 204);
    });
    const store = new RestThreadStore({ baseUrl: "https://api.test", fetch: fetchFn });

    await store.deleteThread({ threadId: "t1" });
    await store.resolveThread({ threadId: "t1" });
    await store.unresolveThread({ threadId: "t1" });
    await store.deleteComment({ threadId: "t1", commentId: "c1" });
    await store.addReaction({ threadId: "t1", commentId: "c1", emoji: "👍" });
    await store.deleteReaction({ threadId: "t1", commentId: "c1", emoji: "👍" });

    expect(urls).toEqual([
      "DELETE https://api.test/threads/t1",
      "POST https://api.test/threads/t1/resolve",
      "POST https://api.test/threads/t1/unresolve",
      "DELETE https://api.test/threads/t1/comments/c1",
      "POST https://api.test/threads/t1/comments/c1/reactions",
      `DELETE https://api.test/threads/t1/comments/c1/reactions/${encodeURIComponent("👍")}`,
    ]);
  });

  it("polls in subscribe and stops on unsubscribe", async () => {
    vi.useFakeTimers();
    try {
      const fetchFn = vi.fn(async () => jsonResponse([]));
      const store = new RestThreadStore({
        baseUrl: "https://api.test",
        fetch: fetchFn,
        pollIntervalMs: 1000,
      });
      const onChange = vi.fn();
      const unsubscribe = store.subscribe("doc1", onChange);
      await vi.advanceTimersByTimeAsync(3500);
      expect(fetchFn).toHaveBeenCalledTimes(4); // initial + 3 polls
      unsubscribe();
      await vi.advanceTimersByTimeAsync(5000);
      expect(fetchFn).toHaveBeenCalledTimes(4);
      expect(onChange).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("refreshes subscribers immediately after a mutation, not on the next poll", async () => {
    vi.useFakeTimers();
    try {
      let threads: ThreadDTO[] = [];
      const fetchFn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method === "GET") {
          return jsonResponse(threads);
        }
        // the server accepts the reply; the next GET will include it
        threads = [
          {
            id: "t1",
            docId: "doc1",
            anchor: anchorToDTO(anchor),
            comments: [],
            resolved: false,
            createdAt: "2026-01-01T00:00:00Z",
          },
        ];
        return jsonResponse(undefined, 204);
      });
      const store = new RestThreadStore({
        baseUrl: "https://api.test",
        fetch: fetchFn,
        pollIntervalMs: 60_000, // a poll must not be what delivers the update
      });
      const onChange = vi.fn();
      const unsubscribe = store.subscribe("doc1", onChange);
      await vi.advanceTimersByTimeAsync(0); // initial fetch settles
      expect(onChange).toHaveBeenLastCalledWith([]);

      await store.resolveThread({ threadId: "t1" });
      await vi.advanceTimersByTimeAsync(0); // triggered refetch settles
      expect(onChange).toHaveBeenLastCalledWith([expect.objectContaining({ id: "t1" })]);

      unsubscribe();
      await store.resolveThread({ threadId: "t1" });
      await vi.advanceTimersByTimeAsync(0);
      expect(onChange).toHaveBeenCalledTimes(2); // no refresh after unsubscribe
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports outages once and recovery once via subscribe callbacks", async () => {
    vi.useFakeTimers();
    try {
      let fail = false;
      const fetchFn = vi.fn(async () => {
        if (fail) {
          throw new Error("connection refused");
        }
        return jsonResponse([]);
      });
      const onSubscribeError = vi.fn();
      const onSubscribeRecover = vi.fn();
      const store = new RestThreadStore({
        baseUrl: "https://api.test",
        fetch: fetchFn,
        pollIntervalMs: 1000,
        onSubscribeError,
        onSubscribeRecover,
      });
      const unsubscribe = store.subscribe("doc1", () => {});
      await vi.advanceTimersByTimeAsync(1500); // healthy polls
      expect(onSubscribeError).not.toHaveBeenCalled();

      fail = true;
      await vi.advanceTimersByTimeAsync(3000); // several failing polls
      expect(onSubscribeError).toHaveBeenCalledTimes(1); // outage reported once

      fail = false;
      await vi.advanceTimersByTimeAsync(2000);
      expect(onSubscribeRecover).toHaveBeenCalledTimes(1);
      expect(onSubscribeError).toHaveBeenCalledTimes(1);
      unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });

  it("threadFromDTO round-trips", () => {
    const dto: ThreadDTO = {
      id: "t1",
      docId: "doc1",
      anchor: anchorToDTO(anchor),
      comments: [],
      resolved: false,
      createdAt: "2026-01-01T00:00:00Z",
    };
    expect(threadFromDTO(dto).anchor).toEqual(anchor);
  });
});
