/**
 * `spawnWatchdogSubprocess` — starts the watchdog as a separate Bun
 * process.
 *
 * PLAN §6: the watchdog MUST run out-of-process. An in-process
 * watchdog that the stalled main process could silence is explicitly
 * not acceptable.
 *
 * The spawned process runs `bun <path-to-entry.ts>` with env
 * carrying the DB path and any config overrides. Events are parsed
 * line-by-line from stdout and forwarded to an optional emitter so
 * the parent can snoop on what the subprocess is seeing. Stderr is
 * relayed to the parent's stderr verbatim — the wrapper does not try
 * to interpret error messages.
 *
 * The returned handle exposes `stop()` which sends SIGTERM and waits
 * for the process to exit (with a hard-kill fallback after
 * `stopGraceMs`). The design is AbortController-shaped rather than
 * EventEmitter-shaped so callers can `await handle.stop()` inline.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { WatchdogEmitter, WatchdogEvent } from "./events.ts";
import type { WatchdogConfig } from "./types.ts";

/** Options for {@link spawnWatchdogSubprocess}. */
export interface SpawnWatchdogOptions {
  /** Path to the shamu SQLite database to observe (read-only). */
  readonly dbPath: string;
  /** Partial config override; merged over DEFAULT_WATCHDOG_CONFIG in entry.ts. */
  readonly config?: Partial<WatchdogConfig>;
  /** Tick interval in ms. Default 30_000. */
  readonly tickMs?: number;
  /** Path to `bun` binary. Default `bun` (resolved via PATH). */
  readonly bunPath?: string;
  /** Override for the entry script path (tests). */
  readonly entryPath?: string;
  /**
   * Optional emitter — if present, each JSON line from the subprocess
   * stdout is parsed and forwarded here.
   */
  readonly emit?: WatchdogEmitter;
  /** Grace period between SIGTERM and SIGKILL when stopping. Default 5000ms. */
  readonly stopGraceMs?: number;
}

/** Handle returned by {@link spawnWatchdogSubprocess}. */
export interface WatchdogHandle {
  readonly pid: number | null;
  /** Stop the subprocess gracefully; resolves when it has exited. */
  stop(): Promise<void>;
  /** Promise that resolves when the subprocess exits (for observation). */
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

function defaultEntryPath(): string {
  // `entry.ts` sits next to this file; under Bun we can execute it
  // directly without pre-compilation.
  const here = fileURLToPath(new URL("./entry.ts", import.meta.url));
  return here;
}

/**
 * Spawn the watchdog subprocess. The caller owns the returned
 * handle — if the caller never calls `handle.stop()` the subprocess
 * continues until its parent process exits.
 */
export function spawnWatchdogSubprocess(opts: SpawnWatchdogOptions): WatchdogHandle {
  const bunPath = opts.bunPath ?? "bun";
  const entry = opts.entryPath ?? defaultEntryPath();
  const stopGraceMs = opts.stopGraceMs ?? 5000;
  const env = {
    ...process.env,
    SHAMU_WATCHDOG_DB_PATH: opts.dbPath,
    SHAMU_WATCHDOG_TICK_MS: String(opts.tickMs ?? 30_000),
    ...(opts.config ? { SHAMU_WATCHDOG_CONFIG_JSON: JSON.stringify(opts.config) } : {}),
  };

  const child: ChildProcess = spawn(bunPath, [entry], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("exit", (code, signal) => {
      resolve({ code, signal });
    });
  });

  if (opts.emit && child.stdout) {
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let idx = buffer.indexOf("\n");
      while (idx !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.length > 0) forwardLine(line, opts.emit as WatchdogEmitter);
        idx = buffer.indexOf("\n");
      }
    });
  }
  if (child.stderr) {
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      process.stderr.write(chunk);
    });
  }

  const stop = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    const killed = await Promise.race([
      exited.then(() => true),
      new Promise<boolean>((resolve) => {
        setTimeout(() => resolve(false), stopGraceMs);
      }),
    ]);
    if (!killed) {
      child.kill("SIGKILL");
      await exited;
    }
  };

  return {
    pid: child.pid ?? null,
    stop,
    exited,
  };
}

function forwardLine(line: string, emit: WatchdogEmitter): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return;
  }
  if (!isWatchdogEvent(parsed)) return;
  emit.emit(parsed);
}

function isWatchdogEvent(value: unknown): value is WatchdogEvent {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { kind?: unknown };
  return v.kind === "watchdog.hint" || v.kind === "watchdog.alert";
}
