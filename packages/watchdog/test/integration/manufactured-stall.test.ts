import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { newRunId, type RunId } from "@shamu/shared/ids";
import type { WatchdogEmitter, WatchdogEvent } from "../../src/events.ts";
import { DEFAULT_WATCHDOG_CONFIG } from "../../src/types.ts";
import { createWatchdogState, runWatchdog } from "../../src/watchdog.ts";
import {
  openReaderFor,
  openTempDb,
  seedCheckpoint,
  seedCost,
  seedRun,
  seedToolCall,
  type TempDb,
} from "../helpers.ts";

function captureEmitter(): { emitter: WatchdogEmitter; events: WatchdogEvent[] } {
  const events: WatchdogEvent[] = [];
  const emitter: WatchdogEmitter = {
    emit(e) {
      events.push(e);
    },
  };
  return { emitter, events };
}

describe("integration — manufactured stall", () => {
  let db: TempDb;
  beforeEach(() => {
    db = openTempDb("shamu-watchdog-int-");
  });
  afterEach(() => db.close());

  it("manufactured stall trips an alert inside the expected window", () => {
    // Seed a warm role population so the cost_velocity signal has
    // enough priors to produce a medium observation.
    for (let i = 0; i < 5; i++) {
      const prior = seedRun(db.writer, newRunId(), {
        role: "executor",
        vendor: "claude",
        status: "completed",
      });
      seedCost(db.writer, prior, 1, 1_000, {
        usd: 1.0,
        confidence: "exact",
        source: "vendor",
      });
    }

    // The run under test — has ≥ 10 checkpoints, and has emitted
    // expensive cost events. Then it goes quiet.
    const runId: RunId = seedRun(db.writer, newRunId(), {
      role: "executor",
      vendor: "claude",
      status: "running",
    });
    const minute = 60_000;
    // Ten checkpoints spaced one minute apart.
    for (let i = 0; i < 10; i++) {
      seedCheckpoint(db.writer, runId, i + 1, i * minute);
    }
    // An expensive cost event on the same run — $10 (10× median of priors).
    seedCost(db.writer, runId, 11, 10 * minute, {
      usd: 10.0,
      confidence: "exact",
      source: "vendor",
    });

    const reader = openReaderFor(db.path);
    try {
      const state = createWatchdogState(DEFAULT_WATCHDOG_CONFIG);
      const { emitter, events } = captureEmitter();

      // First tick at t=11min — the last checkpoint was 1 min ago, so
      // checkpoint_lag should NOT fire yet. cost_velocity should fire
      // (medium) because run cost (10) is > 4× median (1).
      runWatchdog({
        db: reader,
        now: 11 * minute,
        config: DEFAULT_WATCHDOG_CONFIG,
        emit: emitter,
        state,
      });
      let alerts = events.filter((e) => e.kind === "watchdog.alert");
      expect(alerts.length).toBe(0);

      // Second tick 30 minutes after the last checkpoint — well past
      // the 20-minute floor. checkpoint_lag fires medium, agreement
      // kicks in.
      runWatchdog({
        db: reader,
        now: 10 * minute + 30 * minute,
        config: DEFAULT_WATCHDOG_CONFIG,
        emit: emitter,
        state,
      });
      alerts = events.filter((e) => e.kind === "watchdog.alert");
      expect(alerts.length).toBeGreaterThan(0);
      const alert = alerts[0];
      expect(alert?.kind).toBe("watchdog.alert");
      // Agreement uses whichever two signals fired — must include
      // checkpoint_lag plus at least one other (cost_velocity here).
      if (alert?.kind === "watchdog.alert") {
        expect(alert.signals).toContain("checkpoint_lag");
        expect(alert.runId).toBe(runId);
      }
    } finally {
      reader.close();
    }
  });

  it("cold-started role with < 10 checkpoints yields confidence=unknown and no escalation", () => {
    // A brand-new run with only 3 checkpoints so far.
    const runId: RunId = seedRun(db.writer, newRunId(), {
      role: "executor",
      vendor: "claude",
      status: "running",
    });
    const minute = 60_000;
    for (let i = 0; i < 3; i++) {
      seedCheckpoint(db.writer, runId, i + 1, i * minute);
    }
    // Run has produced a qualifying write tool_call — but then a big gap.
    seedToolCall(db.writer, runId, 4, 2 * minute, "Edit", { path: "foo.ts" });

    const reader = openReaderFor(db.path);
    try {
      const state = createWatchdogState(DEFAULT_WATCHDOG_CONFIG);
      const { emitter, events } = captureEmitter();

      // Now = 45 min later. checkpoint_lag will fire unknown (floor
      // breached but no median). no_write_activity will fire medium
      // (15 min window elapsed, prior write seen).
      runWatchdog({
        db: reader,
        now: 2 * minute + 45 * minute,
        config: DEFAULT_WATCHDOG_CONFIG,
        emit: emitter,
        state,
      });

      const hints = events.filter((e) => e.kind === "watchdog.hint");
      const alerts = events.filter((e) => e.kind === "watchdog.alert");

      // Both signals fired as hints.
      expect(hints.some((h) => h.kind === "watchdog.hint" && h.signal === "checkpoint_lag")).toBe(
        true,
      );
      expect(
        hints.some((h) => h.kind === "watchdog.hint" && h.signal === "no_write_activity"),
      ).toBe(true);

      // checkpoint_lag should be unknown confidence.
      const cpHint = hints.find((h) => h.kind === "watchdog.hint" && h.signal === "checkpoint_lag");
      if (cpHint?.kind === "watchdog.hint") {
        expect(cpHint.confidence).toBe("unknown");
      }

      // An unknown + medium agreement is a hint-only situation — no alert.
      expect(alerts.length).toBe(0);
    } finally {
      reader.close();
    }
  });

  it("tool_loop + no_write_activity agree to fire a single alert", () => {
    const runId: RunId = seedRun(db.writer, newRunId(), {
      role: "executor",
      vendor: "claude",
      status: "running",
    });
    // Three consecutive identical Bash calls trip tool_loop.
    seedToolCall(db.writer, runId, 1, 0, "Bash", { cmd: "pwd" });
    seedToolCall(db.writer, runId, 2, 1_000, "Bash", { cmd: "pwd" });
    seedToolCall(db.writer, runId, 3, 2_000, "Bash", { cmd: "pwd" });

    const reader = openReaderFor(db.path);
    try {
      const state = createWatchdogState(DEFAULT_WATCHDOG_CONFIG);
      const { emitter, events } = captureEmitter();

      // Now = 20 min past last activity. no_write_activity will fire
      // medium (has prior writes; >15 min quiet). tool_loop will fire
      // medium. Two-signal agreement → alert.
      runWatchdog({
        db: reader,
        now: 20 * 60_000,
        config: DEFAULT_WATCHDOG_CONFIG,
        emit: emitter,
        state,
      });

      const alerts = events.filter((e) => e.kind === "watchdog.alert");
      expect(alerts.length).toBe(1);
      if (alerts[0]?.kind === "watchdog.alert") {
        expect(alerts[0].signals).toContain("tool_loop");
        expect(alerts[0].signals).toContain("no_write_activity");
      }
    } finally {
      reader.close();
    }
  });
});
