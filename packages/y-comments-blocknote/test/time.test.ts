import { describe, expect, it } from "vitest";
import { relativeTime } from "../src/time.js";

const NOW = new Date("2026-07-14T12:00:00.000Z");

function ago(seconds: number): string {
  return new Date(NOW.getTime() - seconds * 1000).toISOString();
}

describe("relativeTime", () => {
  it("says 'just now' under a minute, including future timestamps (clock skew)", () => {
    expect(relativeTime(ago(0), NOW)).toBe("just now");
    expect(relativeTime(ago(59), NOW)).toBe("just now");
    expect(relativeTime(ago(-120), NOW)).toBe("just now");
  });

  it("formats minutes, hours and days", () => {
    expect(relativeTime(ago(60), NOW)).toBe("1m");
    expect(relativeTime(ago(59 * 60), NOW)).toBe("59m");
    expect(relativeTime(ago(3600), NOW)).toBe("1h");
    expect(relativeTime(ago(23 * 3600), NOW)).toBe("23h");
    expect(relativeTime(ago(86400), NOW)).toBe("1d");
    expect(relativeTime(ago(6 * 86400), NOW)).toBe("6d");
  });

  it("falls back to a locale date after a week", () => {
    const iso = ago(8 * 86400);
    expect(relativeTime(iso, NOW)).toBe(new Date(iso).toLocaleDateString());
  });
});
