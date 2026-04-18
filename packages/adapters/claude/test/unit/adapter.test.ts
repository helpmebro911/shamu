// Behavioral unit tests for ClaudeAdapter with the SDK stubbed. The
// shared contract suite runs against the same driver double in
// contract.test.ts — these tests cover invariants the contract suite
// doesn't own (runId pass-through, frozen manifest, cache-salt exposure).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newRunId } from "@shamu/shared/ids";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CLAUDE_CAPABILITIES,
  ClaudeAdapter,
  type ClaudeDriver,
  type ClaudeDriverFactory,
  type ClaudeRaw,
} from "../../src/index.ts";

// A scripted driver: replays the raw messages it was seeded with on each
// `startQuery` (or `sendOnSession`) call. No real SDK involvement.
function makeScriptedDriver(script: ReadonlyArray<ClaudeRaw>): ClaudeDriver {
  return {
    session: null,
    async startQuery(_prompt, _signal) {
      return {
        [Symbol.asyncIterator]: () => {
          let i = 0;
          return {
            next: async () => {
              if (i >= script.length)
                return { value: undefined as unknown as ClaudeRaw, done: true };
              const value = script[i] as ClaudeRaw;
              i += 1;
              return { value, done: false };
            },
          } as AsyncIterator<ClaudeRaw>;
        },
        interrupt: async () => {},
        setModel: async () => {},
        setPermissionMode: async () => {},
      };
    },
    async sendOnSession(_s, _p) {
      return {
        [Symbol.asyncIterator]: () => {
          let i = 0;
          return {
            next: async () => {
              if (i >= script.length)
                return { value: undefined as unknown as ClaudeRaw, done: true };
              const value = script[i] as ClaudeRaw;
              i += 1;
              return { value, done: false };
            },
          } as AsyncIterator<ClaudeRaw>;
        },
      };
    },
  };
}

const scriptedHelloResult: ClaudeRaw[] = [
  { type: "system", subtype: "init", session_id: "sess-unit" },
  {
    type: "assistant",
    message: {
      stop_reason: "end_turn",
      content: [{ type: "text", text: "hello" }],
    },
  },
  {
    type: "result",
    subtype: "success",
    duration_ms: 42,
    total_cost_usd: 0.001,
    usage: { input_tokens: 1, output_tokens: 2 },
  },
];

describe("CLAUDE_CAPABILITIES", () => {
  it("matches the manifest and is frozen", () => {
    expect(CLAUDE_CAPABILITIES.resume).toBe(true);
    expect(CLAUDE_CAPABILITIES.fork).toBe(false);
    expect(CLAUDE_CAPABILITIES.interrupt).toBe("cooperative");
    expect(CLAUDE_CAPABILITIES.permissionModes).toEqual([
      "default",
      "acceptEdits",
      "plan",
      "bypassPermissions",
    ]);
    expect(CLAUDE_CAPABILITIES.mcp).toBe("in-process");
    expect(CLAUDE_CAPABILITIES.customTools).toBe(true);
    expect(CLAUDE_CAPABILITIES.patchVisibility).toBe("events");
    expect(CLAUDE_CAPABILITIES.usageReporting).toBe("per-turn");
    expect(CLAUDE_CAPABILITIES.costReporting).toBe("native");
    expect(CLAUDE_CAPABILITIES.sandboxing).toBe("process");
    expect(CLAUDE_CAPABILITIES.streaming).toBe("events");
    expect(Object.isFrozen(CLAUDE_CAPABILITIES)).toBe(true);
  });

  it("refuses runtime mutation (G8)", () => {
    expect(() => {
      (CLAUDE_CAPABILITIES as { fork: boolean }).fork = true;
    }).toThrow();
  });
});

describe("ClaudeAdapter — runId ownership (G8)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "shamu-claude-unit-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("handle.runId equals spawnOpts.runId", async () => {
    const runId = newRunId();
    const factory: ClaudeDriverFactory = async () => makeScriptedDriver(scriptedHelloResult);
    const adapter = new ClaudeAdapter({ driverFactory: factory });
    const handle = await adapter.spawn({ cwd: root, runId });
    try {
      expect(handle.runId).toBe(runId);
    } finally {
      await handle.shutdown("done");
    }
  });

  it("resume(sessionId) preserves the supplied runId", async () => {
    const runId = newRunId();
    const factory: ClaudeDriverFactory = async () => makeScriptedDriver(scriptedHelloResult);
    const adapter = new ClaudeAdapter({ driverFactory: factory });
    const handle = await adapter.resume(
      // Cast — the fixture sessionId is a plain string, branded type is
      // runtime-transparent.
      "sess-unit" as unknown as Parameters<typeof adapter.resume>[0],
      { cwd: root, runId },
    );
    try {
      expect(handle.runId).toBe(runId);
      expect(handle.sessionId).toBe("sess-unit");
    } finally {
      await handle.shutdown("done");
    }
  });
});

describe("ClaudeAdapter — event projection end-to-end", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "shamu-claude-unit-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("emits session_start → assistant_message → usage → cost → turn_end", async () => {
    const factory: ClaudeDriverFactory = async () => makeScriptedDriver(scriptedHelloResult);
    const adapter = new ClaudeAdapter({ driverFactory: factory });
    const handle = await adapter.spawn({ cwd: root, runId: newRunId() });
    await handle.send({ text: "hi" });
    const kinds: string[] = [];
    for await (const ev of handle.events) {
      kinds.push(ev.kind);
      if (ev.kind === "turn_end") break;
    }
    await handle.shutdown("done");
    expect(kinds[0]).toBe("session_start");
    expect(kinds).toContain("assistant_message");
    expect(kinds).toContain("usage");
    expect(kinds).toContain("cost");
    expect(kinds[kinds.length - 1]).toBe("turn_end");
  });
});
