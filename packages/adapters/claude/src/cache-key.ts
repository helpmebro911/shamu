// Composes the Claude prompt-cache prefix. `runId` is load-bearing: per
// T9 (threat model) two runs with different system prompts must NOT share a
// cache hit. We salt the prefix with runId so the SDK-visible hash differs
// whenever the orchestrator-assigned id does, and we also hash the system
// prompt + MCP server fingerprint so a mid-flight prompt delta invalidates
// the prefix even on a single run.
//
// The value is opaque to downstream callers — they pass it through to Claude
// via `extraArgs` (as a custom cache-salt flag) or via a deterministic
// prefix token injected into the system prompt. The exact wire format is
// not what the contract test asserts; the invariant is:
//   same inputs => same key; any input change => different key.

import { createHash } from "node:crypto";

export interface CacheKeyInputs {
  /** Orchestrator-owned run id. Required. */
  readonly runId: string;
  /** Hash of the effective system prompt for this spawn. Required. */
  readonly systemPromptHash: string;
  /**
   * Hash of the serialized MCP server config (in-process instance shape
   * flattened to a stable JSON). Optional — adapters that don't inject MCP
   * pass undefined; that hash contributes `"none"` to the prefix.
   */
  readonly mcpServerHash?: string;
  /**
   * Optional model id. Included so swapping models mid-session invalidates
   * the cache (different token tables, different priming).
   */
  readonly model?: string;
}

/** Stable SHA-256 hex hash of an arbitrary string. */
export function hashString(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Hash a canonicalizable MCP server config. Accepts the in-process SDK MCP
 * config (has a live `instance` field that's not stringifiable) so we hash
 * the `name` + tool names; callers that provide `undefined` get a stable
 * sentinel hash.
 */
export function hashMcpServer(config: unknown): string {
  if (!config || typeof config !== "object") return hashString("mcp:none");
  const c = config as { name?: unknown; type?: unknown; instance?: unknown };
  const name = typeof c.name === "string" ? c.name : "";
  const type = typeof c.type === "string" ? c.type : "";
  // Best-effort: extract tool names from `.instance._registeredTools`. The
  // exact shape is internal to the MCP server class; if it's absent we
  // still produce a stable hash from name+type.
  let toolList = "";
  const inst = c.instance as { _registeredTools?: Record<string, unknown> } | undefined;
  if (inst?._registeredTools && typeof inst._registeredTools === "object") {
    toolList = Object.keys(inst._registeredTools).sort().join(",");
  }
  return hashString(`mcp:${type}:${name}:${toolList}`);
}

/**
 * Compose the cache prefix. Same `{runId, systemPromptHash, mcpServerHash,
 * model}` tuple always yields the same string; any field change yields a
 * different string.
 *
 * The format is stable across releases — downstream tests assert this.
 */
export function composeCacheKey(inputs: CacheKeyInputs): string {
  const { runId, systemPromptHash, mcpServerHash, model } = inputs;
  if (typeof runId !== "string" || runId.length === 0) {
    throw new TypeError("composeCacheKey: runId must be a non-empty string");
  }
  if (typeof systemPromptHash !== "string" || systemPromptHash.length === 0) {
    throw new TypeError("composeCacheKey: systemPromptHash must be a non-empty string");
  }
  const mcp = mcpServerHash ?? hashString("mcp:none");
  const modelTag = model && model.length > 0 ? model : "default";
  // Deterministic joiner. The outer hash collapses the tuple to 64 hex
  // chars so the SDK-visible salt is small but unique.
  const joined = `shamu-cache:v1:run=${runId};sys=${systemPromptHash};mcp=${mcp};model=${modelTag}`;
  return hashString(joined);
}
