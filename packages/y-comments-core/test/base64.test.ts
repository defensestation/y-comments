import { afterEach, describe, expect, it, vi } from "vitest";
import { fromBase64, toBase64 } from "../src/base64.js";

const SAMPLES: [Uint8Array, string][] = [
  [new Uint8Array([]), ""],
  [new Uint8Array([0]), "AA=="],
  [new Uint8Array([72, 105, 33]), "SGkh"],
  [new Uint8Array([0, 127, 128, 255]), "AH+A/w=="],
];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("base64", () => {
  it("round-trips via Buffer (Node path)", () => {
    for (const [bytes, encoded] of SAMPLES) {
      expect(toBase64(bytes)).toBe(encoded);
      expect(fromBase64(encoded)).toEqual(bytes);
    }
  });

  it("round-trips via btoa/atob when Buffer is unavailable (browser path)", () => {
    vi.stubGlobal("Buffer", undefined);
    for (const [bytes, encoded] of SAMPLES) {
      expect(toBase64(bytes)).toBe(encoded);
      expect(fromBase64(encoded)).toEqual(bytes);
    }
  });
});
