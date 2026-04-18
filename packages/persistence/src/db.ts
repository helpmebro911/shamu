/**
 * Database opener + operational helpers.
 *
 * Uses `bun:sqlite`. Phase 0.A confirmed it's production-viable for the
 * harness volume under WAL with 1 writer + many readers. If we're not on
 * Bun, opening fails loudly — we don't want to silently fall back to a
 * different SQLite binding and have subtle behavior differences creep in.
 */

import { createRequire } from "node:module";
import { PersistenceError } from "@shamu/shared/errors";
import { applyPending, type MigrationRecord } from "./migrations.ts";

// A minimal statement shape that matches both `bun:sqlite`'s and (for future
// compat) `better-sqlite3`'s prepared-statement API.
export interface PreparedStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  readonly source?: string;
}

export interface SqliteDriver {
  exec(sql: string): void;
  prepare(sql: string): PreparedStatement;
  transaction<T>(fn: () => T): T;
  close(): void;
}

export interface OpenDatabaseOptions {
  /** Skip running pending migrations. Tests use this to inspect a virgin DB. */
  readonly skipMigrations?: boolean;
  /** Disable WAL (for in-memory databases where WAL is unsupported). */
  readonly noWal?: boolean;
}

export interface ShamuDatabase {
  readonly path: string;
  readonly driver: SqliteDriver;
  exec(sql: string): void;
  prepare(sql: string): PreparedStatement;
  transaction<T>(fn: () => T): T;
  close(): void;
  backup(destPath: string): void;
  migrations(): readonly MigrationRecord[];
}

type BunSqliteDatabase = {
  exec(sql: string): void;
  prepare(sql: string): PreparedStatement;
  transaction<T>(fn: () => T): () => T;
  close(): void;
};
type BunSqliteCtor = new (path: string, opts?: { create?: boolean }) => BunSqliteDatabase;

function loadBunSqlite(): BunSqliteCtor {
  // `bun:sqlite` is only loadable under Bun. We detect via `process.versions.bun`
  // because Vitest's VM context (running under `bun vitest run`) strips the
  // global `Bun` from the worker realm even though `process.versions.bun` is
  // still populated and `bun:sqlite` resolves via `createRequire`.
  const versions = (process as { versions?: { bun?: string } }).versions;
  if (!versions?.bun) {
    throw new PersistenceError(
      "@shamu/persistence requires Bun's `bun:sqlite`. " +
        "If you need Node support, wire a `better-sqlite3` driver here and declare `engine: node` on this package.",
    );
  }
  try {
    const require = createRequire(import.meta.url);
    const mod = require("bun:sqlite") as { Database: BunSqliteCtor };
    return mod.Database;
  } catch (cause) {
    throw new PersistenceError("Could not load `bun:sqlite`.", cause);
  }
}

function wrapBunDatabase(raw: BunSqliteDatabase): SqliteDriver {
  return {
    exec(sql) {
      raw.exec(sql);
    },
    prepare(sql) {
      return raw.prepare(sql);
    },
    transaction<T>(fn: () => T): T {
      return raw.transaction(fn)();
    },
    close() {
      raw.close();
    },
  };
}

export function openDatabase(path: string, opts: OpenDatabaseOptions = {}): ShamuDatabase {
  const Database = loadBunSqlite();
  let raw: BunSqliteDatabase;
  try {
    raw = new Database(path, { create: true });
  } catch (cause) {
    throw new PersistenceError(`Failed to open SQLite database at ${path}`, cause);
  }
  const driver = wrapBunDatabase(raw);
  // PRAGMAs — WAL, busy_timeout, synchronous=NORMAL, foreign_keys.
  try {
    if (!opts.noWal) driver.exec("PRAGMA journal_mode=WAL;");
    driver.exec("PRAGMA busy_timeout=5000;");
    driver.exec("PRAGMA synchronous=NORMAL;");
    driver.exec("PRAGMA foreign_keys=ON;");
  } catch (cause) {
    driver.close();
    throw new PersistenceError("Failed to set PRAGMAs on new SQLite connection", cause);
  }

  const db: ShamuDatabase = {
    path,
    driver,
    exec: (sql) => driver.exec(sql),
    prepare: (sql) => driver.prepare(sql),
    transaction: (fn) => driver.transaction(fn),
    close: () => driver.close(),
    backup(destPath: string) {
      if (destPath === path) {
        throw new PersistenceError("backup() destPath must differ from the source path");
      }
      // Escape single quotes in the destination path SQLite-style (double them).
      const escaped = destPath.replace(/'/g, "''");
      driver.exec(`VACUUM INTO '${escaped}';`);
    },
    migrations() {
      const rows = driver
        .prepare("SELECT version, applied_at, checksum FROM schema_migrations ORDER BY version")
        .all() as Array<{ version: number; applied_at: number; checksum: string }>;
      return rows.map((r) => ({
        version: r.version,
        appliedAt: r.applied_at,
        checksum: r.checksum,
      }));
    },
  };

  if (!opts.skipMigrations) applyPending(db);
  return db;
}
