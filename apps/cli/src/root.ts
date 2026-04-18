/**
 * Root command wiring. Composes top-level subcommands and subcommand groups.
 *
 * Commands follow a standard shape: parse args → build Services → do work →
 * return an ExitCode. Handlers never call `process.exit` directly.
 */

import { defineCommand } from "citty";
import { attachCommand } from "./commands/attach.ts";
import { doctorCommand } from "./commands/doctor.ts";
import { flowCommand } from "./commands/flow/index.ts";
import { killCommand } from "./commands/kill.ts";
import { linearCommand } from "./commands/linear/index.ts";
import { logsCommand } from "./commands/logs.ts";
import { resumeCommand } from "./commands/resume.ts";
import { runCommand } from "./commands/run.ts";
import { statusCommand } from "./commands/status.ts";
import { uiCommand } from "./commands/ui.ts";

// Using `as unknown as typeof defineCommand` pattern avoids citty's generic
// type inference blowing up on modular subcommand objects. Every command
// returns a `CommandDef`, and a heterogeneous `subCommands` map is legal at
// runtime even when TS's inference can't stitch the union together.
export const root = defineCommand({
  meta: {
    name: "shamu",
    version: "0.0.0",
    description:
      "Shamu — multi-agent coding orchestrator. Phase 1 CLI shell: commands are scaffolds; supervisor/persistence/adapters wire in later phases.",
  },
  subCommands: {
    run: runCommand,
    resume: resumeCommand,
    status: statusCommand,
    logs: logsCommand,
    kill: killCommand,
    attach: attachCommand,
    doctor: doctorCommand,
    ui: uiCommand,
    flow: flowCommand,
    linear: linearCommand,
  },
});
