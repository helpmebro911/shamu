// Codex capture harness.
//
// Runs the Codex SDK against a freshly-seeded scratch repo for one canonical
// task, streams ThreadEvents to completion, and writes them verbatim to JSONL.
// No normalization.
//
// Auth model: Codex CLI at /opt/homebrew/bin/codex is logged in via ChatGPT
// OAuth; session lives in ~/.codex/auth.json. The SDK spawns `codex`, which
// reads that file on start. We do NOT set CODEX_API_KEY / OPENAI_API_KEY.
// We pass codexPathOverride so the SDK doesn't fall back to PATH resolution.

import { mkdir, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { Codex, type ThreadEvent } from "@openai/codex-sdk";
import { resetScratchRepo, taskPrompt, type TaskId } from "./scratch.ts";

const CODEX_CLI = "/opt/homebrew/bin/codex";
const SPIKE_ROOT = new URL("..", import.meta.url).pathname;

const TASKS: TaskId[] = ["bugfix", "refactor", "new-feature"];

type Summary = {
  vendor: "codex";
  taskId: TaskId;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  eventCount: number;
  kindCounts: Record<string, number>;
  finalThreadId: string | null;
  scratchRepo: string;
  rawFile: string;
  truncated: boolean;
  error: string | null;
};

async function captureOne(taskId: TaskId): Promise<Summary> {
  const scratchRepo = await resetScratchRepo("codex", taskId);
  const capturesDir = path.join(SPIKE_ROOT, "captures");
  await mkdir(capturesDir, { recursive: true });

  const rawFile = path.join(capturesDir, `codex-${taskId}-raw.jsonl`);
  await writeFile(rawFile, "");

  const prompt = taskPrompt(taskId);
  const startedAt = new Date();
  const startWall = startedAt.toISOString();
  const startMonotonic = performance.now();

  const kindCounts: Record<string, number> = {};
  let eventCount = 0;
  let finalThreadId: string | null = null;
  let truncated = false;
  let error: string | null = null;

  const TURN_TIMEOUT_MS = 4 * 60 * 1000;
  const abort = new AbortController();
  const timeoutHandle = setTimeout(() => {
    truncated = true;
    abort.abort();
  }, TURN_TIMEOUT_MS);

  try {
    const codex = new Codex({ codexPathOverride: CODEX_CLI });
    const thread = codex.startThread({
      workingDirectory: scratchRepo,
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      skipGitRepoCheck: false,
    });

    const { events } = await thread.runStreamed(prompt, { signal: abort.signal });

    for await (const ev of events as AsyncGenerator<ThreadEvent>) {
      eventCount += 1;
      const kind = (ev as any).type ?? "unknown";
      // Codex `item.*` events carry an inner item.type — record the pair.
      const itemType = (ev as any).item?.type;
      const counterKey = itemType ? `${kind}:${itemType}` : String(kind);
      kindCounts[counterKey] = (kindCounts[counterKey] ?? 0) + 1;

      if (kind === "thread.started") {
        finalThreadId = (ev as any).thread_id ?? null;
      }

      await appendFile(rawFile, JSON.stringify(ev) + "\n");

      if (kind === "turn.completed" || kind === "turn.failed" || kind === "error") {
        break;
      }
    }

    // Grab the thread id if it was populated only after start.
    if (!finalThreadId && thread.id) {
      finalThreadId = thread.id;
    }
  } catch (e: any) {
    error = String(e?.stack ?? e?.message ?? e);
  } finally {
    clearTimeout(timeoutHandle);
  }

  const endedAt = new Date();
  const durationMs = Math.round(performance.now() - startMonotonic);

  const summary: Summary = {
    vendor: "codex",
    taskId,
    startedAt: startWall,
    endedAt: endedAt.toISOString(),
    durationMs,
    eventCount,
    kindCounts,
    finalThreadId,
    scratchRepo,
    rawFile,
    truncated,
    error,
  };

  const summaryFile = path.join(capturesDir, `codex-${taskId}-summary.json`);
  await writeFile(summaryFile, JSON.stringify(summary, null, 2) + "\n");

  console.log(
    `[codex/${taskId}] events=${eventCount} duration=${durationMs}ms truncated=${truncated} err=${
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

  const all = path.join(SPIKE_ROOT, "captures", "codex-all-summary.json");
  await writeFile(all, JSON.stringify(results, null, 2) + "\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
