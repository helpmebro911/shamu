import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { newRunId, type RunId } from "@shamu/shared/ids";
import {
  evaluateNoWriteActivity,
  evaluateRunNoWriteActivity,
} from "../../src/signals/no-write-activity.ts";
import { DEFAULT_WATCHDOG_CONFIG } from "../../src/types.ts";
import {
  openReaderFor,
  openTempDb,
  seedEvent,
  seedRun,
  seedToolCall,
  seedTurnEnd,
  type TempDb,
} from "../helpers.ts";

describe("no_write_activity — pure evaluator", () => {
  it("returns null when no events at all", () => {
    const obs = evaluateRunNoWriteActivity({
      runId: newRunId(),
      role: null,
      vendor: "claude",
      now: 1_000_000,
      config: DEFAULT_WATCHDOG_CONFIG,
      events: [],
      lastEventTs: null,
    });
    expect(obs).toBeNull();
  });

  it("unknown confidence for unknown vendor after threshold", () => {
    const now = 100 * 60_000; // big enough to breach the 15min threshold
    const obs = evaluateRunNoWriteActivity({
      runId: newRunId(),
      role: null,
      vendor: null,
      now,
      config: DEFAULT_WATCHDOG_CONFIG,
      events: [],
      lastEventTs: 0, // first event 100 min ago
    });
    expect(obs?.confidence).toBe("unknown");
  });

  it("unknown confidence for vendor with no allowlist", () => {
    const now = 100 * 60_000;
    const obs = evaluateRunNoWriteActivity({
      runId: newRunId(),
      role: null,
      vendor: "some-unknown-vendor",
      now,
      config: DEFAULT_WATCHDOG_CONFIG,
      events: [],
      lastEventTs: 0,
    });
    expect(obs?.confidence).toBe("unknown");
  });

  it("low confidence when vendor known but no prior write — brand new run", () => {
    const now = 100 * 60_000;
    const obs = evaluateRunNoWriteActivity({
      runId: newRunId(),
      role: null,
      vendor: "claude",
      now,
      config: DEFAULT_WATCHDOG_CONFIG,
      events: [{ kind: "tool_call", tsWall: 0, tool: "Read" }],
      lastEventTs: 0,
    });
    expect(obs?.confidence).toBe("low");
  });

  it("medium confidence when run has prior qualifying writes and quiet window elapsed", () => {
    const now = 40 * 60_000; // 40 min since last
    const obs = evaluateRunNoWriteActivity({
      runId: newRunId(),
      role: null,
      vendor: "claude",
      now,
      config: DEFAULT_WATCHDOG_CONFIG,
      events: [
        { kind: "tool_call", tsWall: 0, tool: "Edit" },
        { kind: "tool_call", tsWall: 10 * 60_000, tool: "Write" },
      ],
      lastEventTs: 10 * 60_000,
    });
    expect(obs?.confidence).toBe("medium");
  });

  it("does not fire if a qualifying write is inside the threshold", () => {
    const now = 10 * 60_000; // 10 min, under 15 min threshold
    const obs = evaluateRunNoWriteActivity({
      runId: newRunId(),
      role: null,
      vendor: "claude",
      now,
      config: DEFAULT_WATCHDOG_CONFIG,
      events: [{ kind: "tool_call", tsWall: 0, tool: "Edit" }],
      lastEventTs: 0,
    });
    expect(obs).toBeNull();
  });

  it("does not fire if a turn_end is inside the threshold", () => {
    const now = 10 * 60_000;
    const obs = evaluateRunNoWriteActivity({
      runId: newRunId(),
      role: null,
      vendor: "claude",
      now,
      config: DEFAULT_WATCHDOG_CONFIG,
      events: [
        { kind: "tool_call", tsWall: 0, tool: "Edit" },
        { kind: "turn_end", tsWall: 0, tool: null },
      ],
      lastEventTs: 0,
    });
    expect(obs).toBeNull();
  });

  it("Claude allowlist matches Edit|Write|Bash but not Read", () => {
    const now = 40 * 60_000;
    // Only Read — not in allowlist — so this is "no qualifying
    // writes" (low confidence).
    const obs = evaluateRunNoWriteActivity({
      runId: newRunId(),
      role: null,
      vendor: "claude",
      now,
      config: DEFAULT_WATCHDOG_CONFIG,
      events: [
        { kind: "tool_call", tsWall: 0, tool: "Read" },
        { kind: "tool_call", tsWall: 1_000, tool: "Grep" },
      ],
      lastEventTs: 1_000,
    });
    expect(obs?.confidence).toBe("low");
  });

  it("Codex allowlist matches apply_patch|shell but not exec", () => {
    const now = 40 * 60_000;
    // No qualifying writes (exec not in allowlist).
    const lowObs = evaluateRunNoWriteActivity({
      runId: newRunId(),
      role: null,
      vendor: "codex",
      now,
      config: DEFAULT_WATCHDOG_CONFIG,
      events: [{ kind: "tool_call", tsWall: 0, tool: "exec" }],
      lastEventTs: 0,
    });
    expect(lowObs?.confidence).toBe("low");
    // apply_patch does count.
    const medObs = evaluateRunNoWriteActivity({
      runId: newRunId(),
      role: null,
      vendor: "codex",
      now,
      config: DEFAULT_WATCHDOG_CONFIG,
      events: [{ kind: "tool_call", tsWall: 0, tool: "apply_patch" }],
      lastEventTs: 0,
    });
    expect(medObs?.confidence).toBe("medium");
    // shell also counts.
    const shellObs = evaluateRunNoWriteActivity({
      runId: newRunId(),
      role: null,
      vendor: "codex",
      now,
      config: DEFAULT_WATCHDOG_CONFIG,
      events: [{ kind: "tool_call", tsWall: 0, tool: "shell" }],
      lastEventTs: 0,
    });
    expect(shellObs?.confidence).toBe("medium");
  });
});

