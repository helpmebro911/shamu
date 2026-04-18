/**
 * `shamu run` — start a new agent run. Phase 1.D scaffold: parses args,
 * validates the shape, and emits a deterministic `run-accepted` event. The
 * supervisor wiring lands in Phase 3; until then this exits INTERNAL with a
 * clear "not wired yet" notice.
 */

import { defineCommand } from "citty";
import type { ExitCodeValue } from "../exit-codes.ts";
import { writeHuman, writeJson } from "../output.ts";
import { commonArgs, notWiredYet, outputMode, withServices } from "./_shared.ts";

export const runCommand = defineCommand({
  meta: {
    name: "run",
    description: "Start a new agent run (Phase 3 wires the supervisor).",
  },
  args: {
    ...commonArgs,
    task: {
      type: "string",
      description: "Task description passed to the planner agent.",
      required: true,
    },
    adapter: {
      type: "string",
      description: "Vendor adapter to use (e.g. echo, claude, codex).",
      default: "echo",
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
  },
  async run({ args }): Promise<ExitCodeValue> {
    const mode = outputMode(args);
    const svc = await withServices(args);
    if (!svc.ok) return svc.exitCode;

    // Log that the args resolved — useful for autonomous callers diffing output.
    svc.services.logger.info("run: accepted", {
      task: args.task,
      adapter: args.adapter,
      role: args.role,
      dryRun: args["dry-run"],
    });

    if (args["dry-run"]) {
      writeJson(mode, {
        kind: "run-validated",
        task: args.task,
        adapter: args.adapter,
        role: args.role,
      });
      writeHuman(mode, `run validated: adapter=${args.adapter} role=${args.role}`);
      writeHuman(mode, `  task: ${args.task}`);
      return 0;
    }

    return notWiredYet({
      mode,
      command: "shamu run",
      phase: "Phase 3",
      reason:
        "supervisor + adapter orchestration lands in Phase 3; see PLAN.md § Phased delivery → Phase 3.",
    });
  },
});
