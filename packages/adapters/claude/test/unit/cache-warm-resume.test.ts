/**
 * Cache-warm resume plumbing contract (Phase 2 exit-criterion stand-in).
 *
 * PLAN.md Phase 2 exit: `shamu resume` produces cache-warm follow-up turns
 * (verified by `cache_read_input_tokens > 0`).
 *
 * Live verification lives under `test/live/live-smoke.test.ts` behind
 * `SHAMU_CLAUDE_LIVE=1`; that test drives the real Claude CLI and asserts
 * non-zero cache hits on a resumed turn. This unit test is the hermetic
 * stand-in: it verifies the PLUMBING, not the vendor-side cache behavior.
 *
 * Invariants asserted:
 *
 * 1. `composeCacheKey` is deterministic: a resume against the same runId
 *    and system prompt produces the same cache salt a spawn did. That
 *    invariant is what makes the prompt-cache prefix reusable. If the
 *    resumed run used a NEW runId here, the salt would diverge (T9) and
 *    the vendor would see a cold prefix — no `cache_read_input_tokens`.
 *
 * 2. The adapter handle surfaces `usage.cache.hits` and
 *    `tokens.cacheRead > 0` when the SDK's `result.usage.
 *    cache_read_input_tokens > 0`. That's the exact signal the Phase 2
 *    exit criterion checks for at the event level.
 *
 * 3. `adapter.resume(sessionId, { runId: new })` still calls the driver
 *    with the caller-supplied runId — confirming the CLI can keep the
 *    original runId when it wants a cache-warm follow-up turn, OR use a
 *    fresh runId if it wants an orchestrator-authoritative new identity.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runId as asRunId, newRunId } from "@shamu/shared/ids";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ClaudeAdapter,
  type ClaudeDriver,
  type ClaudeDriverFactory,
  type ClaudeRaw,
  composeCacheKey,
  hashString,
} from "../../src/index.ts";

const warmUsageResult: ClaudeRaw[] = [
  { type: "system", subtype: "init", session_id: "sess-warm" },
  {
    type: "assistant",
    message: {
      stop_reason: "end_turn",
      content: [{ type: "text", text: "warm" }],
    },
  },
  {
    type: "result",
    subtype: "success",
    duration_ms: 20,
    total_cost_usd: 0.0005,
    usage: {
      input_tokens: 100,
      output_tokens: 10,
      cache_read_input_tokens: 80, // T9: this is the exit-criterion signal.
      cache_creation_input_tokens: 0,
    },
  },
];

function makeScriptedDriver(script: ReadonlyArray<ClaudeRaw>): ClaudeDriver {
  return {
    session: null,
    async startQuery() {
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
    async sendOnSession() {
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

describe("cache-warm resume plumbing", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "shamu-claude-warm-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("composeCacheKey is deterministic for the same (runId, systemPromptHash)", () => {
    // If a caller wants the cache prefix to match across spawn -> resume,
    // they can pass the ORIGINAL runId to the resume. This is the
    // supervisor's call (G8); the contract is that cacheKey is a pure
    // function of its inputs.
    const inputs = {
      runId: "run-original",
      systemPromptHash: hashString("you are helpful."),
    };
    expect(composeCacheKey(inputs)).toBe(composeCacheKey(inputs));
  });

  it("resume(sessionId, { runId }) threads runId to the driver", async () => {
    let observedRunId: string | null = null;
    const factory: ClaudeDriverFactory = async (ctx) => {
      observedRunId = ctx.spawnOpts.runId;
      return makeScriptedDriver(warmUsageResult);
    };
    const adapter = new ClaudeAdapter({ driverFactory: factory });

    const resumedRunId = newRunId();
    const handle = await adapter.resume("sess-warm" as Parameters<typeof adapter.resume>[0], {
      cwd: root,
      runId: resumedRunId,
    });
    try {
      expect(observedRunId).toBe(resumedRunId);
      expect(handle.runId).toBe(resumedRunId);
      expect(handle.sessionId).toBe("sess-warm");
    } finally {
      await handle.shutdown("test-done");
    }
  });

  it("surfaces cache_read_input_tokens > 0 through usage.cache.hits + tokens.cacheRead", async () => {
    const factory: ClaudeDriverFactory = async () => makeScriptedDriver(warmUsageResult);
    const adapter = new ClaudeAdapter({ driverFactory: factory });

    // Drive a resume turn — the canonical Phase 2 exit scenario.
    const handle = await adapter.resume("sess-warm" as Parameters<typeof adapter.resume>[0], {
      cwd: root,
      runId: asRunId("PINNED-RESUMED"),
    });
    try {
      await handle.send({ text: "hi again" });
      let sawCacheWarmUsage = false;
      for await (const ev of handle.events) {
        if (ev.kind === "usage") {
          // Two assertions — the exit criterion is literally
          // `cache_read_input_tokens > 0`; we also assert the cache stats
          // view surfaces the same signal.
          expect(ev.tokens.cacheRead).toBe(80);
          expect(ev.cache.hits).toBe(80);
          sawCacheWarmUsage = true;
        }
        if (ev.kind === "turn_end") break;
      }
      expect(sawCacheWarmUsage).toBe(true);
    } finally {
      await handle.shutdown("test-done");
    }
  });

  it("T9: composeCacheKey with a different runId produces a different salt (so CLI can opt for either reuse OR fresh)", () => {
    const sameSystemPromptHash = hashString("you are helpful.");
    const a = composeCacheKey({ runId: "run-A", systemPromptHash: sameSystemPromptHash });
    const b = composeCacheKey({ runId: "run-B", systemPromptHash: sameSystemPromptHash });
    expect(a).not.toBe(b);
  });
});
