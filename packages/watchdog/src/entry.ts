/**
 * Subprocess entry point.
 *
 * This module is executed by `bun run ./src/entry.ts` from the
 * subprocess wrapper (`subprocess.ts`). It:
 *
 *   1. Reads configuration from env vars + argv.
 *   2. Opens the SQLite DB in read-only mode.
 *   3. Loops `runWatchdog` at the configured interval.
 *   4. Emits events as JSON-lines to stdout.
 *   5. Shuts down cleanly on SIGTERM / SIGINT.
 *
 * We intentionally avoid pulling in `@shamu/core-supervisor` here —
 * the subprocess publishes structural events to its parent via
 * stdout; the composition layer wires those onto the supervisor bus.
 *
 * Configuration sources (highest precedence first):
 *   - `SHAMU_WATCHDOG_DB_PATH`    — required, path to shamu.sqlite.
 *   - `SHAMU_WATCHDOG_TICK_MS`    — optional, default 30_000.
 *   - `SHAMU_WATCHDOG_CONFIG_JSON`— optional, a JSON-encoded partial
 *                                   {@link WatchdogConfig} merged over
 *                                   defaults.
 *
 * CI contracts: this module does NOT import `bun:test` or anything
 * that would pull in Bun's test runner. It's a plain script.
 */

import type { WatchdogEmitter, WatchdogEvent } from "./events.ts";
import { openReadOnlyDatabase } from "./store.ts";
import { DEFAULT_WATCHDOG_CONFIG, type WatchdogConfig } from "./types.ts";
import { createWatchdogState, runWatchdog } from "./watchdog.ts";

/** Parse env config overrides; throws on malformed JSON. */
function resolveConfig(env: NodeJS.ProcessEnv): WatchdogConfig {
  const raw = env.SHAMU_WATCHDOG_CONFIG_JSON;
  if (raw === undefined || raw.length === 0) return DEFAULT_WATCHDOG_CONFIG;
  let overrides: Partial<WatchdogConfig>;
  try {
    overrides = JSON.parse(raw) as Partial<WatchdogConfig>;
  } catch (cause) {
    throw new Error(`SHAMU_WATCHDOG_CONFIG_JSON is not valid JSON: ${String(cause)}`);
  }
  return { ...DEFAULT_WATCHDOG_CONFIG, ...overrides };
}

function stdoutEmitter(): WatchdogEmitter {
  return {
    emit(event: WatchdogEvent) {
      // One JSON document per line; the parent process parses each
      // line as an event. `process.stdout.write` is synchronous for
      // pipes so order is preserved.
      process.stdout.write(`${JSON.stringify(event)}\n`);
    },
  };
}

async function main(): Promise<void> {
  const dbPath = process.env.SHAMU_WATCHDOG_DB_PATH;
  if (typeof dbPath !== "string" || dbPath.length === 0) {
    throw new Error("SHAMU_WATCHDOG_DB_PATH environment variable is required");
  }
  const tickMs = Number(process.env.SHAMU_WATCHDOG_TICK_MS ?? 30_000);
  if (!Number.isFinite(tickMs) || tickMs <= 0) {
    throw new Error(
      `SHAMU_WATCHDOG_TICK_MS must be a positive number; got "${process.env.SHAMU_WATCHDOG_TICK_MS}"`,
    );
  }
  const config = resolveConfig(process.env);
  const db = openReadOnlyDatabase(dbPath);
  const state = createWatchdogState(config);
  const emit = stdoutEmitter();

  let stopped = false;
  const stop = (): void => {
    stopped = true;
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  while (!stopped) {
    try {
      runWatchdog({ db, now: Date.now(), config, emit, state });
    } catch (cause) {
      // Log and keep going — a single failed tick should not take the
      // watchdog down. The subprocess wrapper can count these on
      // stderr.
      process.stderr.write(
        `watchdog tick failed: ${cause instanceof Error ? cause.message : String(cause)}\n`,
      );
    }
    await sleep(tickMs, () => stopped);
  }
  db.close();
}

/**
 * Cancellable sleep — polls `shouldStop` every `Math.min(ms, 100)` so
 * SIGTERM arriving mid-sleep takes effect within ~100ms rather than
 * having to wait out the full tick interval.
 */
function sleep(ms: number, shouldStop: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const step = Math.min(ms, 100);
    const deadline = Date.now() + ms;
    const tick = (): void => {
      if (shouldStop()) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        resolve();
        return;
      }
      setTimeout(tick, step);
    };
    setTimeout(tick, step);
  });
}

// We only run the main loop when invoked as a script. Importing this
// module for tests/type-checking does not kick off the loop. Bun
// exposes `import.meta.main` when the module is the entry file.
const meta = import.meta as { main?: boolean };
if (meta.main) {
  main().catch((err: unknown) => {
    process.stderr.write(
      `watchdog entry fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    process.exitCode = 1;
  });
}
