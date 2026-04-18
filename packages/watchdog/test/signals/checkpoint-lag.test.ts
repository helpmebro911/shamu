import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { newRunId, type RunId } from "@shamu/shared/ids";
import {
  evaluateCheckpointLag,
  evaluateRunCheckpointLag,
} from "../../src/signals/checkpoint-lag.ts";
import { DEFAULT_WATCHDOG_CONFIG } from "../../src/types.ts";
import { openReaderFor, openTempDb, seedCheckpoint, seedRun, type TempDb } from "../helpers.ts";

describe("checkpoint_lag — pure evaluator", () => {
  it("returns null when no events at all", () => {
    const obs = evaluateRunCheckpointLag({
      runId: newRunId(),
      role: null,
      vendor: "claude",
      checkpointTimestamps: [],
      now: 1_000_000,
      config: DEFAULT_WATCHDOG_CONFIG,
      lastEventTs: null,
    });
    expect(obs).toBeNull();
  });

  it("unknown confidence when < 10 checkpoints and floor breached", () => {
    // 5 prior checkpoints spaced 1 minute apart, latest at t=5 min.
    const times: number[] = [];
    for (let i = 0; i < 5; i++) times.push(i * 60_000);
    const lastTs = (times.at(-1) ?? 0) + 0;
    // now is 25 min later — well past the 20min floor.
    const obs = evaluateRunCheckpointLag({
      runId: newRunId(),
      role: null,
      vendor: "claude",
      checkpointTimestamps: times,
      now: lastTs + 25 * 60_000,
      config: DEFAULT_WATCHDOG_CONFIG,
      lastEventTs: lastTs,
    });
    expect(obs).not.toBeNull();
    expect(obs?.confidence).toBe("unknown");
  });

  it("no fire when < 10 checkpoints and floor not breached", () => {
    const times = [0, 60_000];
    const obs = evaluateRunCheckpointLag({
      runId: newRunId(),
      role: null,
      vendor: "claude",
      checkpointTimestamps: times,
      now: 120_000, // 1 min since last checkpoint — nowhere near 20 min floor
      config: DEFAULT_WATCHDOG_CONFIG,
      lastEventTs: 120_000,
    });
    expect(obs).toBeNull();
  });

  it("medium confidence when ≥ 10 checkpoints and gap > 3× median", () => {
    // 10 prior checkpoints spaced 30s apart (median interval = 30s).
    // 3 × median = 90s, but floor = 20min, so effective threshold is 20min.
    const step = 30_000;
    const times: number[] = [];
    for (let i = 0; i < 10; i++) times.push(i * step);
    const lastTs = times.at(-1) ?? 0;
    const now = lastTs + 21 * 60_000; // 21 min past last
    const obs = evaluateRunCheckpointLag({
      runId: newRunId(),
      role: "executor",
      vendor: "claude",
      checkpointTimestamps: times,
      now,
      config: DEFAULT_WATCHDOG_CONFIG,
      lastEventTs: lastTs,
    });
    expect(obs).not.toBeNull();
    expect(obs?.confidence).toBe("medium");
    expect(obs?.role).toBe("executor");
  });

  it("no fire when ≥ 10 checkpoints and gap < floor", () => {
    const step = 30_000;
    const times: number[] = [];
    for (let i = 0; i < 10; i++) times.push(i * step);
    const lastTs = times.at(-1) ?? 0;
    const now = lastTs + 5 * 60_000; // 5 min — under floor
    const obs = evaluateRunCheckpointLag({
      runId: newRunId(),
      role: null,
      vendor: "claude",
      checkpointTimestamps: times,
      now,
      config: DEFAULT_WATCHDOG_CONFIG,
      lastEventTs: lastTs,
    });
    expect(obs).toBeNull();
  });

  it("threshold scales with median when 3× median > floor", () => {
    // 10 checkpoints spaced 10 minutes apart → median = 10 min.
    // 3 × median = 30 min > 20 min floor. Threshold becomes 30 min.
    const step = 10 * 60_000;
    const times: number[] = [];
    for (let i = 0; i < 10; i++) times.push(i * step);
    const lastTs = times.at(-1) ?? 0;
    const now = lastTs + 25 * 60_000;
    const obs = evaluateRunCheckpointLag({
      runId: newRunId(),
      role: null,
      vendor: "claude",
      checkpointTimestamps: times,
      now,
      config: DEFAULT_WATCHDOG_CONFIG,
      lastEventTs: lastTs,
    });
    // Gap (25 min) < threshold (30 min) → don't fire.
    expect(obs).toBeNull();
  });
});

describe("checkpoint_lag — DB-backed evaluator", () => {
  let db: TempDb;
  beforeEach(() => {
    db = openTempDb("shamu-watchdog-cp-");
  });
  afterEach(() => db.close());

  it("emits observation for an active run with long gap", () => {
    const runId: RunId = seedRun(db.writer, newRunId(), {
      role: "executor",
      vendor: "claude",
      status: "running",
    });
    const step = 60_000;
    for (let i = 0; i < 10; i++) {
      seedCheckpoint(db.writer, runId, i + 1, i * step);
    }
    const reader = openReaderFor(db.path);
    try {
      const obs = evaluateCheckpointLag({
        db: reader,
        now: 10 * step + 25 * 60_000,
        config: DEFAULT_WATCHDOG_CONFIG,
      });
      expect(obs.length).toBe(1);
      expect(obs[0]?.signal).toBe("checkpoint_lag");
      expect(obs[0]?.confidence).toBe("medium");
    } finally {
      reader.close();
    }
  });

  it("skips completed runs", () => {
    const runId: RunId = seedRun(db.writer, newRunId(), {
      role: "executor",
      vendor: "claude",
      status: "completed",
    });
    const step = 60_000;
    for (let i = 0; i < 10; i++) {
      seedCheckpoint(db.writer, runId, i + 1, i * step);
    }
    const reader = openReaderFor(db.path);
    try {
      const obs = evaluateCheckpointLag({
        db: reader,
        now: 10 * step + 60 * 60_000,
        config: DEFAULT_WATCHDOG_CONFIG,
      });
      expect(obs).toEqual([]);
    } finally {
      reader.close();
    }
  });
});
