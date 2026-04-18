/**
 * `shamu flow` — parent group for flow subcommands.
 */

import { defineCommand } from "citty";
import { flowRunCommand } from "./run.ts";
import { flowStatusCommand } from "./status.ts";

export const flowCommand = defineCommand({
  meta: {
    name: "flow",
    description: "Flow orchestration (run, status). Flow engine lands in Phase 4.",
  },
  subCommands: {
    run: flowRunCommand,
    status: flowStatusCommand,
  },
});
