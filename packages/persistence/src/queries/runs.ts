/**
 * Typed query helpers for the `runs` table.
 *
 * All statements are prepared. There is no dynamic SQL string concatenation
 * anywhere in this module — see `no-dynamic-sql.test.ts` for the lint.
 */

import type { RunId, SwarmId } from "@shamu/shared/ids";
import { runId as brandRunId } from "@shamu/shared/ids";
import type { ShamuDatabase } from "../db.ts";

export type RunStatus = "pending" | "running" | "review" | "blocked" | "completed" | "failed";

export interface RunRow {
  readonly runId: RunId;
  readonly swarmId: SwarmId | null;
  readonly role: string | null;
  readonly vendor: string | null;
  readonly status: RunStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface InsertRunInput {
  readonly runId: RunId;
  readonly swarmId?: SwarmId | null;
  readonly role?: string | null;
  readonly vendor?: string | null;
  readonly status: RunStatus;
  readonly createdAt?: number;
}

interface RawRunRow {
  run_id: string;
  swarm_id: string | null;
  role: string | null;
  vendor: string | null;
  status: string;
  created_at: number;
  updated_at: number;
}

function mapRow(r: RawRunRow): RunRow {
  return {
    runId: brandRunId(r.run_id),
    swarmId: r.swarm_id === null ? null : (r.swarm_id as SwarmId),
    role: r.role,
    vendor: r.vendor,
    status: r.status as RunStatus,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const INSERT_RUN_SQL =
  "INSERT INTO runs (run_id, swarm_id, role, vendor, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)";
const GET_RUN_SQL = "SELECT * FROM runs WHERE run_id = ?";
const UPDATE_STATUS_SQL = "UPDATE runs SET status = ?, updated_at = ? WHERE run_id = ?";
const LIST_RUNS_SQL = "SELECT * FROM runs ORDER BY created_at DESC";
const LIST_RUNS_BY_STATUS_SQL = "SELECT * FROM runs WHERE status = ? ORDER BY created_at DESC";

export function insertRun(db: ShamuDatabase, input: InsertRunInput): void {
  const now = input.createdAt ?? Date.now();
  db.prepare(INSERT_RUN_SQL).run(
    input.runId,
    input.swarmId ?? null,
    input.role ?? null,
    input.vendor ?? null,
    input.status,
    now,
    now,
  );
}

export function getRun(db: ShamuDatabase, id: RunId): RunRow | null {
  const row = db.prepare(GET_RUN_SQL).get(id) as RawRunRow | undefined;
  return row ? mapRow(row) : null;
}

export function updateRunStatus(
  db: ShamuDatabase,
  id: RunId,
  status: RunStatus,
  updatedAt: number = Date.now(),
): void {
  db.prepare(UPDATE_STATUS_SQL).run(status, updatedAt, id);
}

export function listRuns(db: ShamuDatabase, status?: RunStatus): readonly RunRow[] {
  const rows = (
    status === undefined
      ? db.prepare(LIST_RUNS_SQL).all()
      : db.prepare(LIST_RUNS_BY_STATUS_SQL).all(status)
  ) as RawRunRow[];
  return rows.map(mapRow);
}
