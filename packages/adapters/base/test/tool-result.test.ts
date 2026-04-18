import { describe, expect, it } from "vitest";
import { __forTests, summarizeToolResult } from "../src/tool-result.ts";

const { ELLIPSIS, truncationSuffix, DEFAULT_MAX_CHARS } = __forTests;

describe("summarizeToolResult", () => {
  it("returns the text unchanged when it's under maxChars", () => {
    expect(summarizeToolResult(3, "hi!")).toBe("hi!");
  });

  it("truncates long text and appends the byte-count suffix", () => {
    const text = "a".repeat(DEFAULT_MAX_CHARS + 50);
    const out = summarizeToolResult(1234, text);
    expect(out.endsWith(truncationSuffix(1234))).toBe(true);
    expect(out).toContain(ELLIPSIS);
    // prefix length: up to DEFAULT_MAX_CHARS
    expect(out.startsWith("a".repeat(DEFAULT_MAX_CHARS))).toBe(true);
  });

  it("uses the caller-supplied `bytes` in the suffix (not text.length)", () => {
    const text = "x".repeat(2000);
    const out = summarizeToolResult(999, text);
    expect(out).toContain("(truncated, 999B)");
  });

  it("respects a custom maxChars", () => {
    const text = "abcdefghij";
    const out = summarizeToolResult(10, text, { maxChars: 5 });
    expect(out.startsWith("abcde")).toBe(true);
    expect(out).toContain("(truncated, 10B)");
  });

  it("returns empty string for non-string input", () => {
    // @ts-expect-error — forcing a type mismatch for the guard path
    expect(summarizeToolResult(0, null)).toBe("");
  });

  it("returns empty string for non-positive maxChars", () => {
    expect(summarizeToolResult(1, "hello", { maxChars: 0 })).toBe("");
    expect(summarizeToolResult(1, "hello", { maxChars: -5 })).toBe("");
    expect(summarizeToolResult(1, "hello", { maxChars: Number.NaN })).toBe("");
  });

  it("trims trailing whitespace at the mid-line cut", () => {
    const text = `${"hello world ".repeat(200)}`;
    const out = summarizeToolResult(text.length, text, { maxChars: 50 });
    // Extract prefix (before the suffix) and assert no trailing ASCII whitespace.
    const suffix = truncationSuffix(text.length);
    expect(out.endsWith(suffix)).toBe(true);
    const prefix = out.slice(0, -suffix.length);
    expect(/\s$/.test(prefix)).toBe(false);
  });

  describe("JSON-aware cutting", () => {
    it("cuts at a balanced object boundary when one exists inside the window", () => {
      // Multiple top-level objects separated by whitespace — each is its own
      // balanced boundary at depth 0, so `findBalancedJsonCut` can pick the
      // last one within the window.
      const payload = Array.from({ length: 50 }, (_, i) => `{"i":${i}}`).join("\n");
      const out = summarizeToolResult(payload.length, payload, { maxChars: 200 });
      const suffix = truncationSuffix(payload.length);
      const prefix = out.slice(0, -suffix.length);
      // A balanced prefix ends with `}` (trailing whitespace is trimmed).
      expect(prefix.endsWith("}")).toBe(true);
    });

    it("falls back to a simple char cut when no balanced boundary is near", () => {
      const payload = `[${"X".repeat(200)}`;
      const out = summarizeToolResult(payload.length, payload, { maxChars: 50 });
      expect(out).toContain("(truncated,");
    });

    it("does not mistake non-JSON text for JSON", () => {
      const plain = "foo bar baz ".repeat(200);
      const out = summarizeToolResult(plain.length, plain, { maxChars: 30 });
      expect(out).toContain("(truncated,");
    });

    it("ignores braces inside JSON strings", () => {
      const payload = `{"description":"has } brace inside","tag":"closed"}`;
      const longer = payload.repeat(30);
      const out = summarizeToolResult(longer.length, longer, { maxChars: 60 });
      expect(out).toContain("(truncated,");
    });
  });
});
