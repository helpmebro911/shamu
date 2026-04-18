import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { newRunId, type RunId } from "@shamu/shared/ids";
import { evaluateCostVelocity } from "../../src/signals/cost-velocity.ts";
import { DEFAULT_WATCHDOG_CONFIG } from "../../src/types.ts";
import { openReaderFor, openTempDb, seedCost, seedRun, type TempDb } from "../helpers.ts";

describe("cost_velocity", () => {
  let db: TempDb;
  beforeEach(() => {
    db = openTempDb("shamu-watchdog-cv-");
  });
  afterEach(() => db.close());

  function newExecutorRun(
    role = "executor",
    vendor = "claude",
    status: "running" | "completed" = "completed",
  ): RunId {
    return seedRun(db.writer, newRunId(), { role, vendor, status });
  }

  it("emits medium when current run cost > 4× median of role-bucket priors", () => {
    // 5 prior executor runs at ~$1.00 each — median = 1.00.
    for (let i = 0; i < 5; i++) {
      const r = newExecutorRun();
      seedCost(db.writer, r, 1, 1_000, {
        usd: 1.0 + i * 0.01,
        confidence: "exact",
        source: "vendor",
      });
    }
    // Current run — $5.00, well over 4× median.
    const cur = newExecutorRun("executor", "claude", "running");
    seedCost(db.writer, cur, 1, 1_000, { usd: 5.0, confidence: "exact", source: "vendor" });

    const reader = openReaderFor(db.path);
    try {
      const obs = evaluateCostVelocity({
        db: reader,
        now: 2_000,
        config: DEFAULT_WATCHDOG_CONFIG,
      });
      const hit = obs.find((o) => o.runId === cur);
      expect(hit?.confidence).toBe("medium");
      expect(hit?.role).toBe("executor");
    } finally {
      reader.close();
    }
  });

  it("emits unknown for subscription-confidence runs", () => {
    // One subscription run — no budget-bearing usd.
    const r = newExecutorRun("executor", "codex", "running");
    seedCost(db.writer, r, 1, 1_000, {
      usd: null,
      confidence: "unknown",
      source: "subscription",
    });
    const reader = openReaderFor(db.path);
    try {
      const obs = evaluateCostVelocity({
        db: reader,
        now: 2_000,
        config: DEFAULT_WATCHDOG_CONFIG,
      });
      const hit = obs.find((o) => o.runId === r);
      expect(hit?.confidence).toBe("unknown");
    } finally {
      reader.close();
    }
  });

  it("yields unknown confidence while the role bucket has < N priors", () => {
    // 3 prior runs (under the N=5 default).
    for (let i = 0; i < 3; i++) {
      const r = newExecutorRun();
      seedCost(db.writer, r, 1, 1_000, {
        usd: 1.0,
        confidence: "exact",
        source: "vendor",
      });
    }
    // Current run — very expensive, 100× prior max.
    const cur = newExecutorRun("executor", "claude", "running");
    seedCost(db.writer, cur, 1, 1_000, { usd: 100.0, confidence: "exact", source: "vendor" });
    const reader = openReaderFor(db.path);
    try {
      const obs = evaluateCostVelocity({
        db: reader,
        now: 2_000,
        config: DEFAULT_WATCHDOG_CONFIG,
      });
      const hit = obs.find((o) => o.runId === cur);
      expect(hit?.confidence).toBe("unknown");
    } finally {
      reader.close();
    }
  });

  it("does not emit for runs inside normal velocity", () => {
    for (let i = 0; i < 5; i++) {
      const r = newExecutorRun();
      seedCost(db.writer, r, 1, 1_000, {
        usd: 1.0,
        confidence: "exact",
        source: "vendor",
      });
    }
    const cur = newExecutorRun("executor", "claude", "running");
    seedCost(db.writer, cur, 1, 1_000, { usd: 1.5, confidence: "exact", source: "vendor" });
    const reader = openReaderFor(db.path);
    try {
      const obs = evaluateCostVelocity({
        db: reader,
        now: 2_000,
        config: DEFAULT_WATCHDOG_CONFIG,
      });
      const hit = obs.find((o) => o.runId === cur);
      expect(hit).toBeUndefined();
    } finally {
      reader.close();
    }
  });

  it("mixed subscription + exact run yields a budget-bearing total, not unknown", () => {
    // Seed a population so the role bucket has enough priors.
    for (let i = 0; i < 5; i++) {
      const r = newExecutorRun();
      seedCost(db.writer, r, 1, 1_000, {
        usd: 1.0,
        confidence: "exact",
        source: "vendor",
      });
    }
    // Current run — one exact + one subscription cost event. The
    // subscription row should NOT make it "subscription-only" — we
    // treat the run as budget-bearing because at least one event was.
    const cur = newExecutorRun("executor", "claude", "running");
    seedCost(db.writer, cur, 1, 1_000, { usd: 6.0, confidence: "exact", source: "vendor" });
    seedCost(db.writer, cur, 2, 2_000, {
      usd: null,
      confidence: "unknown",
      source: "subscription",
    });
    const reader = openReaderFor(db.path);
    try {
      const obs = evaluateCostVelocity({
        db: reader,
        now: 2_000,
        config: DEFAULT_WATCHDOG_CONFIG,
      });
      const hit = obs.find((o) => o.runId === cur);
      // $6 > 4 × $1 median → medium.
      expect(hit?.confidence).toBe("medium");
    } finally {
      reader.close();
    }
  });
});
