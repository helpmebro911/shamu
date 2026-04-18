// T9 contract: the cache-key composition must include runId + system
// prompt; any change invalidates the key. Tested at the pure-module
// boundary so the assertion is independent of SDK behavior.

import { describe, expect, it } from "vitest";
import { composeCacheKey, hashMcpServer, hashString } from "../../src/cache-key.ts";

describe("hashString", () => {
  it("is deterministic for identical inputs", () => {
    expect(hashString("abc")).toBe(hashString("abc"));
  });
  it("produces different hashes for different inputs", () => {
    expect(hashString("abc")).not.toBe(hashString("abcd"));
  });
});

describe("composeCacheKey — determinism", () => {
  it("same inputs → same key", () => {
    const a = composeCacheKey({
      runId: "run-1",
      systemPromptHash: hashString("sp"),
      model: "claude-opus-4-7",
    });
    const b = composeCacheKey({
      runId: "run-1",
      systemPromptHash: hashString("sp"),
      model: "claude-opus-4-7",
    });
    expect(a).toBe(b);
  });
});

describe("composeCacheKey — T9 invariants", () => {
  it("different runIds → different keys (even for identical prompts)", () => {
    const a = composeCacheKey({
      runId: "run-A",
      systemPromptHash: hashString("you are a helpful assistant"),
    });
    const b = composeCacheKey({
      runId: "run-B",
      systemPromptHash: hashString("you are a helpful assistant"),
    });
    expect(a).not.toBe(b);
  });

  it("one-word system-prompt delta invalidates the cache key", () => {
    const base = "you are a helpful assistant that writes code.";
    const altered = "you are a careful assistant that writes code.";
    const a = composeCacheKey({
      runId: "run-same",
      systemPromptHash: hashString(base),
    });
    const b = composeCacheKey({
      runId: "run-same",
      systemPromptHash: hashString(altered),
    });
    expect(a).not.toBe(b);
  });

  it("MCP server fingerprint change invalidates the cache key", () => {
    const a = composeCacheKey({
      runId: "run-same",
      systemPromptHash: hashString("sp"),
      mcpServerHash: hashString("mcp-a"),
    });
    const b = composeCacheKey({
      runId: "run-same",
      systemPromptHash: hashString("sp"),
      mcpServerHash: hashString("mcp-b"),
    });
    expect(a).not.toBe(b);
  });

  it("model change invalidates the cache key", () => {
    const a = composeCacheKey({
      runId: "run-same",
      systemPromptHash: hashString("sp"),
      model: "claude-opus-4-7",
    });
    const b = composeCacheKey({
      runId: "run-same",
      systemPromptHash: hashString("sp"),
      model: "claude-sonnet-4-6",
    });
    expect(a).not.toBe(b);
  });

  it("rejects empty runId", () => {
    expect(() => composeCacheKey({ runId: "", systemPromptHash: "x" })).toThrow(/runId/);
  });

  it("rejects empty systemPromptHash", () => {
    expect(() => composeCacheKey({ runId: "r", systemPromptHash: "" })).toThrow(/systemPromptHash/);
  });
});

describe("hashMcpServer", () => {
  it("returns the stable 'mcp:none' hash for undefined/null input", () => {
    const expected = hashString("mcp:none");
    expect(hashMcpServer(undefined)).toBe(expected);
    expect(hashMcpServer(null)).toBe(expected);
  });

  it("produces different hashes when the server name differs", () => {
    const a = hashMcpServer({ type: "sdk", name: "alpha", instance: {} });
    const b = hashMcpServer({ type: "sdk", name: "beta", instance: {} });
    expect(a).not.toBe(b);
  });

  it("incorporates registered tool names from the instance", () => {
    const a = hashMcpServer({
      type: "sdk",
      name: "same",
      instance: { _registeredTools: { tool_a: {}, tool_b: {} } },
    });
    const b = hashMcpServer({
      type: "sdk",
      name: "same",
      instance: { _registeredTools: { tool_a: {}, tool_c: {} } },
    });
    expect(a).not.toBe(b);
  });
});
