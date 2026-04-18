/**
 * `shamu run` — start a new agent run.
 *
 * Phase 1.E scope:
 * - `--adapter echo` spawns the in-memory echo adapter, drives one turn with
 *   `--task <text>`, streams each event to stdout (human lines or `--json`
 *   NDJSON), and persists both the normalized projection and the raw
 *   payload to SQLite via `@shamu/persistence`.
 * - Adapters not yet wired (`claude`, `codex`, …) exit INTERNAL with a
 *   "lands in Phase N" notice.
 * - SIGINT interrupts the handle cooperatively; after the handle drains we
 *   exit 13 (INTERRUPTED). A fatal `error` event exits 10 (RUN_FAILED).
 *   Normal `turn_end` exits 0.
 *
 * The orchestration is deliberately thin — a real supervisor lands in Phase
 * 3 — but the events written here are the same shape the supervisor will
 * write, so downstream consumers (TUI, dashboard) only wire up once.
 */

import type { AgentHandle } from "@shamu/adapters-base";
import { eventsQueries, runsQueries, type ShamuDatabase } from "@shamu/persistence";
import { eventId as brandEventId, newRunId, type RunId } from "@shamu/shared";
import { defineCommand } from "citty";
import { ExitCode, type ExitCodeValue } from "../exit-codes.ts";
import { modeFrom, type OutputMode, writeDiag, writeHuman, writeJson } from "../output.ts";
import { isKnownAdapter, knownAdapterNames, loadAdapter } from "../services/adapters.ts";
import { openRunDatabase } from "../services/run-db.ts";
import { commonArgs, done, outputMode, withServices } from "./_shared.ts";

export const runCommand = defineCommand({
  meta: {
    name: "run",
    description:
      "Start a new agent run. Phase 1.E: `--adapter echo` round-trips a scripted session; other vendors land in Phase 2.",
  },
  args: {
    ...commonArgs,
    task: {
      type: "string",
      description: "Task description passed to the adapter as the first user turn.",
      required: true,
    },
    adapter: {
      type: "string",
      description: `Vendor adapter to use (one of: ${knownAdapterNames().join(", ")}).`,
    },
    role: {
      type: "string",
      description: "Role to run under (planner|executor|reviewer).",
      default: "executor",
    },
    "dry-run": {
      type: "boolean",
      description: "Validate inputs and exit without spawning anything.",
      default: false,
    },
    "state-dir": {
      type: "string",
      description:
        "Directory for the SQLite state file (overrides $SHAMU_STATE_DIR; default .shamu/state).",
    },
  },
  async run({ args }): Promise<ExitCodeValue> {
    const mode = outputMode(args);
    const svc = await withServices(args);
    if (!svc.ok) return svc.exitCode;

    const rawAdapter = args.adapter ?? "";
    if (!rawAdapter) {
      writeDiag(
        `run: --adapter is required (known adapters: ${knownAdapterNames().join(", ")}; try --adapter echo for a smoke run)`,
      );
      return done(ExitCode.USAGE);
    }
    if (!isKnownAdapter(rawAdapter)) {
      writeDiag(`run: unknown adapter '${rawAdapter}' (known: ${knownAdapterNames().join(", ")})`);
      return done(ExitCode.USAGE);
    }

    svc.services.logger.info("run: accepted", {
      task: args.task,
      adapter: rawAdapter,
      role: args.role,
      dryRun: args["dry-run"],
    });

    if (args["dry-run"]) {
      writeJson(mode, {
        kind: "run-validated",
        task: args.task,
        adapter: rawAdapter,
        role: args.role,
      });
      writeHuman(mode, `run validated: adapter=${rawAdapter} role=${args.role}`);
      writeHuman(mode, `  task: ${args.task}`);
      return done(ExitCode.OK);
    }

    const stateDirArg = args["state-dir"];
    const stateDirOpt = stateDirArg ? { stateDir: stateDirArg } : {};
    let db: ShamuDatabase;
    try {
      db = openRunDatabase(stateDirOpt);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      writeDiag(`run: failed to open SQLite database: ${message}`);
      return done(ExitCode.INTERNAL);
    }

    try {
      const adapter = await loadAdapter(rawAdapter);
      // Phase 2+: the CLI (standing in for the Phase 3 supervisor) is the
      // authoritative source of `runId`. The adapter must adopt the id we
      // hand it via SpawnOpts — asserting equality here catches any vendor
      // adapter that tries to fabricate identity (G8 from threat model).
      const runId = newRunId();
      const handle = await adapter.spawn({ cwd: process.cwd(), runId });
      if (handle.runId !== runId) {
        writeDiag(
          `run: adapter ${rawAdapter} returned handle.runId=${handle.runId} ` +
            `but was spawned with runId=${runId}; refusing to continue`,
        );
        await handle.shutdown("runid-mismatch");
        return done(ExitCode.INTERNAL);
      }
      runsQueries.insertRun(db, {
        runId,
        role: args.role,
        vendor: adapter.vendor,
        status: "running",
      });
      writeJson(mode, {
        kind: "run-started",
        runId,
        adapter: rawAdapter,
        role: args.role,
      });
      writeHuman(mode, `run ${runId} started (adapter=${rawAdapter} role=${args.role})`);

      await handle.send({ text: args.task });

      const exitCode = await streamHandle({
        handle,
        db,
        runId,
        mode,
        adapterName: rawAdapter,
      });

      // Final status projection from exit code.
      const terminal =
        exitCode === ExitCode.OK
          ? "completed"
          : exitCode === ExitCode.INTERRUPTED
            ? "failed"
            : "failed";
      runsQueries.updateRunStatus(db, runId, terminal);
      await handle.shutdown("run-complete");
      return done(exitCode);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      writeDiag(`run: ${message}`);
      return done(ExitCode.INTERNAL);
    } finally {
      try {
        db.close();
      } catch {
        // best-effort close; errors here shouldn't mask the command result.
      }
    }
  },
});

