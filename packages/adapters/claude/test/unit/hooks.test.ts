// Unit tests for the Claude → AgentEvent projector. Drives the function
// with hand-built payloads that mirror the 0.B fixtures — no SDK needed.

import { CorrelationState } from "@shamu/adapters-base";
import { newRunId } from "@shamu/shared/ids";
import { Redactor } from "@shamu/shared/redactor";
import { describe, expect, it } from "vitest";
import {
  type ClaudeRaw,
  type ProjectOptions,
  projectClaudeHook,
  projectClaudeMessage,
} from "../../src/hooks.ts";

function buildOptions(): ProjectOptions & { readonly corr: CorrelationState } {
  const corr = new CorrelationState({ runId: newRunId(), vendor: "claude" });
  corr.startTurn();
  return {
    corr,
    redactor: new Redactor(),
    currentModel: "claude-opus-4-7",
    onToolCall: () => {},
    parentForToolResult: () => null,
  };
}

describe("projectClaudeMessage — system:init", () => {
  it("binds the session id and emits no events", () => {
    const opts = buildOptions();
    let bound: string | null = null;
    const events = projectClaudeMessage(
      { type: "system", subtype: "init", session_id: "sess-123" } as ClaudeRaw,
      { ...opts, onSessionId: (sid) => (bound = sid) },
    );
    expect(events).toEqual([]);
    expect(bound).toBe("sess-123");
  });

  it("drops hook_started / hook_response system frames", () => {
    const opts = buildOptions();
    expect(
      projectClaudeMessage({ type: "system", subtype: "hook_started" } as ClaudeRaw, opts),
    ).toEqual([]);
    expect(
      projectClaudeMessage({ type: "system", subtype: "hook_response" } as ClaudeRaw, opts),
    ).toEqual([]);
  });
});

describe("projectClaudeMessage — assistant content blocks", () => {
  it("emits assistant_message from a text block", () => {
    const opts = buildOptions();
    const events = projectClaudeMessage(
      {
        type: "assistant",
        message: {
          stop_reason: "end_turn",
          content: [{ type: "text", text: "hello world" }],
        },
      } as ClaudeRaw,
      opts,
    );
    expect(events).toHaveLength(1);
    const ev = events[0];
    if (!ev || ev.kind !== "assistant_message") throw new Error("expected assistant_message");
    expect(ev.text).toBe("hello world");
    expect(ev.stopReason).toBe("end_turn");
  });

  it("emits tool_call from a tool_use block and threads the event id via onToolCall", () => {
    const opts = buildOptions();
    const seen: Array<{ id: string; evId: string }> = [];
    const events = projectClaudeMessage(
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "tool_1",
              name: "Read",
              input: { file_path: "README.md" },
            },
          ],
        },
      } as ClaudeRaw,
      { ...opts, onToolCall: (id, evId) => seen.push({ id, evId }) },
    );
    expect(events).toHaveLength(1);
    const ev = events[0];
    if (!ev || ev.kind !== "tool_call") throw new Error("expected tool_call");
    expect(ev.tool).toBe("Read");
    expect(ev.toolCallId).toBe("tool_1");
    expect(seen).toEqual([{ id: "tool_1", evId: ev.eventId }]);
  });

  it("emits reasoning for a thinking block (carries signature when present)", () => {
    const opts = buildOptions();
    const events = projectClaudeMessage(
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "thinking",
              thinking: "stepwise analysis",
              signature: "abc123",
            },
          ],
        },
      } as ClaudeRaw,
      opts,
    );
    // Content only has a thinking block — projector emits reasoning only;
    // `anyEmitted` is true so the empty assistant_message fallback is NOT
    // added.
    expect(events).toHaveLength(1);
    const reasoning = events[0];
    if (!reasoning || reasoning.kind !== "reasoning") throw new Error("expected reasoning");
    expect(reasoning.text).toBe("stepwise analysis");
    expect(reasoning.signature).toBe("abc123");
  });

  it("threads the redactor across assistant text", () => {
    const opts = buildOptions();
    const events = projectClaudeMessage(
      {
        type: "assistant",
        message: {
          stop_reason: "end_turn",
          content: [{ type: "text", text: "key=sk-ant-FAKE-FIXTURE-aAbBcCdDeEfFgGhHiI123456" }],
        },
      } as ClaudeRaw,
      opts,
    );
    const ev = events[0];
    if (!ev || ev.kind !== "assistant_message") throw new Error("expected assistant_message");
    expect(ev.text).not.toContain("sk-ant-FAKE");
    expect(ev.text).toContain("<REDACTED:");
  });
});

