/**
 * Command helpers shared by every top-level and nested subcommand.
 */

import type { ConfigError } from "../config.ts";
import { ExitCode, type ExitCodeValue } from "../exit-codes.ts";
import { modeFrom, type OutputMode, writeDiag } from "../output.ts";
import { setExitCode } from "../runner.ts";
import { buildStubServices } from "../services/stub.ts";
import type { Services } from "../services/types.ts";

/** Standard flags every command gets. */
export const commonArgs = {
  json: {
    type: "boolean",
    description: "Emit newline-delimited JSON to stdout instead of human text.",
    default: false,
  },
  config: {
    type: "string",
    description: "Path to a shamu.config.ts (default: auto-discover from cwd).",
  },
  "log-level": {
    type: "string",
    description: "Logger min level: debug|info|warn|error (default: info).",
    default: "info",
  },
} as const;

export interface CommonArgs {
  readonly json: boolean;
  readonly config?: string;
  readonly "log-level"?: string;
}

/**
 * Record and return an ExitCode. Command handlers call this at their tail so
 * the entry point can `process.exit` exactly once.
 */
export function done(code: ExitCodeValue): ExitCodeValue {
  return setExitCode(code);
}

/** Pull the `--json`-controlled output mode out of parsed args. */
export function outputMode(args: CommonArgs): OutputMode {
  return modeFrom({ json: args.json });
}

export interface WithServicesOk {
  readonly ok: true;
  readonly services: Services;
  readonly configSource: string | null;
}

export interface WithServicesErr {
  readonly ok: false;
  readonly exitCode: ExitCodeValue;
}

/**
 * Build stub services for a command. On failure, emits a `--json`-aware error
 * payload and returns an ExitCode the caller should propagate directly.
 */
export async function withServices(args: CommonArgs): Promise<WithServicesOk | WithServicesErr> {
  const mode = outputMode(args);
  const level = args["log-level"];
  const logLevel =
    level === "debug" || level === "info" || level === "warn" || level === "error"
      ? level
      : undefined;
  const options = {
    ...(args.config !== undefined ? { configPath: args.config } : {}),
    ...(logLevel !== undefined ? { logLevel } : {}),
  } satisfies Parameters<typeof buildStubServices>[0];
  const result = await buildStubServices(options);
  if (result.ok) {
    return { ok: true, services: result.services, configSource: result.configSource };
  }

  const err = result.error;
  const kind = (err as ConfigError).kind;
  const message = err.message;
  const path = (err as ConfigError).path;
  if (mode === "json") {
    process.stdout.write(
      `${JSON.stringify({ kind: "error", category: "config", configKind: kind, path, message })}\n`,
    );
  } else {
    writeDiag(`config error (${kind}): ${message}`);
  }
  // CONFIG_ERROR for parse/validate; USAGE for import (file missing / path wrong).
  const code = kind === "import" ? ExitCode.CONFIG_ERROR : ExitCode.CONFIG_ERROR;
  return { ok: false, exitCode: code };
}

/**
 * Standard "feature not wired yet" response. Commands that need persistence or
 * supervisor wiring call this with a short reason; exits INTERNAL with a clear
 * phase marker so users know when it will light up.
 */
export function notWiredYet(params: {
  mode: OutputMode;
  command: string;
  phase: string;
  reason: string;
}): ExitCodeValue {
  if (params.mode === "json") {
    process.stdout.write(
      `${JSON.stringify({
        kind: "error",
        category: "not-wired",
        command: params.command,
        phase: params.phase,
        message: params.reason,
      })}\n`,
    );
  } else {
    writeDiag(`${params.command}: not available until ${params.phase} (${params.reason})`);
  }
  return done(ExitCode.INTERNAL);
}
