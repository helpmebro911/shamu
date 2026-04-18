/**
 * `shamu status` — list runs and their current state.
 *
 * Phase 1.E: reads the `runs` table from the CLI's SQLite DB. Shows one row
 * per run with its status and last-event timestamp (sourced from the
 * newest event in `events` for that run). `--watch` polls on an interval.
 */

import { eventsQueries, runsQueries, type ShamuDatabase } from "@shamu/persistence";
import { defineCommand } from "citty";
import { ExitCode, type ExitCodeValue } from "../exit-codes.ts";
import { writeDiag, writeHuman, writeJson, writeWatch } from "../output.ts";
import { openRunDatabase } from "../services/run-db.ts";
import { commonArgs, done, outputMode, withServices } from "./_shared.ts";

const DEFAULT_WATCH_INTERVAL_MS = 1000;

export const statusCommand = defineCommand({
  meta: {
    name: "status",
    description: "Show active and recent runs.",
  },
  args: {
    ...commonArgs,
    watch: {
      type: "boolean",
      alias: "w",
      description: "Tail-follow: re-render on an interval (polls --watch-interval ms).",
      default: false,
    },
    "watch-interval": {
      type: "string",
      description: "Watch poll interval in milliseconds (default: 1000).",
      default: String(DEFAULT_WATCH_INTERVAL_MS),
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

    const stateDirArg = args["state-dir"];
    const stateDirOpt = stateDirArg ? { stateDir: stateDirArg } : {};

    let db: ShamuDatabase;
    try {
      db = openRunDatabase(stateDirOpt);
    } catch (err) {
      writeDiag(
        `status: failed to open database: ${err instanceof Error ? err.message : String(err)}`,
      );
      return done(ExitCode.INTERNAL);
    }

    const render = (): void => {
      const runs = runsQueries.listRuns(db);
      const payload = runs.map((r) => {
        const events = eventsQueries.getEventsByRun(db, r.runId);
        const last = events[events.length - 1];
        return {
          runId: r.runId,
          role: r.role,
          vendor: r.vendor,
          status: r.status,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
          lastEventAt: last?.tsWall ?? null,
          lastEventKind: last?.kind ?? null,
          eventCount: events.length,
        };
      });

      if (mode === "json") {
        writeJson(mode, { kind: "status", runs: payload });
      } else if (payload.length === 0) {
        writeHuman(mode, "no active runs.");
      } else {
        for (const r of payload) {
          const lastTs = r.lastEventAt ? new Date(r.lastEventAt).toISOString() : "(no events)";
          writeHuman(
            mode,
            `${r.runId}  ${r.status.padEnd(10)} adapter=${r.vendor ?? "-"} role=${r.role ?? "-"} events=${r.eventCount} last=${lastTs}`,
          );
        }
      }
    };

    try {
      if (args.watch) {
        const intervalMs = parsePositiveInt(args["watch-interval"], DEFAULT_WATCH_INTERVAL_MS);
        await writeWatch(() => render(), { intervalMs });
        return done(ExitCode.USER_CANCEL);
      }
      render();
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

function parsePositiveInt(input: string | undefined, fallback: number): number {
  if (input === undefined) return fallback;
  const parsed = Number.parseInt(input, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}
