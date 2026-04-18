/**
 * `shamu flow status <flow-run-id>` — show status of a running flow.
 * Persistence + flow engine land in Phase 4; Phase 1.D is a scaffold.
 */

import { defineCommand } from "citty";
import type { ExitCodeValue } from "../../exit-codes.ts";
import { commonArgs, notWiredYet, outputMode, withServices } from "../_shared.ts";

export const flowStatusCommand = defineCommand({
  meta: {
    name: "status",
    description: "Show flow-run status (Phase 4 wires the flow engine).",
  },
  args: {
    ...commonArgs,
    "flow-run-id": {
      type: "positional",
      description: "Flow-run id.",
      required: true,
    },
  },
  async run({ args }): Promise<ExitCodeValue> {
    const mode = outputMode(args);
    const svc = await withServices(args);
    if (!svc.ok) return svc.exitCode;

    svc.services.logger.info("flow status: accepted", { flowRunId: args["flow-run-id"] });

    return notWiredYet({
      mode,
      command: "shamu flow status",
      phase: "Phase 4",
      reason: "flow engine + persistence wiring land in Phase 4.",
    });
  },
});
