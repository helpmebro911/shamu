import { describe, expect, it } from "vitest";
import { AGENT_EVENT_KINDS, agentEventSchema, parseAgentEvent } from "./events.ts";
import { newEventId, newRunId, newTurnId } from "./ids.ts";

function envelope(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    eventId: newEventId(),
    runId: newRunId(),
    sessionId: null,
    turnId: newTurnId(),
    parentEventId: null,
    seq: 0,
    tsMonotonic: 0,
    tsWall: 1_700_000_000_000,
    vendor: "echo",
    rawRef: null,
    ...overrides,
  };
}

describe("AgentEvent schema", () => {
  it("parses every declared kind", () => {
    const samples: Array<Record<string, unknown>> = [
      { ...envelope(), kind: "session_start", source: "spawn" },
      { ...envelope(), kind: "session_end", reason: "ok" },
      { ...envelope(), kind: "reasoning", text: "let me think…", signature: "abc" },
      { ...envelope(), kind: "assistant_delta", text: "hi" },
      { ...envelope(), kind: "assistant_message", text: "done", stopReason: "end_turn" },
      { ...envelope(), kind: "tool_call", toolCallId: "c1", tool: "Read", args: { path: "x" } },
      {
        ...envelope(),
        kind: "tool_result",
        toolCallId: "c1",
        ok: true,
        summary: "42 bytes",
        bytes: 42,
      },
      {
        ...envelope(),
        kind: "permission_request",
        toolCallId: "c1",
        decision: "allow",
      },
      {
        ...envelope(),
        kind: "patch_applied",
        files: ["a.ts"],
        stats: { add: 1, del: 0 },
      },
      { ...envelope(), kind: "checkpoint", summary: "phase 1 done" },
      { ...envelope(), kind: "stdout", text: "hello\n" },
      { ...envelope(), kind: "stderr", text: "warn\n" },
      {
        ...envelope(),
        kind: "usage",
        model: "claude-opus",
        tokens: { input: 10, output: 20 },
        cache: { hits: 1, misses: 0 },
      },
      { ...envelope(), kind: "cost", usd: 0.01, confidence: "exact", source: "vendor" },
      {
        ...envelope(),
        kind: "rate_limit",
        scope: "five_hour",
        status: "warning",
        resetsAt: 1_700_005_000_000,
      },
      {
        ...envelope(),
        kind: "interrupt",
        requestedBy: "user",
        delivered: true,
      },
      { ...envelope(), kind: "turn_end", stopReason: "end_turn", durationMs: 1234 },
      {
        ...envelope(),
        kind: "error",
        fatal: false,
        errorCode: "timeout",
        message: "retrying",
        retriable: true,
      },
    ];
    for (const s of samples) {
      const parsed = parseAgentEvent(s);
      expect(parsed.kind).toBe(s.kind);
    }
    expect(samples).toHaveLength(AGENT_EVENT_KINDS.length);
  });

  it("round-trips through JSON identically", () => {
    const input = {
      ...envelope(),
      kind: "tool_call" as const,
      toolCallId: "c1",
      tool: "Read",
      args: { path: "a.ts", offset: 0 },
    };
    const parsed = agentEventSchema.parse(input);
    const json = JSON.stringify(parsed);
    const reparsed = agentEventSchema.parse(JSON.parse(json));
    expect(JSON.stringify(reparsed)).toBe(json);
  });

  it("rejects an event missing kind", () => {
    expect(() => agentEventSchema.parse(envelope())).toThrow();
  });

  it("rejects an event with an unknown kind", () => {
    expect(() => agentEventSchema.parse({ ...envelope(), kind: "does_not_exist" })).toThrow();
  });

  it("rejects an event missing required envelope fields", () => {
    const bad = { ...envelope(), kind: "checkpoint", summary: "x" };
    delete (bad as Record<string, unknown>).runId;
    expect(() => agentEventSchema.parse(bad)).toThrow();
  });
});
