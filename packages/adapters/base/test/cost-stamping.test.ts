/**
 * T17 contract: the core is authoritative about cost confidence + source.
 *
 * A compromised adapter that emits `confidence: "exact"` on a capability
 * that says `costReporting: "subscription"` must have those fields
 * overridden by the core's stamping helper. These tests pin that invariant
 * independent of any CLI or supervisor wiring — the helper is pure.
 */

import type { AgentEvent } from "@shamu/shared/events";
import type { EventId, RunId, SessionId, TurnId } from "@shamu/shared/ids";
import { describe, expect, it } from "vitest";
import { stampCostEventFromCapability } from "../src/cost-stamping.ts";

function costEvent(overrides: Partial<Extract<AgentEvent, { kind: "cost" }>>): AgentEvent {
  return {
    eventId: "01HZZZZZZZZZZZZZZZZZZZZZZZ" as EventId,
    runId: "run-test" as RunId,
    sessionId: "sess-test" as SessionId,
    turnId: "turn-test" as TurnId,
    parentEventId: null,
    seq: 1,
    tsMonotonic: 1,
    tsWall: 1,
    vendor: "test",
    rawRef: null,
    kind: "cost",
    usd: 0.01,
    confidence: "exact",
    source: "vendor",
    ...overrides,
  };
}

describe("stampCostEventFromCapability", () => {
  it("native: keeps usd; forces confidence=exact + source=vendor", () => {
    const input = costEvent({ usd: 0.25, confidence: "unknown", source: "other" });
    const stamped = stampCostEventFromCapability(input, "native");
    expect(stamped.kind).toBe("cost");
    if (stamped.kind === "cost") {
      expect(stamped.usd).toBe(0.25);
      expect(stamped.confidence).toBe("exact");
      expect(stamped.source).toBe("vendor");
    }
  });

  it("computed: keeps usd; forces confidence=estimate + source=computed", () => {
    const input = costEvent({ usd: 0.04, confidence: "exact", source: "vendor" });
    const stamped = stampCostEventFromCapability(input, "computed");
    if (stamped.kind === "cost") {
      expect(stamped.usd).toBe(0.04);
      expect(stamped.confidence).toBe("estimate");
      expect(stamped.source).toBe("computed");
    }
  });

  it("T17: overrides a compromised adapter that forges exact on subscription", () => {
    // Adversarial adapter emits a fabricated exact-cost event on a
    // subscription-only capability. Core MUST override.
    const forged = costEvent({
      usd: 42.5,
      confidence: "exact",
      source: "vendor",
    });
    const stamped = stampCostEventFromCapability(forged, "subscription");
    if (stamped.kind === "cost") {
      expect(stamped.usd).toBeNull();
      expect(stamped.confidence).toBe("unknown");
      expect(stamped.source).toBe("subscription");
    }
  });

  it("unknown: clobbers usd to null + sets unknown/unknown", () => {
    const input = costEvent({ usd: 0.5, confidence: "exact", source: "vendor" });
    const stamped = stampCostEventFromCapability(input, "unknown");
    if (stamped.kind === "cost") {
      expect(stamped.usd).toBeNull();
      expect(stamped.confidence).toBe("unknown");
      expect(stamped.source).toBe("unknown");
    }
  });

  it("passes through non-cost events unchanged", () => {
    const nonCost: AgentEvent = {
      eventId: "01HZZZZZZZZZZZZZZZZZZZZZZZ" as EventId,
      runId: "run-test" as RunId,
      sessionId: "sess-test" as SessionId,
      turnId: "turn-test" as TurnId,
      parentEventId: null,
      seq: 1,
      tsMonotonic: 1,
      tsWall: 1,
      vendor: "test",
      rawRef: null,
      kind: "checkpoint",
      summary: "hello",
    };
    expect(stampCostEventFromCapability(nonCost, "subscription")).toBe(nonCost);
  });

  it("preserves all envelope fields (eventId, seq, parentEventId, ...)", () => {
    const input = costEvent({
      eventId: "01ZZZZZZZZZZZZZZZZZZZZZZZZ" as EventId,
      seq: 42,
      parentEventId: "01YYYYYYYYYYYYYYYYYYYYYYYY" as EventId,
    });
    const stamped = stampCostEventFromCapability(input, "native");
    expect(stamped.eventId).toBe(input.eventId);
    expect(stamped.seq).toBe(42);
    expect(stamped.parentEventId).toBe(input.parentEventId);
  });
});
