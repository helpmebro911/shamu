/**
 * `shamu logs <run-id>` — print the event stream for a run.
 *
 * Phase 1.E: reads from the SQLite `events` table. `--tail/-f` polls every
 * `--tail-interval` ms (default 500), stops on SIGINT or when a `turn_end`
 * arrives. `--since` filters by ISO-8601 wall timestamp.
 */

import type { AgentEvent } from "@shamu/adapters-base";
import { eventsQueries, type ShamuDatabase } from "@shamu/persistence";
import { runId as brandRunId } from "@shamu/shared";
import { defineCommand } from "citty";
import { ExitCode, type ExitCodeValue } from "../exit-codes.ts";
import { writeDiag, writeHuman, writeJson } from "../output.ts";
import { openRunDatabase } from "../services/run-db.ts";
import { commonArgs, done, outputMode, withServices } from "./_shared.ts";

const DEFAULT_TAIL_INTERVAL_MS = 500;

export const logsCommand = defineCommand({
  meta: {
    name: "logs",
    description: "Print the event log for a run. Use --tail/-f to follow.",
  },
  args: {
    ...commonArgs,
    "run-id": {
      type: "positional",
      description: "Run id to print logs for.",
      required: true,
    },
    tail: {
      type: "boolean",
      alias: "f",
      description: "Follow new events as they arrive (polls every --tail-interval ms).",
      default: false,
    },
    "tail-interval": {
      type: "string",
      description: "Tail poll interval in milliseconds (default: 500).",
      default: String(DEFAULT_TAIL_INTERVAL_MS),
    },
    since: {
      type: "string",
      description: "Only print events with ts_wall >= this ISO-8601 timestamp.",
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

    const runIdStr = args["run-id"];
    const sinceMs = parseSince(args.since);

    const stateDirArg = args["state-dir"];
    const stateDirOpt = stateDirArg ? { stateDir: stateDirArg } : {};

    let db: ShamuDatabase;
    try {
      db = openRunDatabase(stateDirOpt);
    } catch (err) {
      writeDiag(
        `logs: failed to open database: ${err instanceof Error ? err.message : String(err)}`,
      );
      return done(ExitCode.INTERNAL);
    }

    try {
      let lastSeq = 0;
      let sawTurnEnd = false;
      const runIdBranded = brandRunId(runIdStr);

      const render = (): void => {
        const events = eventsQueries.getEventsByRun(db, runIdBranded);
        for (const ev of events) {
          if (ev.seq <= lastSeq) continue;
          if (sinceMs !== null && ev.tsWall < sinceMs) {
            lastSeq = ev.seq;
            continue;
          }
          writeJson(mode, ev);
          writeHuman(mode, formatLogLine(ev));
          lastSeq = ev.seq;
          if (ev.kind === "turn_end") sawTurnEnd = true;
        }
      };

      render();

      if (args.tail) {
        if (sawTurnEnd) return done(ExitCode.OK);
        const intervalMs = parsePositiveInt(args["tail-interval"], DEFAULT_TAIL_INTERVAL_MS);
        const code = await tailLoop({ intervalMs, tick: render, stopWhen: () => sawTurnEnd });
        return done(code);
      }

      return done(ExitCode.OK);
    } finally {
      try {
        db.close();
      } catch {
        // ignore
      }
    }
  },
});

/**
 * Poll loop for `--tail`. Ticks on an interval; stops on SIGINT/SIGTERM or
 * when `stopWhen()` returns true (e.g., a `turn_end` arrived).
 */
async function tailLoop(params: {
  readonly intervalMs: number;
  readonly tick: () => void;
  readonly stopWhen: () => boolean;
}): Promise<ExitCodeValue> {
  const { intervalMs, tick, stopWhen } = params;
  let cancelled = false;
  let userCancelled = false;
  const onSigint = (): void => {
    cancelled = true;
    userCancelled = true;
  };
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigint);
  try {
    while (!cancelled) {
      await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
      if (cancelled) break;
      tick();
      if (stopWhen()) break;
    }
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigint);
  }
  return userCancelled ? ExitCode.USER_CANCEL : ExitCode.OK;
}

function parseSince(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parsePositiveInt(input: string | undefined, fallback: number): number {
  if (input === undefined) return fallback;
  const parsed = Number.parseInt(input, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

/** Render one event to a compact human-readable line. */
function formatLogLine(ev: AgentEvent): string {
  const ts = new Date(ev.tsWall).toISOString();
  const head = `${ts} [${ev.seq.toString().padStart(3, "0")}] ${ev.kind}`;
  switch (ev.kind) {
    case "session_start":
      return `${head} source=${ev.source}`;
    case "session_end":
      return `${head} reason=${ev.reason}`;
    case "reasoning":
    case "assistant_delta":
    case "assistant_message":
    case "stdout":
    case "stderr":
    case "checkpoint":
      return `${head} ${truncate("text" in ev ? ev.text : "summary" in ev ? ev.summary : "", 120)}`;
    case "tool_call":
      return `${head} ${ev.tool} id=${ev.toolCallId}`;
    case "tool_result":
      return `${head} ok=${ev.ok} bytes=${ev.bytes} ${truncate(ev.summary, 80)}`;
    case "patch_applied":
      return `${head} files=${ev.files.join(",")} +${ev.stats.add}/-${ev.stats.del}`;
    case "permission_request":
      return `${head} decision=${ev.decision} tool=${ev.toolCallId}`;
    case "usage":
      return `${head} model=${ev.model} in=${ev.tokens.input} out=${ev.tokens.output}`;
    case "cost":
      return `${head} usd=${ev.usd ?? "null"} confidence=${ev.confidence}`;
    case "rate_limit":
      return `${head} scope=${ev.scope} status=${ev.status}`;
    case "interrupt":
      return `${head} requestedBy=${ev.requestedBy} delivered=${ev.delivered}`;
    case "turn_end":
      return `${head} stop=${ev.stopReason} duration=${ev.durationMs}ms`;
    case "error":
      return `${head} fatal=${ev.fatal} code=${ev.errorCode}: ${truncate(ev.message, 120)}`;
  }
}

function truncate(text: string, max: number): string {
  if (!text) return "";
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}
