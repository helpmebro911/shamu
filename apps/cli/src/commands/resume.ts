/**
 * `shamu resume <run-id>` — warm-resume a previously-created run. Phase 1.D
 * scaffold only; session↔run mapping persistence lands in Phase 2.C.
 */

import { defineCommand } from "citty";
import type { ExitCodeValue } from "../exit-codes.ts";
import { commonArgs, notWiredYet, outputMode, withServices } from "./_shared.ts";

export const resumeCommand = defineCommand({
  meta: {
    name: "resume",
    description: "Resume a previously-started run by id (Phase 2 wires persistence).",
  },
  args: {
    ...commonArgs,
    "run-id": {
      type: "positional",
      description: "Run id to resume.",
      required: true,
    },
  },
  async run({ args }): Promise<ExitCodeValue> {
    const mode = outputMode(args);
    const svc = await withServices(args);
    if (!svc.ok) return svc.exitCode;

    svc.services.logger.info("resume: accepted", { runId: args["run-id"] });

    return notWiredYet({
      mode,
      command: "shamu resume",
      phase: "Phase 2.C",
      reason:
        "session↔run mapping and vendor resume API integration land in Phase 2; see PLAN.md § Phased delivery → Phase 2.",
    });
  },
});
