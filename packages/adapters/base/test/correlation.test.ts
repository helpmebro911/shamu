import { newRunId, newToolCallId, sessionId as wrapSessionId } from "@shamu/shared/ids";
import { describe, expect, it } from "vitest";
import { CorrelationState, defaultClock } from "../src/correlation.ts";

describe("CorrelationState", () => {
  function mkState() {
    return new CorrelationState({ runId: newRunId(), vendor: "fake" });
  }

  it("requires a turn to be started before envelope() is called", () => {
    const c = mkState();
    expect(() => c.envelope()).toThrow();
  });

  it("monotonically increases seq across envelopes", () => {
    const c = mkState();
    c.startTurn();
    const a = c.envelope();
    const b = c.envelope();
    expect(b.seq).toBeGreaterThan(a.seq);
  });

  it("produces unique eventIds", () => {
    const c = mkState();
    c.startTurn();
    const a = c.envelope();
    const b = c.envelope();
    expect(a.eventId).not.toBe(b.eventId);
  });

  it("carries turnId through sequential envelopes", () => {
    const c = mkState();
    const tid = c.startTurn();
    const a = c.envelope();
    const b = c.envelope();
    expect(a.turnId).toBe(tid);
    expect(b.turnId).toBe(tid);
  });

  it("starts a fresh turn with a new turnId", () => {
    const c = mkState();
    const first = c.startTurn();
    c.endTurn();
    const second = c.startTurn();
    expect(second).not.toBe(first);
  });

  it("throws when envelope is called after endTurn without a new start", () => {
    const c = mkState();
    c.startTurn();
    c.envelope();
    c.endTurn();
    expect(() => c.envelope()).toThrow();
  });

  it("threads parentEventId for tool_call → tool_result", () => {
    const c = mkState();
    c.startTurn();
    const callEnv = c.envelope();
    const tcid = newToolCallId();
    c.rememberToolCall(tcid, callEnv.eventId);
    expect(c.parentForToolResult(tcid)).toBe(callEnv.eventId);
    const resultEnv = c.envelope({ parentEventId: c.parentForToolResult(tcid) });
    expect(resultEnv.parentEventId).toBe(callEnv.eventId);
  });

  it("returns null from parentForToolResult for an unknown id", () => {
    const c = mkState();
    expect(c.parentForToolResult(newToolCallId())).toBeNull();
  });

  it("bindSession updates the sessionId carried on subsequent envelopes", () => {
    const c = mkState();
    c.startTurn();
    expect(c.envelope().sessionId).toBeNull();
    c.bindSession(wrapSessionId("sess-1"));
    expect(c.envelope().sessionId).toBe("sess-1");
  });

  it("clamps tsMonotonic so it never decreases", () => {
    // Use a stub clock that regresses.
    const values = [
      { monotonic: 100, wall: 1000 },
      { monotonic: 50, wall: 800 }, // regression
      { monotonic: 75, wall: 900 },
    ];
    let i = 0;
    const clock = () => {
      const chosen = values[i] ?? values[values.length - 1];
      i += 1;
      if (!chosen) throw new Error("stub clock exhausted");
      return chosen;
    };
    const c = new CorrelationState({ runId: newRunId(), vendor: "fake", clock });
    c.startTurn();
    const a = c.envelope();
    const b = c.envelope();
    const d = c.envelope();
    expect(b.tsMonotonic).toBeGreaterThanOrEqual(a.tsMonotonic);
    expect(d.tsMonotonic).toBeGreaterThanOrEqual(b.tsMonotonic);
  });

  it("defaultClock returns finite numbers", () => {
    const { monotonic, wall } = defaultClock();
    expect(Number.isFinite(monotonic)).toBe(true);
    expect(Number.isFinite(wall)).toBe(true);
  });
});
