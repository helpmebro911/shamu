/**
 * `shamu ui` — open the local web dashboard in the default browser. The web
 * server lands in Phase 7; this scaffold just shapes the command surface.
 */

import { defineCommand } from "citty";
import type { ExitCodeValue } from "../exit-codes.ts";
import { commonArgs, notWiredYet, outputMode, withServices } from "./_shared.ts";

export const uiCommand = defineCommand({
  meta: {
    name: "ui",
    description: "Open the local web dashboard (Phase 7 ships the server).",
  },
  args: {
    ...commonArgs,
    port: {
      type: "string",
      description: "Dashboard port (default: auto-pick from config).",
    },
    "no-open": {
      type: "boolean",
      description: "Print the URL instead of launching a browser.",
      default: false,
    },
    "unsafe-bind": {
      type: "string",
      description:
        "Bind to an address other than 127.0.0.1. Prints a banner; auth is out of scope for v1.",
    },
  },
  async run({ args }): Promise<ExitCodeValue> {
    const mode = outputMode(args);
    const svc = await withServices(args);
    if (!svc.ok) return svc.exitCode;

    if (args["unsafe-bind"] !== undefined) {
      process.stderr.write(
        `\n  WARNING: --unsafe-bind=${args["unsafe-bind"]} — the dashboard is reachable off-localhost.\n  Authentication is out of scope for v1. Single-user, dev-laptop deploy only.\n\n`,
      );
      svc.services.logger.warn("ui: unsafe-bind active", { bind: args["unsafe-bind"] });
    }

    return notWiredYet({
      mode,
      command: "shamu ui",
      phase: "Phase 7",
      reason: "web dashboard (Hono + SolidJS) ships in Phase 7; see PLAN.md § UI plan → Surface 3.",
    });
  },
});
