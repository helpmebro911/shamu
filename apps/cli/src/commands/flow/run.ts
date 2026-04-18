/**
 * `shamu flow run <name> --task "..."` — start a flow. Flow engine lands in
 * Phase 4; Phase 1.D is a scaffold.
 */

import { defineCommand } from "citty";
import type { ExitCodeValue } from "../../exit-codes.ts";
import { commonArgs, notWiredYet, outputMode, withServices } from "../_shared.ts";

export const flowRunCommand = defineCommand({
  meta: {
    name: "run",
    description: "Run a flow by name (Phase 4 wires the flow engine).",
  },
  args: {
    ...commonArgs,
    name: {
      type: "positional",
      description: "Flow name (e.g. plan-execute-review).",
      required: true,
    },
    task: {
      type: "string",
      description: "Task description passed to the planner node.",
      required: true,
    },
  },
  async run({ args }): Promise<ExitCodeValue> {
    const mode = outputMode(args);
    const svc = await withServices(args);
    if (!svc.ok) return svc.exitCode;

    svc.services.logger.info("flow run: accepted", { flow: args.name, task: args.task });

    return notWiredYet({
      mode,
      command: "shamu flow run",
      phase: "Phase 4",
      reason: "flow DAG engine lands in Phase 4; see PLAN.md § Phased delivery → Phase 4.",
    });
  },
});
