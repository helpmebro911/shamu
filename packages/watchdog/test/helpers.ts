/**
 * Shared test helpers: a temp DB + event-insertion shortcuts.
 *
 * The watchdog opens the DB read-only, so tests seed fixtures via
 * the regular persistence `openDatabase` helper (writable), then
 * close that connection and open a fresh read-only one pointed at
 * the same file before running signal evaluators.
 *
 * We do NOT go through `packages/persistence/queries/events.ts`'s
 * `insertEvent` because it parses the full Zod schema and we want to
 * poke in malformed payloads in some tests. Instead, raw SQL against
 * the same schema — everything typed against `ShamuDatabase` so a
 * schema change that breaks the tests fails loudly.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type ShamuDatabase } from "@shamu/persistence/db";
import { insertRun } from "@shamu/persistence/queries/runs";
import { newEventId, newRunId, newTurnId, type RunId } from "@shamu/shared/ids";
import { openReadOnlyDatabase, type ReadOnlyWatchdogDatabase } from "../src/store.ts";

export interface TempDb {
  readonly dir: string;
  readonly path: string;
  readonly writer: ShamuDatabase;
  close(): void;
}

export function openTempDb(prefix = "shamu-watchdog-"): TempDb {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const path = join(dir, "db.sqlite");
  const writer = openDatabase(path);
  return {
    dir,
    path,
    writer,
    close() {
      writer.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Open a read-only handle onto an existing temp DB file. */
export function openReaderFor(path: string): ReadOnlyWatchdogDatabase {
  return openReadOnlyDatabase(path);
}

export interface SeedRunOpts {
  readonly role?: string | null;
  readonly vendor?: string | null;
  readonly status?: "pending" | "running" | "review" | "blocked" | "completed" | "failed";
  readonly createdAt?: number;
}

export function seedRun(
  db: ShamuDatabase,
  runId: RunId = newRunId(),
  opts: SeedRunOpts = {},
): RunId {
  insertRun(db, {
    runId,
    role: opts.role ?? null,
    vendor: opts.vendor ?? null,
    status: opts.status ?? "running",
    ...(opts.createdAt !== undefined ? { createdAt: opts.createdAt } : {}),
  });
  return runId;
}

export interface SeedEventOpts {
  readonly runId: RunId;
  readonly vendor?: string;
  readonly seq: number;
  readonly tsWall: number;
  readonly kind: string;
  readonly payload?: Record<string, unknown>;
}

const INSERT_EVENT_SQL =
  "INSERT INTO events (event_id, run_id, session_id, turn_id, parent_event_id, seq, ts_monotonic, ts_wall, vendor, kind, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

export function seedEvent(db: ShamuDatabase, opts: SeedEventOpts): void {
  const payload = opts.payload ?? {};
  db.prepare(INSERT_EVENT_SQL).run(
    newEventId(),
    opts.runId,
    null,
    newTurnId(),
    null,
    opts.seq,
    opts.tsWall, // monotonic reused — we only consume tsWall in the watchdog
    opts.tsWall,
    opts.vendor ?? "claude",
    opts.kind,
    JSON.stringify(payload),
  );
}

export function seedCheckpoint(
  db: ShamuDatabase,
  runId: RunId,
  seq: number,
  tsWall: number,
  vendor = "claude",
): void {
  seedEvent(db, {
    runId,
    vendor,
    seq,
    tsWall,
    kind: "checkpoint",
    payload: { summary: `checkpoint-${seq}` },
  });
}

export function seedToolCall(
  db: ShamuDatabase,
  runId: RunId,
  seq: number,
  tsWall: number,
  tool: string,
  args: unknown = {},
  vendor = "claude",
): void {
  seedEvent(db, {
    runId,
    vendor,
    seq,
    tsWall,
    kind: "tool_call",
    payload: { toolCallId: `tc-${seq}`, tool, args },
  });
}

export function seedTurnEnd(
  db: ShamuDatabase,
  runId: RunId,
  seq: number,
  tsWall: number,
  vendor = "claude",
): void {
  seedEvent(db, {
    runId,
    vendor,
    seq,
    tsWall,
    kind: "turn_end",
    payload: { stopReason: "end_turn", durationMs: 1_000 },
  });
}

export function seedCost(
  db: ShamuDatabase,
  runId: RunId,
  seq: number,
  tsWall: number,
  payload: { usd: number | null; confidence: string; source: string },
  vendor = "claude",
): void {
  seedEvent(db, {
    runId,
    vendor,
    seq,
    tsWall,
    kind: "cost",
    payload,
  });
}
