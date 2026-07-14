import { describe, expect, it } from "vitest";
import { findQuote } from "../src/quote-match.js";

describe("findQuote", () => {
  it("returns null for an empty quote", () => {
    expect(findQuote("abc", "", "", "")).toBeNull();
  });

  it("returns null when the quote is absent", () => {
    expect(findQuote("hello world", "fox", "", "")).toBeNull();
  });

  it("finds a unique occurrence regardless of context", () => {
    expect(findQuote("hello brave world", "brave", "wrong", "wrong")).toEqual({
      start: 6,
      end: 11,
    });
  });

  it("uses prefix/suffix to disambiguate repeats", () => {
    const text = "the cat sat; the cat ran";
    expect(findQuote(text, "cat", "the ", " ran")).toEqual({ start: 17, end: 20 });
    expect(findQuote(text, "cat", "the ", " sat")).toEqual({ start: 4, end: 7 });
  });

  it("returns null on an exact tie (never guesses)", () => {
    expect(findQuote("a fox b fox", "fox", "", "")).toBeNull();
    // identical context on both sides of both occurrences
    expect(findQuote("x fox y x fox y", "fox", "x ", " y")).toBeNull();
  });

  it("partial context still wins when it is strictly better", () => {
    const text = "aa fox .. zb fox ..";
    // prefix ends with "b " → matches second occurrence's before by 2 chars,
    // first occurrence's by 1 (the space)
    expect(findQuote(text, "fox", "b ", "")).toEqual({ start: 13, end: 16 });
  });

  it("property: quote planted with its true context is always found (seeded fuzz)", () => {
    // deterministic LCG so failures are reproducible
    let seed = 42;
    const rand = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    const alphabet = "abcd ";
    const randStr = (n: number) =>
      Array.from({ length: n }, () => alphabet[Math.floor(rand() * alphabet.length)]).join("");

    for (let round = 0; round < 200; round++) {
      const quote = "QUOTE";
      const parts = [randStr(20), randStr(20), randStr(20)];
      const occurrenceCount = 2 + Math.floor(rand() * 2); // 2-3 occurrences
      let text = parts[0];
      const starts: number[] = [];
      for (let k = 0; k < occurrenceCount; k++) {
        starts.push(text.length);
        text += quote + parts[(k + 1) % parts.length] + `#${k}#`;
      }
      const target = Math.floor(rand() * occurrenceCount);
      const start = starts[target];
      const prefix = text.slice(Math.max(0, start - 32), start);
      const suffix = text.slice(start + quote.length, start + quote.length + 32);

      const match = findQuote(text, quote, prefix, suffix);
      // The unique-best-match rule: either the true occurrence, or null when
      // contexts genuinely tie — never a different occurrence.
      if (match !== null) {
        expect(match.start).toBe(start);
        expect(match.end).toBe(start + quote.length);
      } else {
        // a null is only acceptable if some other occurrence ties the target's score
        const score = (s: number) => {
          const before = text.slice(Math.max(0, s - prefix.length), s);
          const after = text.slice(s + quote.length, s + quote.length + suffix.length);
          let a = 0;
          while (
            a < prefix.length &&
            a < before.length &&
            prefix[prefix.length - 1 - a] === before[before.length - 1 - a]
          ) {
            a++;
          }
          let b = 0;
          while (b < suffix.length && b < after.length && suffix[b] === after[b]) {
            b++;
          }
          return a + b;
        };
        const targetScore = score(start);
        const others = starts.filter((s) => s !== start).map(score);
        expect(Math.max(...others)).toBeGreaterThanOrEqual(targetScore);
      }
    }
  });
});