describe("projectClaudeMessage — user tool_result blocks", () => {
  it("resolves the parent via parentForToolResult", () => {
    const opts = buildOptions();
    const events = projectClaudeMessage(
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool_42",
              content: "file contents here",
            },
          ],
        },
      } as ClaudeRaw,
      { ...opts, parentForToolResult: (id) => (id === "tool_42" ? ("evt_parent" as never) : null) },
    );
    expect(events).toHaveLength(1);
    const ev = events[0];
    if (!ev || ev.kind !== "tool_result") throw new Error("expected tool_result");
    expect(ev.toolCallId).toBe("tool_42");
    expect(ev.ok).toBe(true);
    expect(ev.summary).toBe("file contents here");
    expect(ev.bytes).toBe(18);
    expect(ev.parentEventId).toBe("evt_parent");
  });

  it("drops user-role text blocks (orchestrator echo)", () => {
    const opts = buildOptions();
    const events = projectClaudeMessage(
      {
        type: "user",
        message: { content: [{ type: "text", text: "ignored echo" }] },
      } as ClaudeRaw,
      opts,
    );
    expect(events).toEqual([]);
  });

  it("marks tool_result.ok=false when is_error is true", () => {
    const opts = buildOptions();
    const events = projectClaudeMessage(
      {
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "t", is_error: true, content: "boom" }],
        },
      } as ClaudeRaw,
      opts,
    );
    const ev = events[0];
    if (!ev || ev.kind !== "tool_result") throw new Error("expected tool_result");
    expect(ev.ok).toBe(false);
  });
});

describe("projectClaudeMessage — rate_limit_event", () => {
  it("maps five_hour/allowed_warning to five_hour/warning", () => {
    const opts = buildOptions();
    const events = projectClaudeMessage(
      {
        type: "rate_limit_event",
        rate_limit_info: {
          status: "allowed_warning",
          rateLimitType: "five_hour",
          resetsAt: 1_700_000_000,
        },
      } as ClaudeRaw,
      opts,
    );
    const ev = events[0];
    if (!ev || ev.kind !== "rate_limit") throw new Error("expected rate_limit");
    expect(ev.scope).toBe("five_hour");
    expect(ev.status).toBe("warning");
    expect(ev.resetsAt).toBe(1_700_000_000);
  });

  it("collapses seven_day variants to scope=day", () => {
    const opts = buildOptions();
    const events = projectClaudeMessage(
      {
        type: "rate_limit_event",
        rate_limit_info: {
          status: "rejected",
          rateLimitType: "seven_day_sonnet",
        },
      } as ClaudeRaw,
      opts,
    );
    const ev = events[0];
    if (!ev || ev.kind !== "rate_limit") throw new Error("expected rate_limit");
    expect(ev.scope).toBe("day");
    expect(ev.status).toBe("exhausted");
    expect(ev.resetsAt).toBe(null);
  });
});

