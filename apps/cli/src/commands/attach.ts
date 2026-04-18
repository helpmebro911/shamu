/**
 * `shamu attach <run-id>` — attach the TTY to a running agent for interactive
 * message sending. Needs the TUI + supervisor; lands in Phase 3. Phase 1.D is
 * a scaffold.
 */

import { defineCommand } from "citty";
import type { ExitCodeValue } from "../exit-codes.ts";
import { commonArgs, notWiredYet, outputMode, withServices } from "./_shared.ts";

export const attachCommand = defineCommand({
  meta: {
    name: "attach",
    description: "Attach to a running agent (Phase 3 wires the supervisor + TUI).",
  },
  args: {
    ...commonArgs,
    "run-id": {
      type: "positional",
      description: "Run id to attach to.",
      required: true,
    },
  },
  async run({ args }): Promise<ExitCodeValue> {
    const mode = outputMode(args);
    const svc = await withServices(args);
    if (!svc.ok) return svc.exitCode;

    svc.services.logger.info("attach: accepted", { runId: args["run-id"] });

    return notWiredYet({
      mode,
      command: "shamu attach",
      phase: "Phase 3",
      reason: "requires supervisor + interactive TUI; lands alongside `shamu tui` in Phase 3.",
    });
  },
});
