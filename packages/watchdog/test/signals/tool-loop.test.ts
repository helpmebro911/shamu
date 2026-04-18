import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { newRunId, type RunId } from "@shamu/shared/ids";
import { canonicalizeArgs } from "../../src/canonicalize.ts";
import {
  evaluateRunToolLoop,
  evaluateToolLoop,
  type NormalizedToolCall,
  ToolLoopDedupState,
} from "../../src/signals/tool-loop.ts";
import { DEFAULT_WATCHDOG_CONFIG } from "../../src/types.ts";
import { openReaderFor, openTempDb, seedRun, seedToolCall, type TempDb } from "../helpers.ts";

function hash(args: unknown): string {
  return createHash("sha256").update(canonicalizeArgs(args)).digest("hex");
}

function callOf(
  seq: number,
  tool: string,
  args: unknown,
  tsWall: number = seq * 1000,
): NormalizedToolCall {
  return {
    seq,
    tsWall,
    tool,
    argsHash: hash(args),
  };
}

describe("tool_loop — pure evaluator", () => {
  it("3 consecutive identical calls trip medium", () => {
    const runId = newRunId();
    const obs = evaluateRunToolLoop({
      runId,
      role: null,
      vendor: "claude",
      now: 10_000,
      config: DEFAULT_WATCHDOG_CONFIG,
      calls: [
        callOf(1, "Bash", { cmd: "pwd" }),
        callOf(2, "Bash", { cmd: "pwd" }),
        callOf(3, "Bash", { cmd: "pwd" }),
      ],
    });
    expect(obs?.confidence).toBe("medium");
    expect((obs?.detail as { consecutiveCount: number }).consecutiveCount).toBe(3);
  });

  it("6 consecutive identical calls trip high", () => {
    const runId = newRunId();
    const obs = evaluateRunToolLoop({
      runId,
      role: null,
      vendor: "claude",
      now: 10_000,
      config: DEFAULT_WATCHDOG_CONFIG,
      calls: [
        callOf(1, "Bash", { cmd: "pwd" }),
        callOf(2, "Bash", { cmd: "pwd" }),
        callOf(3, "Bash", { cmd: "pwd" }),
        callOf(4, "Bash", { cmd: "pwd" }),
        callOf(5, "Bash", { cmd: "pwd" }),
        callOf(6, "Bash", { cmd: "pwd" }),
      ],
    });
    expect(obs?.confidence).toBe("high");
  });

  it("3 non-consecutive identical calls do NOT trip", () => {
    const runId = newRunId();
    const obs = evaluateRunToolLoop({
      runId,
      role: null,
      vendor: "claude",
      now: 10_000,
      config: DEFAULT_WATCHDOG_CONFIG,
      calls: [
        callOf(1, "Bash", { cmd: "pwd" }),
        callOf(2, "Bash", { cmd: "ls" }),
        callOf(3, "Bash", { cmd: "pwd" }),
        callOf(4, "Bash", { cmd: "ls" }),
        callOf(5, "Bash", { cmd: "pwd" }),
      ],
    });
    expect(obs).toBeNull();
  });

  it("different tool types break the consecutive run", () => {
    const runId = newRunId();
    const obs = evaluateRunToolLoop({
      runId,
      role: null,
      vendor: "claude",
      now: 10_000,
      config: DEFAULT_WATCHDOG_CONFIG,
      calls: [
        callOf(1, "Bash", { cmd: "pwd" }),
        callOf(2, "Edit", { cmd: "pwd" }),
        callOf(3, "Bash", { cmd: "pwd" }),
      ],
    });
    expect(obs).toBeNull();
  });

  it("secret-bearing args that differ only in the secret hash identically", () => {
    const runId = newRunId();
    // Three calls whose ONLY difference is the embedded Anthropic
    // key. Redaction should collapse them to the same hash.
    const obs = evaluateRunToolLoop({
      runId,
      role: null,
      vendor: "claude",
      now: 10_000,
      config: DEFAULT_WATCHDOG_CONFIG,
      calls: [
        callOf(1, "Bash", {
          cmd: "curl -H 'x-api-key: sk-ant-aaaaaaaaaaaaaaaaaaaaaaaa' api",
        }),
        callOf(2, "Bash", {
          cmd: "curl -H 'x-api-key: sk-ant-bbbbbbbbbbbbbbbbbbbbbbbb' api",
        }),
        callOf(3, "Bash", {
          cmd: "curl -H 'x-api-key: sk-ant-cccccccccccccccccccccccc' api",
        }),
      ],
    });
    expect(obs?.confidence).toBe("medium");
  });
});

