/**
 * `shamu logs <run-id>` — print the event stream for a run. Phase 1.D
 * scaffold: emits an empty stream (persistence lands in 1.B); `--tail`/`-f`
 * polls on an interval.
 */

import { defineCommand } from "citty";
import { ExitCode, type ExitCodeValue } from "../exit-codes.ts";
import { writeHuman, writeJson, writeWatch } from "../output.ts";
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
      description: "Follow new events as they arrive (polling placeholder until 1.B).",
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
  },
  async run({ args }): Promise<ExitCodeValue> {
    const mode = outputMode(args);
    const svc = await withServices(args);
    if (!svc.ok) return svc.exitCode;

    const runId = args["run-id"];

    const render = (): void => {
      if (svc.services.persistence === null) {
        writeJson(mode, {
          kind: "logs",
          runId,
          events: [],
          note: "persistence-not-wired",
        });
        if (mode === "human") {
          writeHuman(mode, `no events for ${runId} (persistence lands in Phase 1.B).`);
        }
      }
    };

    if (args.tail) {
      const intervalMs = parsePositiveInt(args["tail-interval"], DEFAULT_TAIL_INTERVAL_MS);
      render();
      await writeWatch(() => render(), { intervalMs });
      return done(ExitCode.USER_CANCEL);
    }

    render();
    return done(ExitCode.OK);
  },
});

function parsePositiveInt(input: string | undefined, fallback: number): number {
  if (input === undefined) return fallback;
  const parsed = Number.parseInt(input, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}
