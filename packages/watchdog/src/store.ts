/**
 * Read-only SQLite opener for the watchdog.
 *
 * PLAN §6: the watchdog runs in a separate Bun subprocess that shares
 * the orchestrator's SQLite **read-only** so a stalled main process
 * cannot silence it. We open the DB via `bun:sqlite` with
 * `{ readonly: true }` — any mutation attempt fails with
 * "attempt to write a readonly database". That error is a bug, not a
 * caller mistake, which is why the opener lives in this package rather
 * than in `@shamu/persistence`: keeping the writer-flag surface area
 * narrow is a security invariant, not a convenience.
 *
 * The wrapper exposes only the subset the signal queries need
 * (`prepare`, `close`). We intentionally do NOT expose `exec`,
 * `transaction`, or any mutation-capable method — a contributor adding
 * a new signal can't accidentally add a write.
 *
 * Design decision (documented in writeup): we did not modify
 * `@shamu/persistence`. The watchdog package opens the DB itself via
 * `bun:sqlite` and declares local SELECT-only SQL. If we ever need the
 * typed query helpers in `@shamu/persistence/queries/events` from a
 * read-only connection, we'll revisit: the current helpers call
 * `db.prepare(...).run(...)` for writes, so reusing the SELECT helpers
 * would require a `ReadOnlyShamuDatabase` contract on the persistence
 * side. For now we duplicate a couple of narrow SELECTs locally.
 */

import { createRequire } from "node:module";
import { PersistenceError } from "@shamu/shared/errors";

/**
 * Minimal prepared-statement shape the watchdog relies on. Matches
 * `bun:sqlite`'s `.all()` return type loosely (`unknown[]`) because the
 * signal modules perform their own row typing at call sites.
 */
export interface ReadOnlyPreparedStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
}

/**
 * Read-only database handle exposed to signal evaluators. Only
 * `prepare` and `close` are surfaced — no `exec`, no `transaction`, no
 * write paths. A signal that needs to mutate anything is wrong.
 */
export interface ReadOnlyWatchdogDatabase {
  readonly path: string;
  prepare(sql: string): ReadOnlyPreparedStatement;
  close(): void;
}

type BunSqliteDatabase = {
  prepare(sql: string): ReadOnlyPreparedStatement;
  close(): void;
};
type BunSqliteCtor = new (
  path: string,
  opts?: { readonly?: boolean; create?: boolean },
) => BunSqliteDatabase;

function loadBunSqlite(): BunSqliteCtor {
  const versions = (process as { versions?: { bun?: string } }).versions;
  if (!versions?.bun) {
    throw new PersistenceError(
      "@shamu/watchdog requires Bun's `bun:sqlite`. Running under Node is not supported.",
    );
  }
  try {
    const require = createRequire(import.meta.url);
    const mod = require("bun:sqlite") as { Database: BunSqliteCtor };
    return mod.Database;
  } catch (cause) {
    throw new PersistenceError("Could not load `bun:sqlite` inside the watchdog package.", cause);
  }
}

/**
 * Open the SQLite database at `path` in read-only mode.
 *
 * `create: false` is implicit under `readonly: true` in `bun:sqlite` —
 * the database must already exist. The watchdog subprocess is started
 * by the orchestrator once the DB is already materialized; opening a
 * fresh DB read-only is a configuration error.
 */
export function openReadOnlyDatabase(path: string): ReadOnlyWatchdogDatabase {
  const Database = loadBunSqlite();
  let raw: BunSqliteDatabase;
  try {
    raw = new Database(path, { readonly: true });
  } catch (cause) {
    throw new PersistenceError(
      `Watchdog failed to open SQLite database at ${path} in read-only mode`,
      cause,
    );
  }
  return {
    path,
    prepare(sql) {
      return raw.prepare(sql);
    },
    close() {
      raw.close();
    },
  };
}