describe("no_write_activity — DB-backed evaluator", () => {
  let db: TempDb;
  beforeEach(() => {
    db = openTempDb("shamu-watchdog-nwa-");
  });
  afterEach(() => db.close());

  it("fires at medium when Claude run is quiet past 15 min", () => {
    const runId: RunId = seedRun(db.writer, newRunId(), {
      role: "executor",
      vendor: "claude",
    });
    seedToolCall(db.writer, runId, 1, 0, "Edit", { path: "foo.ts" });
    seedToolCall(db.writer, runId, 2, 60_000, "Read", {});
    const reader = openReaderFor(db.path);
    try {
      const obs = evaluateNoWriteActivity({
        db: reader,
        now: 60_000 + 20 * 60_000,
        config: DEFAULT_WATCHDOG_CONFIG,
      });
      expect(obs.length).toBe(1);
      expect(obs[0]?.confidence).toBe("medium");
    } finally {
      reader.close();
    }
  });

  it("handles runs whose only events are not tool_call/turn_end", () => {
    // Such a run has no qualifying write but has had *some* activity.
    const runId: RunId = seedRun(db.writer, newRunId(), {
      role: "executor",
      vendor: "claude",
    });
    // Seed a non-tool_call event so `lastEventTs` reports non-null.
    seedEvent(db.writer, {
      runId,
      seq: 1,
      tsWall: 0,
      kind: "assistant_message",
      payload: { text: "hi", stopReason: "end_turn" },
    });
    const reader = openReaderFor(db.path);
    try {
      const obs = evaluateNoWriteActivity({
        db: reader,
        now: 20 * 60_000,
        config: DEFAULT_WATCHDOG_CONFIG,
      });
      expect(obs.length).toBe(1);
      expect(obs[0]?.confidence).toBe("low");
    } finally {
      reader.close();
    }
  });

  it("skips completed runs entirely", () => {
    const runId: RunId = seedRun(db.writer, newRunId(), {
      role: "executor",
      vendor: "claude",
      status: "completed",
    });
    seedToolCall(db.writer, runId, 1, 0, "Edit");
    const reader = openReaderFor(db.path);
    try {
      const obs = evaluateNoWriteActivity({
        db: reader,
        now: 100 * 60_000,
        config: DEFAULT_WATCHDOG_CONFIG,
      });
      expect(obs).toEqual([]);
    } finally {
      reader.close();
    }
  });

  it("does not fire when a turn_end is inside the window", () => {
    const runId: RunId = seedRun(db.writer, newRunId(), {
      role: "executor",
      vendor: "claude",
    });
    seedToolCall(db.writer, runId, 1, 0, "Edit");
    seedTurnEnd(db.writer, runId, 2, 10 * 60_000);
    const reader = openReaderFor(db.path);
    try {
      const obs = evaluateNoWriteActivity({
        db: reader,
        now: 20 * 60_000,
        config: DEFAULT_WATCHDOG_CONFIG,
      });
      // 10 min since turn_end, window is 15 min → no fire.
      expect(obs).toEqual([]);
    } finally {
      reader.close();
    }
  });
});
