import { describe, expect, it } from "vitest";
import { AllowAllThreadStoreAuth, DefaultThreadStoreAuth } from "../src/store.js";
import type { Comment, Thread } from "../src/types.js";

function comment(userId: string, overrides: Partial<Comment> = {}): Comment {
  return {
    id: `c-${userId}`,
    userId,
    body: { text: "hello" },
    createdAt: "2026-01-01T00:00:00.000Z",
    reactions: [],
    ...overrides,
  };
}

function thread(rootUserId: string): Thread {
  return {
    id: "t1",
    docId: "doc1",
    anchor: {
      relFrom: new Uint8Array(),
      relTo: new Uint8Array(),
      quotedText: "quote",
      prefix: "",
      suffix: "",
    },
    comments: [comment(rootUserId)],
    resolved: false,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("DefaultThreadStoreAuth", () => {
  const asCommenter = new DefaultThreadStoreAuth("alice", "commenter");
  const asEditor = new DefaultThreadStoreAuth("alice", "editor");

  it("lets anyone create threads, comment and react", () => {
    for (const auth of [asCommenter, asEditor]) {
      expect(auth.canCreateThread()).toBe(true);
      expect(auth.canAddComment(thread("bob"))).toBe(true);
      expect(auth.canAddReaction(comment("bob"))).toBe(true);
    }
  });

  it("only the author may update a comment, regardless of role", () => {
    expect(asCommenter.canUpdateComment(comment("alice"))).toBe(true);
    expect(asCommenter.canUpdateComment(comment("bob"))).toBe(false);
    expect(asEditor.canUpdateComment(comment("bob"))).toBe(false);
  });

  it("the author or an editor may delete a comment", () => {
    expect(asCommenter.canDeleteComment(comment("alice"))).toBe(true);
    expect(asCommenter.canDeleteComment(comment("bob"))).toBe(false);
    expect(asEditor.canDeleteComment(comment("bob"))).toBe(true);
  });

  it("the thread creator or an editor may resolve, unresolve and delete a thread", () => {
    expect(asCommenter.canResolveThread(thread("alice"))).toBe(true);
    expect(asCommenter.canResolveThread(thread("bob"))).toBe(false);
    expect(asEditor.canResolveThread(thread("bob"))).toBe(true);

    expect(asCommenter.canUnresolveThread(thread("alice"))).toBe(true);
    expect(asCommenter.canUnresolveThread(thread("bob"))).toBe(false);
    expect(asEditor.canUnresolveThread(thread("bob"))).toBe(true);

    expect(asCommenter.canDeleteThread(thread("alice"))).toBe(true);
    expect(asCommenter.canDeleteThread(thread("bob"))).toBe(false);
    expect(asEditor.canDeleteThread(thread("bob"))).toBe(true);
  });

  it("canDeleteReaction requires the user's own reaction, per emoji or any", () => {
    const withReactions = comment("bob", {
      reactions: [
        { emoji: "👍", userIds: ["alice", "bob"] },
        { emoji: "🎉", userIds: ["bob"] },
      ],
    });
    expect(asCommenter.canDeleteReaction(withReactions, "👍")).toBe(true);
    expect(asCommenter.canDeleteReaction(withReactions, "🎉")).toBe(false);
    expect(asCommenter.canDeleteReaction(withReactions)).toBe(true);
    expect(asCommenter.canDeleteReaction(comment("bob"))).toBe(false);
  });
});

describe("AllowAllThreadStoreAuth", () => {
  it("permits everything", () => {
    const auth = new AllowAllThreadStoreAuth();
    expect(auth.canCreateThread()).toBe(true);
    expect(auth.canAddComment()).toBe(true);
    expect(auth.canUpdateComment()).toBe(true);
    expect(auth.canDeleteComment()).toBe(true);
    expect(auth.canResolveThread()).toBe(true);
    expect(auth.canUnresolveThread()).toBe(true);
    expect(auth.canDeleteThread()).toBe(true);
    expect(auth.canAddReaction()).toBe(true);
    expect(auth.canDeleteReaction()).toBe(true);
  });
});
