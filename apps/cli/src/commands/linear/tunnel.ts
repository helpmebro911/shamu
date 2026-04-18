/**
 * `shamu linear tunnel` — provision a cloudflared route that exposes ONLY
 * `/webhooks/linear`. Lands in Phase 6 (webhook receiver + cloudflared
 * shell-out). Phase 1.D is a scaffold that enforces the dashboard-never-
 * exposed invariant in its help text and logs the request.
 */

import { defineCommand } from "citty";
import type { ExitCodeValue } from "../../exit-codes.ts";
import { commonArgs, notWiredYet, outputMode, withServices } from "../_shared.ts";

export const linearTunnelCommand = defineCommand({
  meta: {
    name: "tunnel",
    description: "Open a cloudflared tunnel restricted to /webhooks/linear (Phase 6).",
  },
  args: {
    ...commonArgs,
    "webhook-port": {
      type: "string",
      description: "Local port the webhook receiver listens on (default: from config).",
    },
  },
  async run({ args }): Promise<ExitCodeValue> {
    const mode = outputMode(args);
    const svc = await withServices(args);
    if (!svc.ok) return svc.exitCode;

    svc.services.logger.info("linear tunnel: accepted", {
      webhookPort: args["webhook-port"] ?? null,
    });

    return notWiredYet({
      mode,
      command: "shamu linear tunnel",
      phase: "Phase 6",
      reason:
        "cloudflared shell-out + webhook receiver land in Phase 6. Tunnel scope is restricted to /webhooks/linear only; dashboard port is never exposed (G10).",
    });
  },
});
