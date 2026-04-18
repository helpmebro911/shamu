import { describe, expect, it } from "vitest";
import { canonicalize, contentHash } from "../src/hash.ts";

describe("contentHash", () => {
  it("produces the same hash regardless of object key order", () => {
    const a = contentHash({ a: 1, b: 2, nested: { x: true, y: null } });
    const b = contentHash({ b: 2, nested: { y: null, x: true }, a: 1 });
    expect(a).toBe(b);
  });

  it("produces different hashes for structurally different inputs", () => {
    expect(contentHash({ a: 1 })).not.toBe(contentHash({ a: 2 }));
    expect(contentHash([1, 2, 3])).not.toBe(contentHash([3, 2, 1]));
    expect(contentHash("1")).not.toBe(contentHash(1));
  });

  it("treats undefined-valued object properties as absent (JSON parity)", () => {
    expect(contentHash({ a: 1, b: undefined })).toBe(contentHash({ a: 1 }));
  });

  it("hashes primitives stably", () => {
    expect(contentHash(null)).toBe(contentHash(null));
    expect(contentHash(true)).toBe(contentHash(true));
    expect(contentHash(false)).toBe(contentHash(false));
    expect(contentHash("")).toBe(contentHash(""));
    expect(contentHash(0)).toBe(contentHash(0));
    expect(contentHash(1.5)).toBe(contentHash(1.5));
  });

  it("rejects undefined at the root", () => {
    expect(() => contentHash(undefined)).toThrow(/undefined/);
  });

  it("rejects function values", () => {
    expect(() => contentHash({ fn: () => 1 })).toThrow(/function/);
  });

  it("rejects symbol values", () => {
    expect(() => contentHash({ s: Symbol("x") })).toThrow(/symbol/);
  });

  it("rejects bigint values", () => {
    expect(() => contentHash({ big: 1n })).toThrow(/bigint/);
  });

  it("rejects NaN and Infinity", () => {
    expect(() => contentHash(Number.NaN)).toThrow(/non-finite/);
    expect(() => contentHash(Number.POSITIVE_INFINITY)).toThrow(/non-finite/);
    expect(() => contentHash(Number.NEGATIVE_INFINITY)).toThrow(/non-finite/);
  });

  it("rejects Date, Map, and Set", () => {
    expect(() => contentHash({ d: new Date(0) })).toThrow(/Date/);
    expect(() => contentHash({ m: new Map() })).toThrow(/Map|Set/);
    expect(() => contentHash({ s: new Set() })).toThrow(/Map|Set/);
  });

  it("detects object cycles", () => {
    const a: Record<string, unknown> = { x: 1 };
    a.self = a;
    expect(() => contentHash(a)).toThrow(/cycle/);
  });

  it("preserves array order", () => {
    expect(contentHash([1, 2])).not.toBe(contentHash([2, 1]));
  });

  it("canonicalize emits sorted-key JSON", () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(`{"a":2,"b":1}`);
  });

  it("canonicalize handles nested mixed types", () => {
    expect(canonicalize({ a: [1, { y: true, x: null }], b: "s" })).toBe(
      `{"a":[1,{"x":null,"y":true}],"b":"s"}`,
    );
  });
});
