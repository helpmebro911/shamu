/**
 * StubServices — the only `Services` implementation that exists in Phase 1.D.
 *
 * `persistence` and `supervisor` are `null` (not yet wired). The logger writes
 * JSONL diagnostics to stderr so test runs and autonomous runs both have a
 * legible record without polluting stdout (which is the CLI's data surface).
 */

import { loadConfig } from "../config.ts";
import type { Logger, Services } from "./types.ts";

type LogLevel = "debug" | "info" | "warn" | "error";

class StderrLogger implements Logger {
  constructor(private readonly minLevel: LogLevel = "info") {}

  debug(message: string, fields?: Record<string, unknown>): void {
    this.emit("debug", message, fields);
  }

  info(message: string, fields?: Record<string, unknown>): void {
    this.emit("info", message, fields);
  }

  warn(message: string, fields?: Record<string, unknown>): void {
    this.emit("warn", message, fields);
  }

  error(message: string, fields?: Record<string, unknown>): void {
    this.emit("error", message, fields);
  }

  private emit(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
    if (!shouldLog(this.minLevel, level)) return;
    const entry = { ts: new Date().toISOString(), level, message, ...(fields ?? {}) };
    process.stderr.write(`${JSON.stringify(entry)}\n`);
  }
}

const levelRank: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function shouldLog(min: LogLevel, at: LogLevel): boolean {
  return levelRank[at] >= levelRank[min];
}

export interface StubServicesOptions {
  /** Path to a config file. Defaults to auto-discovery relative to cwd. */
  readonly configPath?: string;
  readonly cwd?: string;
  readonly logLevel?: LogLevel;
}

/**
 * Build a Services bundle for Phase 1.D. Loads config asynchronously and
 * returns the load Result so callers can branch on CONFIG_ERROR vs success
 * without throwing across the command boundary.
 */
export async function buildStubServices(
  options: StubServicesOptions = {},
): Promise<
  | { readonly ok: true; readonly services: Services; readonly configSource: string | null }
  | { readonly ok: false; readonly error: Error }
> {
  const loadParams: Parameters<typeof loadConfig>[0] = {};
  if (options.configPath !== undefined) loadParams.explicitPath = options.configPath;
  if (options.cwd !== undefined) loadParams.cwd = options.cwd;
  const loaded = await loadConfig(loadParams);
  if (!loaded.ok) return { ok: false, error: loaded.error };
  const services: Services = {
    config: loaded.value,
    logger: new StderrLogger(options.logLevel ?? "info"),
    persistence: null,
    supervisor: null,
  };
  return { ok: true, services, configSource: loaded.source };
}
