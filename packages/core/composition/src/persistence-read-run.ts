/**
 * `createReadRunRow` — thin, typed driver over `@shamu/persistence`'s
 * `runs` query module.
 *
 * `@shamu/worktree`'s GC needs a "look up this run's status +
 * last-updated" callback (see `GCReadRun` in that package's types) so
 * the sweep can skip non-terminal runs and too-recent terminal ones.
 * The worktree package intentionally does NOT depend on
 * `@shamu/persistence` — it stays a pure git-worktree primitive.
 *
 * This module is the composition-layer driver that closes that gap:
 * bind an open `ShamuDatabase`, get back a function the GC can call.
 * It lives here (not in `@shamu/worktree`) to preserve layer hygiene —
 * `@shamu/worktree` must not import `@shamu/persistence`.
 *
 * Structural typing note:
 *
 *   `@shamu/worktree` declares `GCReadRun = (RunId) => GCRunSnapshot |
 *   null` where `GCRunSnapshot = { status: string; updatedAt: number }`.
 *   `ReadRunRowResult` below carries a superset (`runId`, `createdAt`,
 *   `status: RunStatus`, `updatedAt`) so the same function value
 *   satisfies both contracts via TypeScript's structural subtyping.
 *   Callers pass `createReadRunRow({ db })` directly to
 *   `garbageCollect({ persistenceReadRun: ... })` — no explicit adapter
 *   needed.
 */

import type { ShamuDatabase } from "@shamu/persistence";
import { runsQueries } from "@shamu/persistence";
import { runId as brandRunId, type RunId } from "@shamu/shared/ids";

/**
 * Minimal run-row surface the worktree GC consumes. A superset of
 * `@shamu/worktree`'s `GCRunSnapshot` — extra fields are harmless under
 * structural typing. If GC ever needs more fields, widen here in
 * lockstep with the GC call site.
 */
export interface ReadRunRowResult {
  readonly runId: RunId;
  readonly status: runsQueries.RunStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/**
 * Function shape returned by {@link createReadRunRow}. Structurally
 * compatible with `@shamu/worktree`'s `GCReadRun`.
 */
export type ReadRunRow = (id: RunId) => ReadRunRowResult | null;

/** Options for {@link createReadRunRow}. */
export interface CreateReadRunRowOptions {
  /** An open persistence database. */
  readonly db: ShamuDatabase;
}

/**
 * Bind the driver to an open database. Returns a pure reader — no
 * internal caching, no subscriptions, no lifecycle.
 *
 * @throws TypeError when the caller hands a non-string or empty id at
 *                   call time. The error message surfaces the id so
 *                   stale call sites are easier to locate.
 */
export function createReadRunRow(opts: CreateReadRunRowOptions): ReadRunRow {
  const { db } = opts;
  return (id: RunId): ReadRunRowResult | null => {
    if (typeof id !== "string" || id.length === 0) {
      throw new TypeError(
        `createReadRunRow: RunId must be a non-empty string (got ${typeof id === "string" ? '""' : typeof id})`,
      );
    }
    // The persistence query wraps the raw string back into a branded
    // RunId at its boundary; we just pass through. If a future caller
    // supplies a non-branded string we rebrand defensively — the
    // structural runtime shape is identical either way.
    const branded = brandRunId(id);
    const row = runsQueries.getRun(db, branded);
    if (row === null) return null;
    return {
      runId: row.runId,
      status: row.status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  };
}