describe("tool_loop — DB-backed evaluator", () => {
  let db: TempDb;
  beforeEach(() => {
    db = openTempDb("shamu-watchdog-tl-");
  });
  afterEach(() => db.close());

  it("fires on 3 consecutive identical tool_calls in the DB", () => {
    const runId: RunId = seedRun(db.writer, newRunId(), {
      role: "executor",
      vendor: "claude",
    });
    seedToolCall(db.writer, runId, 1, 1_000, "Bash", { cmd: "pwd" });
    seedToolCall(db.writer, runId, 2, 2_000, "Bash", { cmd: "pwd" });
    seedToolCall(db.writer, runId, 3, 3_000, "Bash", { cmd: "pwd" });
    const reader = openReaderFor(db.path);
    try {
      const obs = evaluateToolLoop({
        db: reader,
        now: 4_000,
        config: DEFAULT_WATCHDOG_CONFIG,
      });
      expect(obs.length).toBe(1);
      expect(obs[0]?.confidence).toBe("medium");
    } finally {
      reader.close();
    }
  });

  it("dedup state suppresses re-emission on unchanged loops across ticks", () => {
    const runId: RunId = seedRun(db.writer, newRunId(), {
      role: "executor",
      vendor: "claude",
    });
    seedToolCall(db.writer, runId, 1, 1_000, "Bash", { cmd: "pwd" });
    seedToolCall(db.writer, runId, 2, 2_000, "Bash", { cmd: "pwd" });
    seedToolCall(db.writer, runId, 3, 3_000, "Bash", { cmd: "pwd" });
    const dedup = new ToolLoopDedupState();
    const reader = openReaderFor(db.path);
    try {
      const t1 = evaluateToolLoop({
        db: reader,
        now: 4_000,
        config: DEFAULT_WATCHDOG_CONFIG,
        dedup,
      });
      expect(t1.length).toBe(1);
      const t2 = evaluateToolLoop({
        db: reader,
        now: 5_000,
        config: DEFAULT_WATCHDOG_CONFIG,
        dedup,
      });
      // Same final-seq, no new loop data — dedup suppresses.
      expect(t2.length).toBe(0);
    } finally {
      reader.close();
    }
  });

  it("dedup re-emits when the loop extends (new identical call arrives)", () => {
    const runId: RunId = seedRun(db.writer, newRunId(), {
      role: "executor",
      vendor: "claude",
    });
    seedToolCall(db.writer, runId, 1, 1_000, "Bash", { cmd: "pwd" });
    seedToolCall(db.writer, runId, 2, 2_000, "Bash", { cmd: "pwd" });
    seedToolCall(db.writer, runId, 3, 3_000, "Bash", { cmd: "pwd" });
    const dedup = new ToolLoopDedupState();
    const reader = openReaderFor(db.path);
    try {
      const t1 = evaluateToolLoop({
        db: reader,
        now: 4_000,
        config: DEFAULT_WATCHDOG_CONFIG,
        dedup,
      });
      expect(t1.length).toBe(1);
    } finally {
      reader.close();
    }
    // Extend the loop with another identical call, re-open reader.
    seedToolCall(db.writer, runId, 4, 5_000, "Bash", { cmd: "pwd" });
    const reader2 = openReaderFor(db.path);
    try {
      const t2 = evaluateToolLoop({
        db: reader2,
        now: 6_000,
        config: DEFAULT_WATCHDOG_CONFIG,
        dedup,
      });
      expect(t2.length).toBe(1);
      expect((t2[0]?.detail as { consecutiveCount: number }).consecutiveCount).toBe(4);
    } finally {
      reader2.close();
    }
  });
});