/**
 * Drain an adapter handle: persist each event to SQLite (`events` +
 * `raw_events`), render it to stdout, and decide the exit code from the
 * terminal event.
 *
 * Cooperative-interrupt behavior: SIGINT triggers `handle.interrupt()` once,
 * then keeps draining until the adapter emits `turn_end` (or the stream
 * closes). If a second SIGINT arrives we stop reading — the handle's
 * shutdown is called by the outer `finally`.
 */
async function streamHandle(params: {
  readonly handle: AgentHandle;
  readonly db: ShamuDatabase;
  readonly runId: RunId;
  readonly mode: OutputMode;
  readonly adapterName: string;
}): Promise<ExitCodeValue> {
  const { handle, db, runId, mode, adapterName } = params;
  let interrupts = 0;
  let sawFatalError = false;
  let forced = false;
  const onSigint = (): void => {
    interrupts += 1;
    if (interrupts === 1) {
      void handle.interrupt("sigint").catch(() => {});
    } else {
      forced = true;
    }
  };
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigint);

  try {
    for await (const ev of handle.events) {
      // Persist (events + raw). Raw is the same payload for now — a real
      // vendor adapter carries a distinct "before normalization" blob.
      try {
        eventsQueries.insertRawEvent(db, {
          eventId: brandEventId(ev.eventId),
          runId,
          vendor: adapterName,
          ts: ev.tsWall,
          payload: ev,
        });
        eventsQueries.insertEvent(db, ev);
      } catch (err) {
        // Persistence failure should not silently drop; surface to diagnostic
        // so a caller can triage.
        writeDiag(
          `run: failed to persist event ${ev.eventId} (${ev.kind}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }

      // Output.
      writeJson(mode, ev);
      writeHuman(mode, formatEventLine(ev));

      if (ev.kind === "error" && ev.fatal) {
        sawFatalError = true;
      }
      if (ev.kind === "turn_end") break;
      if (forced) break;
    }
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigint);
  }

  if (interrupts > 0) return ExitCode.INTERRUPTED;
  if (sawFatalError) return ExitCode.RUN_FAILED;
  return ExitCode.OK;
}

/** Render one event to a compact human-readable line. */
function formatEventLine(ev: import("@shamu/adapters-base").AgentEvent): string {
  const head = `[${ev.seq.toString().padStart(3, "0")}] ${ev.kind}`;
  switch (ev.kind) {
    case "session_start":
      return `${head} source=${ev.source} session=${ev.sessionId ?? "-"}`;
    case "session_end":
      return `${head} reason=${ev.reason}`;
    case "reasoning":
      return `${head} ${truncate(ev.text, 120)}`;
    case "assistant_delta":
      return `${head} ${truncate(ev.text, 120)}`;
    case "assistant_message":
      return `${head} stop=${ev.stopReason} ${truncate(ev.text, 120)}`;
    case "tool_call":
      return `${head} ${ev.tool} id=${ev.toolCallId}`;
    case "tool_result":
      return `${head} ok=${ev.ok} bytes=${ev.bytes} ${truncate(ev.summary, 80)}`;
    case "permission_request":
      return `${head} decision=${ev.decision} tool=${ev.toolCallId}`;
    case "patch_applied":
      return `${head} files=${ev.files.join(",")} +${ev.stats.add}/-${ev.stats.del}`;
    case "checkpoint":
      return `${head} ${truncate(ev.summary, 120)}`;
    case "stdout":
    case "stderr":
      return `${head} ${truncate(ev.text, 120)}`;
    case "usage":
      return `${head} model=${ev.model} in=${ev.tokens.input} out=${ev.tokens.output}`;
    case "cost":
      return `${head} usd=${ev.usd ?? "null"} confidence=${ev.confidence} source=${ev.source}`;
    case "rate_limit":
      return `${head} scope=${ev.scope} status=${ev.status}`;
    case "interrupt":
      return `${head} requestedBy=${ev.requestedBy} delivered=${ev.delivered}`;
    case "turn_end":
      return `${head} stop=${ev.stopReason} duration=${ev.durationMs}ms`;
    case "error":
      return `${head} fatal=${ev.fatal} retriable=${ev.retriable} code=${ev.errorCode}: ${truncate(ev.message, 120)}`;
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

/** Exposed so tests can mock output-mode resolution without re-parsing args. */
export const __testable = { modeFrom };
