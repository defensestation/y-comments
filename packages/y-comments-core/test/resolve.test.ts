import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { resolveThread } from "../src/resolve.js";
import { YTextAdapter, makeAnchor, makeThread, rangeText, sync } from "./helpers.js";

function setup(initial = "The quick brown fox jumps over the lazy dog") {
  const doc = new Y.Doc();
  doc.clientID = 1;
  const text = doc.getText("block-1");
  text.insert(0, initial);
  const adapter = new YTextAdapter(doc, new Map([["block-1", text]]));
  return { doc, text, adapter };
}

describe("resolveThread — exact via relative positions", () => {
  it("resolves the original range in an unchanged doc", () => {
    const { text, adapter } = setup();
    const from = "The quick ".length;
    const anchor = makeAnchor(text, from, from + "brown fox".length, "block-1");
    const res = resolveThread(makeThread(anchor), adapter);
    expect(res.kind).toBe("exact");
    if (res.kind === "exact") {
      expect(rangeText(res.from, res.to)).toBe("brown fox");
    }
  });

  it("tracks concurrent remote edits before, inside and after the range", () => {
    const { doc, text, adapter } = setup();
    const from = "The quick ".length;
    const anchor = makeAnchor(text, from, from + "brown fox".length, "block-1");

    // Remote peer with a different clientID edits concurrently.
    const remote = new Y.Doc();
    remote.clientID = 2;
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc));
    const remoteText = remote.getText("block-1");
    remoteText.insert(0, "PREFIX ");                          // before
    remoteText.insert("PREFIX The quick brown".length, "ish"); // inside
    remoteText.insert(remoteText.length, " SUFFIX");           // after
    sync(doc, remote);

    const res = resolveThread(makeThread(anchor), adapter);
    expect(res.kind).toBe("exact");
    if (res.kind === "exact") {
      expect(rangeText(res.from, res.to)).toBe("brownish fox");
    }
  });

  it("does not grow the range for typing exactly at its edges", () => {
    const { doc, text, adapter } = setup();
    const from = "The quick ".length;
    const to = from + "brown fox".length;
    const anchor = makeAnchor(text, from, to, "block-1");

    const remote = new Y.Doc();
    remote.clientID = 2;
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc));
    const remoteText = remote.getText("block-1");
    remoteText.insert(to, "!!!"); // at the right edge
    remoteText.insert(from, ">>"); // at the left edge
    sync(doc, remote);

    const res = resolveThread(makeThread(anchor), adapter);
    expect(res.kind).toBe("exact");
    if (res.kind === "exact") {
      expect(rangeText(res.from, res.to)).toBe("brown fox");
    }
  });

  it("survives compaction of the update log into a fresh doc", () => {
    const { doc, text } = setup();
    const from = "The quick ".length;
    const anchor = makeAnchor(text, from, from + "brown fox".length, "block-1");

    // Edit a bit, then fold the whole history into a fresh doc, mirroring
    // server-side compaction (ysync-go folds updates the same way).
    text.insert(0, "Chapter 1: ");
    const compacted = new Y.Doc();
    Y.applyUpdate(compacted, Y.encodeStateAsUpdate(doc));
    const compactedText = compacted.getText("block-1");
    const adapter = new YTextAdapter(compacted, new Map([["block-1", compactedText]]));

    const res = resolveThread(makeThread(anchor), adapter);
    expect(res.kind).toBe("exact");
    if (res.kind === "exact") {
      expect(rangeText(res.from, res.to)).toBe("brown fox");
    }
  });
});

