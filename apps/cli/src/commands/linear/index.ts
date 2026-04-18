/**
 * `shamu linear` — parent group for Linear integration subcommands.
 */

import { defineCommand } from "citty";
import { linearTunnelCommand } from "./tunnel.ts";

export const linearCommand = defineCommand({
  meta: {
    name: "linear",
    description: "Linear integration (tunnel, …). Integration lands in Phase 6.",
  },
  subCommands: {
    tunnel: linearTunnelCommand,
  },
});
