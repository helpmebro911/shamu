import { describe, expect, it } from "bun:test";
import { canonicalizeArgs } from "../src/canonicalize.ts";

describe("canonicalizeArgs", () => {
  it("produces the same output for identical primitive inputs", () => {
    expect(canonicalizeArgs("ls -la")).toBe(canonicalizeArgs("ls -la"));
    expect(canonicalizeArgs(null)).toBe(canonicalizeArgs(null));
    expect(canonicalizeArgs(42)).toBe(canonicalizeArgs(42));
  });

  it("normalizes whitespace: collapses runs of spaces, tabs, newlines", () => {
    const a = canonicalizeArgs({ cmd: "ls    -la\n\t-h" });
    const b = canonicalizeArgs({ cmd: "ls -la -h" });
    expect(a).toBe(b);
  });

  it("produces identical output for objects with different key orderings", () => {
    const a = canonicalizeArgs({ a: 1, b: 2, c: 3 });
    const b = canonicalizeArgs({ c: 3, a: 1, b: 2 });
    expect(a).toBe(b);
  });

  it("handles deeply nested objects with sorted keys", () => {
    const a = canonicalizeArgs({ outer: { inner: { a: 1, b: 2 } } });
    const b = canonicalizeArgs({ outer: { inner: { b: 2, a: 1 } } });
    expect(a).toBe(b);
  });

  it("preserves array order — order is semantic", () => {
    const a = canonicalizeArgs(["rm", "-rf", "/"]);
    const b = canonicalizeArgs(["/", "-rf", "rm"]);
    expect(a).not.toBe(b);
  });

  it("redacts Anthropic keys so secret-bearing args hash identically after redaction", () => {
    const a = canonicalizeArgs({
      auth: "Bearer sk-ant-abc123def456ghi789jkl012mno",
    });
    const b = canonicalizeArgs({
      auth: "Bearer sk-ant-xyz987uvw654rst321qpo098nml",
    });
    expect(a).toBe(b);
    expect(a).toContain("<REDACTED:");
  });

  it("redacts OpenAI keys", () => {
    const a = canonicalizeArgs({ token: "sk-abcdef1234567890abcdef1234567890abcd" });
    expect(a).toContain("<REDACTED:");
  });

  it("redacts API_KEY assignments inline", () => {
    const a = canonicalizeArgs({ env: "OPENAI_API_KEY=topsecretvalue123" });
    expect(a).toContain("<REDACTED:");
  });

  it("produces the same output whether called once or twice", () => {
    const value = { tool: "Bash", args: { cmd: "echo hi" } };
    expect(canonicalizeArgs(value)).toBe(canonicalizeArgs(value));
  });

  it("treats undefined args as null", () => {
    expect(canonicalizeArgs(undefined)).toBe(canonicalizeArgs(null));
  });

  it("trims leading and trailing whitespace on string leaves", () => {
    const a = canonicalizeArgs("   hello   world   ");
    expect(a).toBe('"hello world"');
  });

  it("normalizes whitespace inside strings AND trims the canonical JSON", () => {
    const a = canonicalizeArgs({ s: "   hello   world   " });
    const b = canonicalizeArgs({ s: "hello world" });
    expect(a).toBe(b);
  });
});
