import { describe, expect, it } from "bun:test";
import { newRunId } from "@shamu/shared/ids";
import { createCiTripwire } from "../src/ci-tripwire.ts";
import type { WatchdogEmitter, WatchdogEvent } from "../src/events.ts";
import type { WatchdogCiTripwire } from "../src/types.ts";

interface Sink {
  readonly events: WatchdogEvent[];
  readonly tripwires: WatchdogCiTripwire[];
  readonly emitter: WatchdogEmitter;
}

function makeSink(): Sink {
  const events: WatchdogEvent[] = [];
  const tripwires: WatchdogCiTripwire[] = [];
  const emitter: WatchdogEmitter = {
    emit(event) {
      events.push(event);
    },
    emitCiTripwire(event) {
      tripwires.push(event);
    },
  };
  return { events, tripwires, emitter };
}

describe("createCiTripwire", () => {
  it("fires once after three consecutive reds for one role (threshold + reset)", () => {
    const sink = makeSink();
    const tripwire = createCiTripwire({ emitter: sink.emitter });
    const runA = newRunId();
    const runB = newRunId();
    const runC = newRunId();
    tripwire.observe({ role: "executor", status: "red", runId: runA, at: 1_000 });
    expect(sink.tripwires).toHaveLength(0);
    tripwire.observe({ role: "executor", status: "red", runId: runB, at: 2_000 });
    expect(sink.tripwires).toHaveLength(0);
    tripwire.observe({ role: "executor", status: "red", runId: runC, at: 3_000 });
    expect(sink.tripwires).toHaveLength(1);
    const fired = sink.tripwires[0];
    expect(fired?.kind).toBe("watchdog.ci_tripwire");
    expect(fired?.role).toBe("executor");
    expect(fired?.threshold).toBe(3);
    expect(fired?.at).toBe(3_000);
    expect(fired?.runIds).toEqual([runA, runB, runC]);
    // Counter should have reset — snapshot no longer tracks the role's streak.
    expect(tripwire.snapshot().executor?.count ?? 0).toBe(0);
  });

  it("re-firing requires another full threshold cycle", () => {
    const sink = makeSink();
    const tripwire = createCiTripwire({ emitter: sink.emitter });
    const reds = [newRunId(), newRunId(), newRunId(), newRunId()];
    for (let i = 0; i < reds.length; i++) {
      const runId = reds[i];
      if (!runId) continue;
      tripwire.observe({ role: "executor", status: "red", runId, at: (i + 1) * 1_000 });
    }
    // Only one fire after the first 3 reds; the 4th red starts a new streak.
    expect(sink.tripwires).toHaveLength(1);
    expect(tripwire.snapshot().executor?.count).toBe(1);
    // Two more reds → second fire.
    tripwire.observe({ role: "executor", status: "red", runId: newRunId(), at: 5_000 });
    tripwire.observe({ role: "executor", status: "red", runId: newRunId(), at: 6_000 });
    expect(sink.tripwires).toHaveLength(2);
  });

  it("green resets the counter", () => {
    const sink = makeSink();
    const tripwire = createCiTripwire({ emitter: sink.emitter });
    tripwire.observe({ role: "executor", status: "red", runId: newRunId(), at: 1_000 });
    tripwire.observe({ role: "executor", status: "red", runId: newRunId(), at: 2_000 });
    tripwire.observe({ role: "executor", status: "green", runId: newRunId(), at: 3_000 });
    expect(tripwire.snapshot().executor?.count ?? 0).toBe(0);
    // Next red starts at 1, not 3.
    tripwire.observe({ role: "executor", status: "red", runId: newRunId(), at: 4_000 });
    expect(tripwire.snapshot().executor?.count).toBe(1);
    expect(sink.tripwires).toHaveLength(0);
  });

  it("counters are independent per role", () => {
    const sink = makeSink();
    const tripwire = createCiTripwire({ emitter: sink.emitter });
    tripwire.observe({ role: "executor", status: "red", runId: newRunId(), at: 1_000 });
    tripwire.observe({ role: "planner", status: "red", runId: newRunId(), at: 1_100 });
    tripwire.observe({ role: "executor", status: "red", runId: newRunId(), at: 2_000 });
    tripwire.observe({ role: "planner", status: "red", runId: newRunId(), at: 2_100 });
    expect(sink.tripwires).toHaveLength(0);
    expect(tripwire.snapshot().executor?.count).toBe(2);
    expect(tripwire.snapshot().planner?.count).toBe(2);
    // Third red for executor only — planner counter untouched.
    tripwire.observe({ role: "executor", status: "red", runId: newRunId(), at: 3_000 });
    expect(sink.tripwires).toHaveLength(1);
    expect(sink.tripwires[0]?.role).toBe("executor");
    expect(tripwire.snapshot().planner?.count).toBe(2);
  });

  it("unknown status is ignored (no increment, no reset)", () => {
    const sink = makeSink();
    const tripwire = createCiTripwire({ emitter: sink.emitter });
    tripwire.observe({ role: "executor", status: "red", runId: newRunId(), at: 1_000 });
    tripwire.observe({ role: "executor", status: "unknown", runId: newRunId(), at: 1_500 });
    expect(tripwire.snapshot().executor?.count).toBe(1);
    tripwire.observe({ role: "executor", status: "red", runId: newRunId(), at: 2_000 });
    tripwire.observe({ role: "executor", status: "unknown", runId: newRunId(), at: 2_500 });
    tripwire.observe({ role: "executor", status: "red", runId: newRunId(), at: 3_000 });
    expect(sink.tripwires).toHaveLength(1);
  });

  it("reset(role) clears a specific role; reset() clears all", () => {
    const sink = makeSink();
    const tripwire = createCiTripwire({ emitter: sink.emitter });
    tripwire.observe({ role: "executor", status: "red", runId: newRunId(), at: 1_000 });
    tripwire.observe({ role: "planner", status: "red", runId: newRunId(), at: 1_000 });
    tripwire.reset("executor");
    expect(tripwire.snapshot().executor).toBeUndefined();
    expect(tripwire.snapshot().planner?.count).toBe(1);
    tripwire.reset();
    expect(tripwire.snapshot()).toEqual({});
  });

  it("snapshot exposes oldest-first runIds for the current streak", () => {
    const sink = makeSink();
    const tripwire = createCiTripwire({ emitter: sink.emitter });
    const runA = newRunId();
    const runB = newRunId();
    tripwire.observe({ role: "executor", status: "red", runId: runA, at: 1_000 });
    tripwire.observe({ role: "executor", status: "red", runId: runB, at: 2_000 });
    expect(tripwire.snapshot().executor?.runIds).toEqual([runA, runB]);
  });

  it("emitCiTripwire is called exactly once per fire with the expected payload", () => {
    const sink = makeSink();
    const tripwire = createCiTripwire({ emitter: sink.emitter, threshold: 2 });
    const runA = newRunId();
    const runB = newRunId();
    tripwire.observe({
      role: "executor",
      status: "red",
      runId: runA,
      at: 1_000,
      detail: { workflow: "ci.yml" },
    });
    tripwire.observe({
      role: "executor",
      status: "red",
      runId: runB,
      at: 2_000,
      detail: { workflow: "ci.yml", job: "check" },
    });
    expect(sink.tripwires).toHaveLength(1);
    expect(sink.events).toHaveLength(0);
    const fired = sink.tripwires[0];
    expect(fired?.runIds).toEqual([runA, runB]);
    expect(fired?.threshold).toBe(2);
    expect(fired?.reason).toContain("executor");
    expect(fired?.detail).toEqual({ workflow: "ci.yml", job: "check" });
  });

  it("falls back to emitter.emit when emitCiTripwire is absent", () => {
    const events: WatchdogEvent[] = [];
    const emitter: WatchdogEmitter = {
      emit(event) {
        events.push(event);
      },
    };
    const tripwire = createCiTripwire({ emitter, threshold: 1 });
    tripwire.observe({ role: "executor", status: "red", runId: newRunId(), at: 1_000 });
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("watchdog.ci_tripwire");
  });

  it("custom threshold fires at the configured count", () => {
    const sink = makeSink();
    const tripwire = createCiTripwire({ emitter: sink.emitter, threshold: 5 });
    for (let i = 0; i < 4; i++) {
      tripwire.observe({ role: "executor", status: "red", runId: newRunId(), at: i * 1_000 });
    }
    expect(sink.tripwires).toHaveLength(0);
    tripwire.observe({ role: "executor", status: "red", runId: newRunId(), at: 5_000 });
    expect(sink.tripwires).toHaveLength(1);
    expect(sink.tripwires[0]?.threshold).toBe(5);
  });

  it("rejects non-positive or non-integer thresholds", () => {
    const sink = makeSink();
    expect(() => createCiTripwire({ emitter: sink.emitter, threshold: 0 })).toThrow(TypeError);
    expect(() => createCiTripwire({ emitter: sink.emitter, threshold: -1 })).toThrow(TypeError);
    expect(() => createCiTripwire({ emitter: sink.emitter, threshold: 1.5 })).toThrow(TypeError);
  });
});
