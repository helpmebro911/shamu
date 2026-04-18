// Claude capture harness.
//
// Runs the Claude Agent SDK's `query()` against a freshly-seeded scratch repo
// for one canonical task, consumes the event stream to completion, and writes
// the raw SDK messages verbatim to JSONL. No normalization.
//
// Auth model: Claude CLI at /Users/watzon/.local/bin/claude is already logged in
// (macOS keychain). We point the SDK at it via pathToClaudeCodeExecutable so
// the spawned subprocess inherits the authenticated session. We do NOT set
// ANTHROPIC_API_KEY — doing so would override the CLI session.

import { mkdir, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { resetScratchRepo, taskPrompt, type TaskId } from "./scratch.ts";

const CLAUDE_CLI = "/Users/watzon/.local/bin/claude";
const SPIKE_ROOT = new URL("..", import.meta.url).pathname;

const TASKS: TaskId[] = ["bugfix", "refactor", "new-feature"];

type Summary = {
  vendor: "claude";
  taskId: TaskId;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  eventCount: number;
  kindCounts: Record<string, number>;
  finalSessionId: string | null;
  scratchRepo: string;
  rawFile: string;
  truncated: boolean;
  error: string | null;
};

async function captureOne(taskId: TaskId): Promise<Summary> {
  const scratchRepo = await resetScratchRepo("claude", taskId);
  const capturesDir = path.join(SPIKE_ROOT, "captures");
  await mkdir(capturesDir, { recursive: true });

  const rawFile = path.join(capturesDir, `claude-${taskId}-raw.jsonl`);
  // Truncate any previous run.
  await writeFile(rawFile, "");

  const prompt = taskPrompt(taskId);
  const startedAt = new Date();
  const startWall = startedAt.toISOString();
  const startMonotonic = performance.now();

  const kindCounts: Record<string, number> = {};
  let eventCount = 0;
  let finalSessionId: string | null = null;
  let truncated = false;
  let error: string | null = null;

  // Safety cap: kill the turn if it takes longer than this.
  const TURN_TIMEOUT_MS = 4 * 60 * 1000;

  const timeoutHandle = setTimeout(() => {
    truncated = true;
  }, TURN_TIMEOUT_MS);

  try {
    const q = query({
      prompt,
      options: {
        // Point the SDK at the CLI-auth'd binary.
        pathToClaudeCodeExecutable: CLAUDE_CLI,
        cwd: scratchRepo,
        // Permission mode: let the agent make edits without prompting. This is
        // a trusted scratch directory.
        permissionMode: "bypassPermissions",
        // Keep the budget tight for this spike.
        maxTurns: 10,
      },
    });

    for await (const msg of q as AsyncIterable<SDKMessage>) {
      eventCount += 1;
      const kind = (msg as any).type ?? "unknown";
      const subtype = (msg as any).subtype;
      const counterKey = subtype ? `${kind}:${subtype}` : String(kind);
      kindCounts[counterKey] = (kindCounts[counterKey] ?? 0) + 1;

      // Capture session id when we first see it.
      const sid = (msg as any).session_id ?? null;
      if (sid) finalSessionId = sid;

      await appendFile(rawFile, JSON.stringify(msg) + "\n");

      if (truncated) {
        try {
          await q.interrupt();
        } catch {
          /* ignore */
        }
        break;
      }

      // `result` message marks stream completion in practice.
      if (kind === "result") {
        break;
      }
    }
  } catch (e: any) {
    error = String(e?.stack ?? e?.message ?? e);
  } finally {
    clearTimeout(timeoutHandle);
  }

  const endedAt = new Date();
  const durationMs = Math.round(performance.now() - startMonotonic);

  const summary: Summary = {
    vendor: "claude",
    taskId,
    startedAt: startWall,
    endedAt: endedAt.toISOString(),
    durationMs,
    eventCount,
    kindCounts,
    finalSessionId,
    scratchRepo,
    rawFile,
    truncated,
    error,
  };

  const summaryFile = path.join(capturesDir, `claude-${taskId}-summary.json`);
  await writeFile(summaryFile, JSON.stringify(summary, null, 2) + "\n");

  console.log(
    `[claude/${taskId}] events=${eventCount} duration=${durationMs}ms truncated=${truncated} err=${
      error ? "yes" : "no"
    }`,
  );
  return summary;
}

async function main() {
  const requested = process.argv.slice(2);
  const tasks = requested.length > 0
    ? (requested.filter((t) => (TASKS as string[]).includes(t)) as TaskId[])
    : TASKS;

  const results: Summary[] = [];
  for (const t of tasks) {
    results.push(await captureOne(t));
  }

  const all = path.join(SPIKE_ROOT, "captures", "claude-all-summary.json");
  await writeFile(all, JSON.stringify(results, null, 2) + "\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