describe("projectClaudeMessage — terminal result", () => {
  it("emits usage + cost + turn_end and flags turn terminal", () => {
    const opts = buildOptions();
    let terminated = false;
    const events = projectClaudeMessage(
      {
        type: "result",
        subtype: "success",
        duration_ms: 1234,
        total_cost_usd: 0.042,
        model: "claude-opus-4-7",
        usage: {
          input_tokens: 10,
          output_tokens: 20,
          cache_read_input_tokens: 5,
          cache_creation_input_tokens: 7,
        },
      } as ClaudeRaw,
      { ...opts, onTurnTerminal: () => (terminated = true) },
    );
    expect(events.map((e) => e.kind)).toEqual(["usage", "cost", "turn_end"]);
    const usage = events[0];
    if (!usage || usage.kind !== "usage") throw new Error("expected usage");
    expect(usage.tokens).toEqual({
      input: 10,
      output: 20,
      cacheRead: 5,
      cacheCreation: 7,
    });
    expect(usage.cache).toEqual({ hits: 5, misses: 10 });
    const cost = events[1];
    if (!cost || cost.kind !== "cost") throw new Error("expected cost");
    expect(cost.usd).toBe(0.042);
    expect(cost.confidence).toBe("exact");
    expect(cost.source).toBe("vendor");
    expect(terminated).toBe(true);
  });

  it("emits an error event on non-success result subtype", () => {
    const opts = buildOptions();
    const events = projectClaudeMessage(
      {
        type: "result",
        subtype: "error_max_turns",
        duration_ms: 100,
        total_cost_usd: 0.01,
        usage: { input_tokens: 1, output_tokens: 1 },
      } as ClaudeRaw,
      opts,
    );
    // usage, cost, error BEFORE turn_end so consumers draining-to-turn_end
    // still observe the error.
    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual(["usage", "cost", "error", "turn_end"]);
    const err = events[2];
    if (!err || err.kind !== "error") throw new Error("expected error");
    expect(err.errorCode).toBe("error_max_turns");
    expect(err.fatal).toBe(true);
  });
});

describe("projectClaudeMessage — stream_event", () => {
  it("maps partial-assistant delta to assistant_delta", () => {
    const opts = buildOptions();
    const events = projectClaudeMessage(
      {
        type: "stream_event",
        event: { delta: { type: "text_delta", text: "partial" } },
      } as ClaudeRaw,
      opts,
    );
    const ev = events[0];
    if (!ev || ev.kind !== "assistant_delta") throw new Error("expected assistant_delta");
    expect(ev.text).toBe("partial");
  });
});

describe("projectClaudeHook", () => {
  it("SessionStart emits session_start when expectSessionStartEmission=true", () => {
    const corr = new CorrelationState({ runId: newRunId(), vendor: "claude" });
    corr.startTurn();
    const events = projectClaudeHook(
      {
        hook_event_name: "SessionStart",
        source: "resume",
        session_id: "sess-1",
      },
      { corr, redactor: new Redactor(), expectSessionStartEmission: true },
    );
    expect(events).toHaveLength(1);
    const ev = events[0];
    if (!ev || ev.kind !== "session_start") throw new Error("expected session_start");
    expect(ev.source).toBe("resume");
  });

  it("SessionStart is a no-op when expectSessionStartEmission=false", () => {
    const corr = new CorrelationState({ runId: newRunId(), vendor: "claude" });
    corr.startTurn();
    const events = projectClaudeHook(
      { hook_event_name: "SessionStart", source: "startup", session_id: "s" },
      { corr, redactor: new Redactor(), expectSessionStartEmission: false },
    );
    expect(events).toEqual([]);
  });

  it("Stop hook emits a checkpoint with redacted summary", () => {
    const corr = new CorrelationState({ runId: newRunId(), vendor: "claude" });
    corr.startTurn();
    const events = projectClaudeHook(
      {
        hook_event_name: "Stop",
        stop_hook_active: false,
        last_assistant_message: "key=sk-ant-FAKE-FIXTURE-aAbBcCdDeEfFgGhHiI123456 done",
        session_id: "s",
      },
      { corr, redactor: new Redactor(), expectSessionStartEmission: false },
    );
    expect(events).toHaveLength(1);
    const ev = events[0];
    if (!ev || ev.kind !== "checkpoint") throw new Error("expected checkpoint");
    expect(ev.summary).not.toContain("sk-ant-FAKE");
  });

  it("PreToolUse / PostToolUse are no-ops (handled by the SDKMessage stream)", () => {
    const corr = new CorrelationState({ runId: newRunId(), vendor: "claude" });
    corr.startTurn();
    const pre = projectClaudeHook(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        tool_input: { file_path: "x" },
        tool_use_id: "t",
        session_id: "s",
      },
      { corr, redactor: new Redactor(), expectSessionStartEmission: false },
    );
    const post = projectClaudeHook(
      {
        hook_event_name: "PostToolUse",
        tool_name: "Read",
        tool_input: {},
        tool_response: {},
        tool_use_id: "t",
        session_id: "s",
      },
      { corr, redactor: new Redactor(), expectSessionStartEmission: false },
    );
    expect(pre).toEqual([]);
    expect(post).toEqual([]);
  });
});
