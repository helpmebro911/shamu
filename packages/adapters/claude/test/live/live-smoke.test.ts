// Live-mode smoke tests — gated by `SHAMU_CLAUDE_LIVE=1`. Skipped by
// default so the fast CI run is hermetic.
//
// When enabled, these tests drive a real Claude CLI via the adapter. They
// require:
//   - `SHAMU_CLAUDE_LIVE=1`
//   - A pre-authenticated `claude` CLI. Its path is supplied via the env
//     var `SHAMU_CLAUDE_CLI` (defaults to `/usr/local/bin/claude`, which
//     will almost certainly fail — supply the real path).
//
// The scenarios below intentionally exercise subprocess write-backpressure
// code in `@shamu/adapters-base/src/subprocess.ts` (HANDOFF followup #3).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newRunId } from "@shamu/shared/ids";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ClaudeAdapter } from "../../src/index.ts";

const LIVE = process.env.SHAMU_CLAUDE_LIVE === "1";
const CLI_PATH = process.env.SHAMU_CLAUDE_CLI ?? "/usr/local/bin/claude";

describe.skipIf(!LIVE)("Claude adapter — live CLI smoke", () => {
  let cwd: string;
  beforeAll(() => {
    cwd = mkdtempSync(join(tmpdir(), "shamu-claude-live-"));
  });
  afterAll(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("spawns and completes a single hello turn against the real CLI", async () => {
    const adapter = new ClaudeAdapter();
    const handle = await adapter.spawn({
      cwd,
      runId: newRunId(),
      vendorCliPath: CLI_PATH,
    });
    try {
      await handle.send({ text: "Say 'hello' and end your turn." });
      let sawTurnEnd = false;
      let sawSessionStart = false;
      for await (const ev of handle.events) {
        if (ev.kind === "session_start") sawSessionStart = true;
        if (ev.kind === "turn_end") {
          sawTurnEnd = true;
          break;
        }
      }
      expect(sawSessionStart).toBe(true);
      expect(sawTurnEnd).toBe(true);
    } finally {
      await handle.shutdown("live-smoke-done");
    }
  }, 60_000);

  // Phase 2 exit criterion: `shamu resume` produces cache-warm follow-up
  // turns, verified by `cache_read_input_tokens > 0` on the resumed turn.
  // Asserted against the usage event's `tokens.cacheRead` field (which is
  // the normalized projection of Claude's `cache_read_input_tokens`).
  it("resume warms the prompt cache (cache_read_input_tokens > 0)", async () => {
    const adapter = new ClaudeAdapter();
    const originalRunId = newRunId();
    const spawnHandle = await adapter.spawn({
      cwd,
      runId: originalRunId,
      vendorCliPath: CLI_PATH,
    });
    let sessionId: string | null = null;
    try {
      await spawnHandle.send({
        text: "Remember the word 'violet'. Reply with 'ok' and end your turn.",
      });
      for await (const ev of spawnHandle.events) {
        if (ev.kind === "session_start") sessionId = ev.sessionId;
        if (ev.kind === "turn_end") break;
      }
    } finally {
      await spawnHandle.shutdown("live-cache-warm-spawn-done");
    }
    expect(sessionId).not.toBeNull();
    if (!sessionId) return;

    const resumedHandle = await adapter.resume(sessionId as never, {
      cwd,
      runId: newRunId(),
      vendorCliPath: CLI_PATH,
    });
    try {
      await resumedHandle.send({
        text: "What word did I ask you to remember?",
      });
      let cacheRead = 0;
      for await (const ev of resumedHandle.events) {
        if (ev.kind === "usage") cacheRead = Math.max(cacheRead, ev.tokens.cacheRead ?? 0);
        if (ev.kind === "turn_end") break;
      }
      expect(cacheRead).toBeGreaterThan(0);
    } finally {
      await resumedHandle.shutdown("live-cache-warm-resume-done");
    }
  }, 120_000);
});
