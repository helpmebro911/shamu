import { newEventId, newRunId, newTurnId } from "@shamu/shared/ids";
import { describe, expect, it } from "vitest";
import {
  type AgentEvent,
  checkOrderingInvariants,
  isEventOfKind,
  safeValidateEvent,
  toolCallEventsMatch,
  validateEvent,
} from "../src/events.ts";

function envelope(overrides: Partial<AgentEvent> = {}): AgentEvent {
  return {
    eventId: newEventId(),
    runId: newRunId(),
    sessionId: null,
    turnId: newTurnId(),
    parentEventId: null,
    seq: 1,
    tsMonotonic: 1,
    tsWall: 1_700_000_000_000,
    vendor: "fake",
    rawRef: null,
    kind: "session_start",
    source: "spawn",
    ...overrides,
  } as AgentEvent;
}

describe("validateEvent / safeValidateEvent", () => {
  it("validates a well-formed event", () => {
    const ev = envelope();
    expect(validateEvent(ev).kind).toBe("session_start");
  });

  it("safeValidateEvent returns err for bad input", () => {
    const r = safeValidateEvent({ bogus: true });
    expect(r.ok).toBe(false);
  });

  it("safeValidateEvent returns ok for valid input", () => {
    const r = safeValidateEvent(envelope());
    expect(r.ok).toBe(true);
  });

  it("validateEvent throws for bad input", () => {
    expect(() => validateEvent({ bogus: true })).toThrow();
  });
});

describe("isEventOfKind", () => {
  it("narrows to the right kind", () => {
    const ev = envelope({
      kind: "turn_end",
      stopReason: "end",
      durationMs: 10,
    } as Partial<AgentEvent>);
    expect(isEventOfKind(ev, "turn_end")).toBe(true);
    expect(isEventOfKind(ev, "session_end")).toBe(false);
  });
});

describe("toolCallEventsMatch", () => {
  it("matches when toolCallId and parent linkage are correct", () => {
    const callId = newEventId();
    const call = {
      ...envelope({ kind: "tool_call" } as Partial<AgentEvent>),
      eventId: callId,
      kind: "tool_call" as const,
      toolCallId: "call-1",
      tool: "Read",
      args: {},
    };
    const result = {
      ...envelope({ kind: "tool_result" } as Partial<AgentEvent>),
      kind: "tool_result" as const,
      toolCallId: "call-1",
      ok: true,
      summary: "ok",
      bytes: 2,
      parentEventId: callId,
    };
    expect(toolCallEventsMatch(call, result)).toBe(true);
  });

  it("rejects a mismatched toolCallId", () => {
    const call = {
      ...envelope({ kind: "tool_call" } as Partial<AgentEvent>),
      kind: "tool_call" as const,
      toolCallId: "a",
      tool: "r",
      args: {},
    };
    const result = {
      ...envelope({ kind: "tool_result" } as Partial<AgentEvent>),
      kind: "tool_result" as const,
      toolCallId: "b",
      ok: true,
      summary: "ok",
      bytes: 0,
      parentEventId: call.eventId,
    };
    expect(toolCallEventsMatch(call, result)).toBe(false);
  });
});

describe("checkOrderingInvariants", () => {
  const runId = newRunId();
  const turnId = newTurnId();
  function mk(
    seq: number,
    ts: number,
    kind: AgentEvent["kind"],
    extra: Partial<AgentEvent> = {},
  ): AgentEvent {
    return envelope({
      runId,
      turnId,
      seq,
      tsMonotonic: ts,
      kind,
      ...extra,
    } as Partial<AgentEvent>);
  }

  it("flags non-monotonic seq", () => {
    const events: AgentEvent[] = [
      mk(1, 1, "session_start", { source: "spawn" } as Partial<AgentEvent>),
      mk(1, 2, "assistant_delta", { text: "x" } as Partial<AgentEvent>),
    ];
    const v = checkOrderingInvariants(events);
    expect(v.some((x) => x.reason === "seq_non_monotonic")).toBe(true);
  });

  it("flags ts decreasing", () => {
    const events: AgentEvent[] = [
      mk(1, 10, "session_start", { source: "spawn" } as Partial<AgentEvent>),
      mk(2, 5, "assistant_delta", { text: "x" } as Partial<AgentEvent>),
    ];
    const v = checkOrderingInvariants(events);
    expect(v.some((x) => x.reason === "ts_monotonic_decreased")).toBe(true);
  });

  it("accepts a well-ordered stream", () => {
    const events: AgentEvent[] = [
      mk(1, 1, "session_start", { source: "spawn" } as Partial<AgentEvent>),
      mk(2, 2, "assistant_delta", { text: "hi" } as Partial<AgentEvent>),
      mk(3, 3, "turn_end", { stopReason: "end", durationMs: 1 } as Partial<AgentEvent>),
    ];
    expect(checkOrderingInvariants(events)).toEqual([]);
  });

  it("flags events re-using the turnId after turn_end", () => {
    const t1 = newTurnId();
    const eventsWithReuse: AgentEvent[] = [
      envelope({
        runId,
        turnId: t1,
        seq: 1,
        tsMonotonic: 1,
        kind: "session_start",
        source: "spawn",
      } as Partial<AgentEvent>),
      envelope({
        runId,
        turnId: t1,
        seq: 2,
        tsMonotonic: 2,
        kind: "turn_end",
        stopReason: "end",
        durationMs: 1,
      } as Partial<AgentEvent>),
      envelope({
        runId,
        turnId: t1,
        seq: 3,
        tsMonotonic: 3,
        kind: "assistant_delta",
        text: "leaked",
      } as Partial<AgentEvent>),
    ];
    const v = checkOrderingInvariants(eventsWithReuse);
    expect(v.some((x) => x.reason === "turn_event_outside_turn")).toBe(true);
  });
});
