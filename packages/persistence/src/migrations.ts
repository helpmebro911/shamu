/**
 * Migration runner.
 *
 * Each migration is a `{ version, name, sql, checksum }` record. The runner
 * takes a shared advisory lock (a sentinel row in `schema_lock`), applies
 * pending migrations inside a transaction each, records them in
 * `schema_migrations`, then drops the lock. Running twice is a no-op.
 *
 * The schema_lock + schema_migrations + the initial tables all live in a
 * single SQL blob (`INITIAL_SCHEMA_SQL`) executed unconditionally on every
 * boot with `IF NOT EXISTS` guards. This is safe because each statement is
 * idempotent; the *migration content* is still gated by the
 * `schema_migrations` row and transaction.
 */

import { createHash } from "node:crypto";
import { PersistenceError } from "@shamu/shared/errors";
import { INITIAL_SCHEMA_SQL } from "./schema.ts";

// Re-declared here to avoid a circular import with db.ts.
interface SqliteLike {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  transaction<T>(fn: () => T): T;
}

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export interface MigrationRecord {
  readonly version: number;
  readonly appliedAt: number;
  readonly checksum: string;
}

/**
 * v2 — `flow_runs` shape for Phase 4.A.
 *
 * v1's `flow_runs` was a placeholder: `swarm_id`, `dag_version` as TEXT,
 * no status, no started_at. Phase 4.A's flow engine needs the canonical
 * shape from PLAN § 8 — `flow_id` (separate from swarm), `status`,
 * `started_at`, `resumed_from`, and `dag_version` as an integer so the
 * engine can bump it atomically alongside content-hash changes.
 *
 * We drop the v1 placeholder table instead of ALTER'ing because (a) no
 * production row has ever been written to it (the engine didn't exist);
 * (b) SQLite's `ALTER TABLE` is restrictive enough that emitting a
 * replacement is clearer than surviving a dozen DDL incantations.
 *
 * Compatibility detail: `INITIAL_SCHEMA_SQL` runs on every boot (via
 * `ensureBootstrapTables`). Its v1 statement
 *   `CREATE INDEX IF NOT EXISTS idx_flow_runs_swarm ON flow_runs(swarm_id)`
 * would fail post-v2 because `swarm_id` no longer exists. SQLite treats
 * `CREATE INDEX IF NOT EXISTS <name>` as a no-op when an index by that
 * name already exists, regardless of whether the new definition would be
 * valid. So v2 creates an `idx_flow_runs_swarm` placeholder pointing at
 * `flow_id` — functionally useful as a secondary lookup and just enough
 * to make v1's re-execution a no-op. It intentionally shares a name with
 * the v1 index; readers should consult the column list, not the index
 * name, to understand the semantics.
 */
const MIGRATION_V2_FLOW_RUNS_SQL = `
DROP TABLE IF EXISTS flow_runs;

CREATE TABLE IF NOT EXISTS flow_runs (
  flow_run_id   TEXT PRIMARY KEY,
  flow_id       TEXT NOT NULL,
  dag_version   INTEGER NOT NULL,
  status        TEXT NOT NULL,
  state_json    TEXT NOT NULL,
  resumed_from  TEXT,
  started_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_flow_runs_flow ON flow_runs(flow_id);
CREATE INDEX IF NOT EXISTS idx_flow_runs_status ON flow_runs(status);
-- Placeholder that keeps v1's INITIAL_SCHEMA_SQL re-exec a no-op
-- (name match suppresses the CREATE INDEX IF NOT EXISTS, even though
-- the v1 definition references the now-dropped swarm_id column).
CREATE INDEX IF NOT EXISTS idx_flow_runs_swarm ON flow_runs(flow_id);
`;

const MIGRATIONS: readonly Migration[] = Object.freeze([
  {
    version: 1,
    name: "initial",
    sql: INITIAL_SCHEMA_SQL,
  },
  {
    version: 2,
    name: "flow_runs",
    sql: MIGRATION_V2_FLOW_RUNS_SQL,
  },
]);

export function migrations(): readonly Migration[] {
  return MIGRATIONS;
}

function checksumOf(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

function acquireLock(db: SqliteLike): boolean {
  // Seed the lock table; it's created by the initial schema blob which we
  // run first-thing below. Using INSERT OR IGNORE so a racing runner sees
  // `changes()==0` and backs off.
  const result = db
    .prepare("INSERT OR IGNORE INTO schema_lock (id, locked_at) VALUES (1, ?)")
    .run(Date.now()) as { changes: number } | undefined;
  // bun:sqlite's `run` returns `{ lastInsertRowid, changes }` — consult
  // `changes` to see if we won the race.
  const changes = (result as { changes?: number } | undefined)?.changes;
  return changes === 1;
}

function releaseLock(db: SqliteLike): void {
  db.prepare("DELETE FROM schema_lock WHERE id = 1").run();
}

/**
 * Ensure the schema_lock / schema_migrations tables exist before we use
 * them. Calling the initial SQL blob unconditionally is safe because every
 * statement is wrapped in `IF NOT EXISTS`.
 */
function ensureBootstrapTables(db: SqliteLike): void {
  db.exec(INITIAL_SCHEMA_SQL);
}

export function applyPending(db: SqliteLike): readonly MigrationRecord[] {
  ensureBootstrapTables(db);

  if (!acquireLock(db)) {
    // Another process is mid-migration. We back off with a clear error —
    // callers can retry after a short delay. This is intentional: silent
    // waiting would mask a stuck migration.
    throw new PersistenceError(
      "Another Shamu process is currently running migrations (schema_lock held). Retry shortly.",
    );
  }

  try {
    const applied = db
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all() as Array<{ version: number }>;
    const appliedVersions = new Set(applied.map((r) => r.version));

    const records: MigrationRecord[] = [];
    for (const m of MIGRATIONS) {
      if (appliedVersions.has(m.version)) continue;
      const sum = checksumOf(m.sql);
      db.transaction(() => {
        db.exec(m.sql);
        db.prepare(
          "INSERT INTO schema_migrations (version, applied_at, checksum) VALUES (?, ?, ?)",
        ).run(m.version, Date.now(), sum);
      });
      records.push({ version: m.version, appliedAt: Date.now(), checksum: sum });
    }
    return records;
  } finally {
    releaseLock(db);
  }
}
