/**
 * `shamu kill <run-id>` — signal a running agent to shut down. Needs the
 * supervisor (Phase 3); this scaffold returns INTERNAL with a clear notice.
 */

import { defineCommand } from "citty";
import type { ExitCodeValue } from "../exit-codes.ts";
import { commonArgs, notWiredYet, outputMode, withServices } from "./_shared.ts";

export const killCommand = defineCommand({
  meta: {
    name: "kill",
    description: "Signal a running agent to shut down (Phase 3 wires the supervisor).",
  },
  args: {
    ...commonArgs,
    "run-id": {
      type: "positional",
      description: "Run id to kill.",
      required: true,
    },
    reason: {
      type: "string",
      description: "Free-text reason attached to the shutdown signal.",
      default: "cli kill",
    },
  },
  async run({ args }): Promise<ExitCodeValue> {
    const mode = outputMode(args);
    const svc = await withServices(args);
    if (!svc.ok) return svc.exitCode;

    svc.services.logger.info("kill: accepted", {
      runId: args["run-id"],
      reason: args.reason,
    });

    return notWiredYet({
      mode,
      command: "shamu kill",
      phase: "Phase 3",
      reason: "supervisor lands in Phase 3; this command is a scaffold.",
    });
  },
});
