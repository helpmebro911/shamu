import { describe, expect, it } from "bun:test";
import { newRunId, type RunId } from "@shamu/shared/ids";
import { AgreementBuffer } from "../src/agreement.ts";
import type { Confidence, Observation, SignalKind } from "../src/types.ts";

function obs(signal: SignalKind, runId: RunId, confidence: Confidence, at: number): Observation {
  return {
    signal,
    runId,
    vendor: "claude",
    role: null,
    confidence,
    at,
    reason: `synthetic ${signal}`,
    detail: {},
  };
}

describe("AgreementBuffer", () => {
  it("two signals at medium agree → alert", () => {
    const buf = new AgreementBuffer({ windowMs: 60_000 });
    const runId = newRunId();
    const first = buf.ingest(obs("checkpoint_lag", runId, "medium", 1_000));
    expect(first.hint?.kind).toBe("watchdog.hint");
    expect(first.alert).toBeNull();
    const second = buf.ingest(obs("tool_loop", runId, "medium", 2_000));
    expect(second.hint?.kind).toBe("watchdog.hint");
    expect(second.alert?.kind).toBe("watchdog.alert");
    expect(second.alert?.signals).toEqual(["checkpoint_lag", "tool_loop"]);
    expect(second.alert?.confidence).toBe("medium");
  });

  it("two signals at high promote with confidence high", () => {
    const buf = new AgreementBuffer({ windowMs: 60_000 });
    const runId = newRunId();
    buf.ingest(obs("checkpoint_lag", runId, "high", 1_000));
    const second = buf.ingest(obs("tool_loop", runId, "high", 2_000));
    expect(second.alert?.confidence).toBe("high");
  });

  it("mix of medium and high promotes at high", () => {
    const buf = new AgreementBuffer({ windowMs: 60_000 });
    const runId = newRunId();
    buf.ingest(obs("checkpoint_lag", runId, "medium", 1_000));
    const second = buf.ingest(obs("tool_loop", runId, "high", 2_000));
    expect(second.alert?.confidence).toBe("high");
  });

  it("single signal — hint only, no alert", () => {
    const buf = new AgreementBuffer({ windowMs: 60_000 });
    const runId = newRunId();
    const result = buf.ingest(obs("tool_loop", runId, "medium", 1_000));
    expect(result.hint?.kind).toBe("watchdog.hint");
    expect(result.alert).toBeNull();
  });

  it("unknown + medium on different signals → hint only, no alert", () => {
    const buf = new AgreementBuffer({ windowMs: 60_000 });
    const runId = newRunId();
    buf.ingest(obs("checkpoint_lag", runId, "unknown", 1_000));
    const second = buf.ingest(obs("tool_loop", runId, "medium", 2_000));
    expect(second.hint?.kind).toBe("watchdog.hint");
    expect(second.alert).toBeNull();
  });

  it("low + medium on different signals → hint only, no alert", () => {
    const buf = new AgreementBuffer({ windowMs: 60_000 });
    const runId = newRunId();
    buf.ingest(obs("no_write_activity", runId, "low", 1_000));
    const second = buf.ingest(obs("cost_velocity", runId, "medium", 2_000));
    expect(second.alert).toBeNull();
  });

  it("same signal twice — not an agreement", () => {
    const buf = new AgreementBuffer({ windowMs: 60_000 });
    const runId = newRunId();
    buf.ingest(obs("tool_loop", runId, "medium", 1_000));
    const second = buf.ingest(obs("tool_loop", runId, "medium", 2_000));
    expect(second.alert).toBeNull();
  });

  it("different runs — observations do not cross-agree", () => {
    const buf = new AgreementBuffer({ windowMs: 60_000 });
    const runA = newRunId();
    const runB = newRunId();
    buf.ingest(obs("checkpoint_lag", runA, "medium", 1_000));
    const second = buf.ingest(obs("tool_loop", runB, "medium", 2_000));
    expect(second.alert).toBeNull();
  });

  it("window expiry drops stale observations before pairing", () => {
    const buf = new AgreementBuffer({ windowMs: 5_000 });
    const runId = newRunId();
    buf.ingest(obs("checkpoint_lag", runId, "medium", 1_000));
    // Second observation arrives long after the window closed — the
    // first should have aged out and no alert should fire.
    const second = buf.ingest(obs("tool_loop", runId, "medium", 100_000));
    expect(second.alert).toBeNull();
  });

  it("does not re-alert on the same signal pair without intervening expiry", () => {
    const buf = new AgreementBuffer({ windowMs: 60_000 });
    const runId = newRunId();
    buf.ingest(obs("checkpoint_lag", runId, "medium", 1_000));
    const second = buf.ingest(obs("tool_loop", runId, "medium", 2_000));
    expect(second.alert?.kind).toBe("watchdog.alert");
    const third = buf.ingest(obs("tool_loop", runId, "medium", 3_000));
    expect(third.alert).toBeNull();
    const fourth = buf.ingest(obs("checkpoint_lag", runId, "medium", 4_000));
    expect(fourth.alert).toBeNull();
  });

  it("re-alerts after contributing observation ages out", () => {
    const buf = new AgreementBuffer({ windowMs: 10_000 });
    const runId = newRunId();
    buf.ingest(obs("checkpoint_lag", runId, "medium", 1_000));
    const second = buf.ingest(obs("tool_loop", runId, "medium", 2_000));
    expect(second.alert?.kind).toBe("watchdog.alert");
    // Advance well past window so both age out, then re-trigger.
    const third = buf.ingest(obs("checkpoint_lag", runId, "medium", 20_000));
    expect(third.alert).toBeNull();
    const fourth = buf.ingest(obs("tool_loop", runId, "medium", 21_000));
    expect(fourth.alert?.kind).toBe("watchdog.alert");
  });

  it("sweep() clears empty buckets", () => {
    const buf = new AgreementBuffer({ windowMs: 5_000 });
    const runId = newRunId();
    buf.ingest(obs("tool_loop", runId, "medium", 1_000));
    expect(buf.sizeRuns()).toBe(1);
    buf.sweep(100_000);
    expect(buf.sizeRuns()).toBe(0);
  });

  it("rejects non-positive windowMs", () => {
    expect(() => new AgreementBuffer({ windowMs: 0 })).toThrow(TypeError);
    expect(() => new AgreementBuffer({ windowMs: -1 })).toThrow(TypeError);
  });

  it("alert observations are ordered by signal name alphabetically", () => {
    const buf = new AgreementBuffer({ windowMs: 60_000 });
    const runId = newRunId();
    buf.ingest(obs("tool_loop", runId, "medium", 1_000));
    const second = buf.ingest(obs("checkpoint_lag", runId, "medium", 2_000));
    // signals must be sorted
    expect(second.alert?.signals).toEqual(["checkpoint_lag", "tool_loop"]);
    // observations must align with signals positionally
    expect(second.alert?.observations[0]?.signal).toBe("checkpoint_lag");
    expect(second.alert?.observations[1]?.signal).toBe("tool_loop");
  });
});
