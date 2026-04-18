/**
 * `shamu linear tunnel` — provision a cloudflared route that exposes ONLY
 * `/webhooks/linear`. Phase 6.B wires this to `@shamu/linear-webhook`'s
 * tunnel helper: spawns `cloudflared tunnel --url http://<host>:<port>`,
 * pipes stdout/stderr through so the user sees the ephemeral URL, and
 * reaps the child cleanly on SIGTERM.
 *
 * The receiver itself enforces the path-scope restriction (every other
 * route on the listener returns 404); cloudflared cannot filter by prefix.
 * This command's output reminds operators of that invariant per G10.
 */

import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  ENV_HOST,
  ENV_PORT,
  scopeMessage,
  startTunnel,
  TunnelBootError,
  WEBHOOK_PATH,
} from "@shamu/linear-webhook";
import { defineCommand } from "citty";
import { ExitCode, type ExitCodeValue } from "../../exit-codes.ts";
import { writeDiag } from "../../output.ts";
import { commonArgs, done, outputMode, withServices } from "../_shared.ts";

function resolvePort(explicit: string | undefined): number {
  if (explicit !== undefined && explicit.length > 0) {
    const parsed = Number.parseInt(explicit, 10);
    if (!Number.isNaN(parsed) && parsed >= 0) return parsed;
  }
  const env = process.env[ENV_PORT];
  if (env && env.length > 0) {
    const parsed = Number.parseInt(env, 10);
    if (!Number.isNaN(parsed) && parsed >= 0) return parsed;
  }
  return DEFAULT_PORT;
}

function resolveHost(): string {
  const env = process.env[ENV_HOST];
  if (env && env.length > 0) return env;
  return DEFAULT_HOST;
}

export const linearTunnelCommand = defineCommand({
  meta: {
    name: "tunnel",
    description: "Open a cloudflared tunnel restricted to /webhooks/linear (Phase 6).",
  },
  args: {
    ...commonArgs,
    "webhook-port": {
      type: "string",
      description: "Local port the webhook receiver listens on (default: 7357 or env).",
    },
  },
  async run({ args }): Promise<ExitCodeValue> {
    const mode = outputMode(args);
    const svc = await withServices(args);
    if (!svc.ok) return svc.exitCode;

    const port = resolvePort(args["webhook-port"]);
    const host = resolveHost();

    svc.services.logger.info("linear tunnel: starting cloudflared", {
      host,
      port,
      path: WEBHOOK_PATH,
    });

    if (mode !== "json") {
      process.stdout.write(`${scopeMessage(WEBHOOK_PATH)}\n`);
    }

    // Optional override so operators (and tests) can point at a specific
    // cloudflared binary without depending on PATH resolution. Real usage
    // almost always uses the PATH default.
    const binOverride = process.env.SHAMU_LINEAR_TUNNEL_BIN;
    let handle: ReturnType<typeof startTunnel>;
    try {
      handle = startTunnel({
        host,
        port,
        ...(binOverride && binOverride.length > 0 ? { bin: binOverride } : {}),
      });
    } catch (cause) {
      const message =
        cause instanceof TunnelBootError
          ? cause.message
          : cause instanceof Error
            ? cause.message
            : String(cause);
      if (mode === "json") {
        process.stdout.write(
          `${JSON.stringify({
            kind: "error",
            category: "tunnel-boot",
            command: "shamu linear tunnel",
            message,
          })}\n`,
        );
      } else {
        writeDiag(`shamu linear tunnel: ${message}`);
      }
      return done(ExitCode.INTERNAL);
    }

    svc.services.logger.info("linear tunnel: cloudflared launched", { pid: handle.pid });
    const exit = await handle.exited;
    svc.services.logger.info("linear tunnel: cloudflared exited", {
      code: exit.code,
      signal: exit.signal,
    });
    return done(exit.code === 0 || exit.signal === "SIGTERM" ? ExitCode.OK : ExitCode.INTERNAL);
  },
});
