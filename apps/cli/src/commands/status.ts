/**
 * `shamu status` — list runs and their current state. Phase 1.D scaffold:
 * prints an empty list (persistence lands in 1.B). `--watch` polls on an
 * interval (placeholder until SQLite triggers land).
 */

import { defineCommand } from "citty";
import { ExitCode, type ExitCodeValue } from "../exit-codes.ts";
import { writeHuman, writeJson, writeWatch } from "../output.ts";
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
      description: "Tail-follow: re-render on change (placeholder polling until 1.B wires SQLite).",
      default: false,
    },
    "watch-interval": {
      type: "string",
      description: "Watch poll interval in milliseconds (default: 1000).",
      default: String(DEFAULT_WATCH_INTERVAL_MS),
    },
  },
  async run({ args }): Promise<ExitCodeValue> {
    const mode = outputMode(args);
    const svc = await withServices(args);
    if (!svc.ok) return svc.exitCode;

    const render = (): void => {
      if (svc.services.persistence === null) {
        // No backing store yet; emit a canonical "empty" payload so scripts
        // can pipe this command through `jq` today without special-casing.
        writeJson(mode, { kind: "status", runs: [], note: "persistence-not-wired" });
        if (mode === "human") {
          writeHuman(mode, "no active runs (persistence lands in Phase 1.B).");
        }
      }
    };

    if (args.watch) {
      const intervalMs = parsePositiveInt(args["watch-interval"], DEFAULT_WATCH_INTERVAL_MS);
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
