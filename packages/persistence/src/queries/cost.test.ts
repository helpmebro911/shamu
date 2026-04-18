import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@shamu/shared/events";
import { newEventId, newRunId, newTurnId, type RunId } from "@shamu/shared/ids";
import { openDatabase, type ShamuDatabase } from "../db.ts";
import { aggregateRoleCost, aggregateRunCost } from "./cost.ts";
import { insertEvent } from "./events.ts";
import { insertRun } from "./runs.ts";

describe("cost aggregation", () => {
  let dir: string;
  let db: ShamuDatabase;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "shamu-cost-"));
    db = openDatabase(join(dir, "db.sqlite"));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function seed(params: {
    runId: RunId;
    vendor: string;
    role?: string;
    seqBase?: number;
    usage?: {
      input: number;
      output: number;
      cacheRead?: number;
      cacheCreation?: number;
      hits?: number;
      misses?: number;
      model?: string;
    };
    cost?: {
      usd: number | null;
      confidence: "exact" | "estimate" | "unknown";
      source: string;
    };
  }): void {
    const { runId, vendor, role, seqBase = 0, usage, cost } = params;
    const turnId = newTurnId();

    if (usage) {
      const ev: AgentEvent = {
        eventId: newEventId(),
        runId,
        sessionId: null,
        turnId,
        parentEventId: null,
        seq: seqBase + 1,
        tsMonotonic: seqBase + 1,
        tsWall: 1_700_000_000_000 + seqBase,
        vendor,
        rawRef: null,
        kind: "usage",
        model: usage.model ?? `${vendor}-model`,
        tokens: {
          input: usage.input,
          output: usage.output,
          cacheRead: usage.cacheRead ?? 0,
          cacheCreation: usage.cacheCreation ?? 0,
        },
        cache: {
          hits: usage.hits ?? usage.cacheRead ?? 0,
          misses: usage.misses ?? usage.input,
        },
      };
      insertEvent(db, ev);
    }
    if (cost) {
      const ev: AgentEvent = {
        eventId: newEventId(),
        runId,
        sessionId: null,
        turnId,
        parentEventId: null,
        seq: seqBase + 2,
        tsMonotonic: seqBase + 2,
        tsWall: 1_700_000_000_001 + seqBase,
        vendor,
        rawRef: null,
        kind: "cost",
        usd: cost.usd,
        confidence: cost.confidence,
        source: cost.source,
      };
      insertEvent(db, ev);
    }

    // Mark intentionally unused to satisfy strict no-unused-vars via the
    // destructure alias pattern.
    void role;
  }

  it("returns null for an unknown run", () => {
    expect(aggregateRunCost(db, newRunId())).toBeNull();
  });

  it("returns zeroed totals for a run with no usage/cost events", () => {
    const runId = newRunId();
    insertRun(db, { runId, vendor: "claude", role: "executor", status: "running", createdAt: 1 });
    const summary = aggregateRunCost(db, runId);
    expect(summary).not.toBeNull();
    expect(summary?.tokens).toEqual({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0 });
    expect(summary?.cost.usdTotal).toBe(0);
    expect(summary?.cost.subscriptionRuns).toBe(0);
    expect(summary?.role).toBe("executor");
    expect(summary?.vendor).toBe("claude");
  });

  it("sums tokens and usd for a single-run exact-cost vendor (Claude)", () => {
    const runId = newRunId();
    insertRun(db, { runId, vendor: "claude", role: "executor", status: "running", createdAt: 1 });
    seed({
      runId,
      vendor: "claude",
      seqBase: 0,
      usage: { input: 100, output: 50, cacheRead: 20, cacheCreation: 30 },
      cost: { usd: 0.01, confidence: "exact", source: "vendor" },
    });
    seed({
      runId,
      vendor: "claude",
      seqBase: 10,
      usage: { input: 5, output: 2 },
      cost: { usd: 0.005, confidence: "exact", source: "vendor" },
    });

    const summary = aggregateRunCost(db, runId);
    expect(summary?.tokens).toEqual({
      input: 105,
      output: 52,
      cacheRead: 20,
      cacheCreation: 30,
    });
    expect(summary?.cost.usdTotal).toBeCloseTo(0.015, 6);
    expect(summary?.cost.confidenceBreakdown).toEqual({ exact: 2, estimate: 0, unknown: 0 });
    expect(summary?.cost.subscriptionRuns).toBe(0);
  });

  it("tags a subscription run and leaves usd=0 (T17: no budget impact)", () => {
    const runId = newRunId();
    insertRun(db, { runId, vendor: "codex", role: "executor", status: "running", createdAt: 1 });
    seed({
      runId,
      vendor: "codex",
      usage: { input: 40, output: 20, cacheRead: 10 },
      cost: { usd: null, confidence: "unknown", source: "subscription" },
    });

    const summary = aggregateRunCost(db, runId);
    expect(summary?.cost.usdTotal).toBe(0);
    expect(summary?.cost.subscriptionRuns).toBe(1);
    expect(summary?.cost.confidenceBreakdown).toEqual({ exact: 0, estimate: 0, unknown: 1 });
  });

  it("rolls up a role across vendors", () => {
    const runA = newRunId();
    const runB = newRunId();
    insertRun(db, {
      runId: runA,
      vendor: "claude",
      role: "executor",
      status: "running",
      createdAt: 1,
    });
    insertRun(db, {
      runId: runB,
      vendor: "codex",
      role: "executor",
      status: "running",
      createdAt: 2,
    });

    seed({
      runId: runA,
      vendor: "claude",
      usage: { input: 100, output: 50 },
      cost: { usd: 0.02, confidence: "exact", source: "vendor" },
    });
    seed({
      runId: runB,
      vendor: "codex",
      usage: { input: 80, output: 40, cacheRead: 10 },
      cost: { usd: null, confidence: "unknown", source: "subscription" },
    });

    const rollup = aggregateRoleCost(db, "executor");
    expect(rollup).toHaveLength(2);
    // Sorted alphabetically by vendor.
    const [claude, codex] = rollup;
    expect(claude?.vendor).toBe("claude");
    expect(claude?.tokens.input).toBe(100);
    expect(claude?.cost.usdTotal).toBeCloseTo(0.02, 6);
    expect(claude?.cost.confidenceBreakdown.exact).toBe(1);

    expect(codex?.vendor).toBe("codex");
    expect(codex?.tokens.input).toBe(80);
    expect(codex?.cost.usdTotal).toBe(0);
    expect(codex?.cost.subscriptionRuns).toBe(1);
  });

  it("keeps the confidence breakdown separate from usdTotal (estimate contributes to both)", () => {
    const runId = newRunId();
    insertRun(db, { runId, vendor: "local", role: "executor", status: "running", createdAt: 1 });
    seed({
      runId,
      vendor: "local",
      usage: { input: 1000, output: 500 },
      cost: { usd: 0.04, confidence: "estimate", source: "computed" },
    });

    const summary = aggregateRunCost(db, runId);
    expect(summary?.cost.usdTotal).toBeCloseTo(0.04, 6);
    expect(summary?.cost.confidenceBreakdown).toEqual({ exact: 0, estimate: 1, unknown: 0 });
    expect(summary?.cost.subscriptionRuns).toBe(0);
  });

  it("counts a single run with multiple subscription events as one subscriptionRun", () => {
    const runId = newRunId();
    insertRun(db, { runId, vendor: "codex", role: "executor", status: "running", createdAt: 1 });
    seed({
      runId,
      vendor: "codex",
      seqBase: 0,
      usage: { input: 10, output: 5 },
      cost: { usd: null, confidence: "unknown", source: "subscription" },
    });
    seed({
      runId,
      vendor: "codex",
      seqBase: 10,
      usage: { input: 20, output: 10 },
      cost: { usd: null, confidence: "unknown", source: "subscription" },
    });

    const summary = aggregateRunCost(db, runId);
    expect(summary?.cost.subscriptionRuns).toBe(1);
  });

  it("returns an empty array for a role with no runs", () => {
    expect(aggregateRoleCost(db, "nonexistent-role")).toEqual([]);
  });
});
