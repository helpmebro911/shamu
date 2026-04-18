/**
 * Thin persistence helper for the CLI.
 *
 * Wraps `@shamu/persistence`'s `openDatabase` with the Shamu state-dir
 * convention: `$SHAMU_STATE_DIR/shamu.db` (default: `.shamu/state/shamu.db`
 * under the current working directory). Created if absent; migrations
 * applied on open.
 *
 * Kept minimal — only the CLI commands that write/read runs need to reach
 * into persistence. If a future command wants a different database shape,
 * factor it into its own helper rather than growing this file.
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { openDatabase, type ShamuDatabase } from "@shamu/persistence";

/**
 * Resolve the path where the CLI should read/write its SQLite file.
 *
 * Precedence:
 * 1. `opts.stateDir` (explicit caller override).
 * 2. `SHAMU_STATE_DIR` env var.
 * 3. `<cwd>/.shamu/state`.
 *
 * Returns the absolute path to `shamu.db`. Creates the directory tree if
 * absent; fails loudly if creation fails (rather than silently opening a
 * DB under `/` or some other surprise).
 */
export function resolveDatabasePath(opts: { stateDir?: string; cwd?: string } = {}): string {
  const cwd = opts.cwd ?? process.cwd();
  const envStateDir = process.env.SHAMU_STATE_DIR;
  const rawStateDir = opts.stateDir ?? envStateDir ?? join(cwd, ".shamu", "state");
  const stateDir = isAbsolute(rawStateDir) ? rawStateDir : resolve(cwd, rawStateDir);
  const dbPath = join(stateDir, "shamu.db");
  if (!existsSync(stateDir)) {
    mkdirSync(stateDir, { recursive: true });
  }
  return dbPath;
}

/**
 * Open (and migrate) the CLI's canonical SQLite database.
 *
 * Returns a handle the caller should `.close()` when done. WAL mode is on
 * by default (via `openDatabase`).
 */
export function openRunDatabase(opts: { stateDir?: string; cwd?: string } = {}): ShamuDatabase {
  const dbPath = resolveDatabasePath(opts);
  const parent = dirname(dbPath);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
  return openDatabase(dbPath);
}