describe("resolveThread — fallback chain", () => {
  it("re-anchors within the container when the range was deleted and retyped", () => {
    const { text, adapter } = setup();
    const from = "The quick ".length;
    const to = from + "brown fox".length;
    const anchor = makeAnchor(text, from, to, "block-1");

    text.delete(from, to - from);
    text.insert(from, "brown fox"); // same text, new Yjs items

    const res = resolveThread(makeThread(anchor), adapter);
    expect(res.kind).toBe("reanchored");
    if (res.kind === "reanchored") {
      expect(rangeText(res.from, res.to)).toBe("brown fox");
    }
  });

  it("re-anchors doc-wide when the quote moved out of a surviving container (block split)", () => {
    // Pressing Enter before a comment splits the block: the quoted text
    // moves to a NEW container while the original container survives
    // without it. The chain must not stop at the surviving container.
    const doc = new Y.Doc();
    const t1 = doc.getText("block-1");
    const t2 = doc.getText("block-2");
    t1.insert(0, "The quick brown fox jumps");
    const from = "The quick ".length;
    const anchor = makeAnchor(t1, from, from + "brown fox".length, "block-1");

    // simulate the split: text after the cursor moves to a new block
    t1.delete(4, t1.length - 4); // block-1 keeps "The "
    t2.insert(0, "quick brown fox jumps");
    const adapter = new YTextAdapter(
      doc,
      new Map([
        ["block-1", t1],
        ["block-2", t2],
      ])
    );

    const res = resolveThread(makeThread(anchor), adapter);
    expect(res.kind).toBe("reanchored");
    if (res.kind === "reanchored") {
      expect(res.from.type).toBe(t2);
      expect(rangeText(res.from, res.to)).toBe("brown fox");
    }
  });

  it("pins to the container when it survives but the quote is gone", () => {
    const { text, adapter } = setup();
    const from = "The quick ".length;
    const to = from + "brown fox".length;
    const anchor = makeAnchor(text, from, to, "block-1");

    text.delete(from, to - from);

    expect(resolveThread(makeThread(anchor), adapter).kind).toBe("container");
  });

  it("re-anchors anywhere in the doc when the container is gone", () => {
    const doc = new Y.Doc();
    const t1 = doc.getText("block-1");
    const t2 = doc.getText("block-2");
    t1.insert(0, "The quick brown fox");
    t2.insert(0, "unrelated");
    const from = "The quick ".length;
    const anchor = makeAnchor(t1, from, from + "brown fox".length, "block-1");

    // Simulate moving the text to another block and deleting the original.
    const containers = new Map([["block-2", t2]]);
    t2.insert(t2.length, " and also the brown fox here");
    const adapter = new YTextAdapter(doc, containers);
    // Relative positions still resolve into t1 (Yjs types are never truly
    // gone), so force the fallback by deleting the original range too.
    t1.delete(from, "brown fox".length);

    const res = resolveThread(makeThread(anchor), adapter);
    expect(res.kind).toBe("reanchored");
    if (res.kind === "reanchored") {
      expect(res.from.type).toBe(t2);
      expect(rangeText(res.from, res.to)).toBe("brown fox");
    }
  });

  it("disambiguates a repeated quote using prefix/suffix", () => {
    const doc = new Y.Doc();
    const text = doc.getText("block-1");
    text.insert(0, "say fox now, say fox later");
    // Anchor on the second "fox" (prefix "…later" context differs).
    const from = "say fox now, say ".length;
    const anchor = makeAnchor(text, from, from + "fox".length, "block-1");
    const adapter = new YTextAdapter(doc, new Map([["block-1", text]]));

    // Kill the relative positions by delete+retype of that occurrence.
    text.delete(from, "fox".length);
    text.insert(from, "fox");

    const res = resolveThread(makeThread(anchor), adapter);
    expect(res.kind).toBe("reanchored");
    if (res.kind === "reanchored") {
      expect(res.from.index).toBe(from);
    }
  });

  it("pins to a surviving container when the quote is ambiguous inside it", () => {
    const doc = new Y.Doc();
    const text = doc.getText("block-1");
    text.insert(0, "AAA fox BBB");
    const from = "AAA ".length;
    const anchor = makeAnchor(text, from, from + "fox".length, "block-1");
    const adapter = new YTextAdapter(doc, new Map([["block-1", text]]));

    // Replace the container content with two occurrences whose contexts
    // both differ from the stored one — scores tie, quote search refuses to
    // guess, but the container is still there to pin to.
    text.delete(0, text.length);
    text.insert(0, "xxx fox yyy fox zzz");

    expect(resolveThread(makeThread(anchor), adapter).kind).toBe("container");
  });

  it("orphans an ambiguous quote when the container is gone too", () => {
    const doc = new Y.Doc();
    const text = doc.getText("block-1");
    text.insert(0, "AAA fox BBB");
    const from = "AAA ".length;
    const anchor = makeAnchor(text, from, from + "fox".length, "block-1");
    const adapter = new YTextAdapter(doc, new Map([["block-1", text]]));

    text.delete(0, text.length);
    text.insert(0, "xxx fox yyy fox zzz");
    adapter.containers.delete("block-1");
    // doc-wide search sees the same ambiguous text via another container
    adapter.containers.set("block-2", text);

    expect(resolveThread(makeThread(anchor), adapter).kind).toBe("orphaned");
  });

  it("orphans when nothing is left", () => {
    const { text, adapter } = setup();
    const from = "The quick ".length;
    const anchor = makeAnchor(text, from, from + "brown fox".length, "block-1");
    text.delete(0, text.length);
    adapter.containers.delete("block-1");

    expect(resolveThread(makeThread(anchor), adapter).kind).toBe("orphaned");
  });
});
