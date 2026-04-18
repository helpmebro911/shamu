/**
 * Typed query helpers for the `flow_runs` table (migration v2).
 *
 * Mirrors the `runs.ts` convention: prepared statements against constant
 * SQL strings, typed row shapes, a `mapRow` at the persistence boundary.
 * No dynamic SQL — see `no-dynamic-sql.test.ts`.
 *
 * The `state_json` column is opaque to this module: callers serialize/
 * deserialize it with `@shamu/core-flow/state`'s helpers.
 */

import type { WorkflowRunId } from "@shamu/shared/ids";
import { workflowRunId as brandWorkflowRunId } from "@shamu/shared/ids";
import type { ShamuDatabase } from "../db.ts";

export type FlowRunStatus = "pending" | "running" | "paused" | "succeeded" | "failed";

export interface FlowRunRow {
  readonly flowRunId: WorkflowRunId;
  readonly flowId: string;
  readonly dagVersion: number;
  readonly status: FlowRunStatus;
  readonly stateJson: string;
  readonly resumedFrom: WorkflowRunId | null;
  readonly startedAt: number;
  readonly updatedAt: number;
}

export interface InsertFlowRunInput {
  readonly flowRunId: WorkflowRunId;
  readonly flowId: string;
  readonly dagVersion: number;
  readonly status: FlowRunStatus;
  readonly stateJson: string;
  readonly resumedFrom?: WorkflowRunId | null;
  readonly startedAt?: number;
}

interface RawFlowRunRow {
  flow_run_id: string;
  flow_id: string;
  dag_version: number;
  status: string;
  state_json: string;
  resumed_from: string | null;
  started_at: number;
  updated_at: number;
}

function mapRow(r: RawFlowRunRow): FlowRunRow {
  return {
    flowRunId: brandWorkflowRunId(r.flow_run_id),
    flowId: r.flow_id,
    dagVersion: r.dag_version,
    status: r.status as FlowRunStatus,
    stateJson: r.state_json,
    resumedFrom: r.resumed_from === null ? null : brandWorkflowRunId(r.resumed_from),
    startedAt: r.started_at,
    updatedAt: r.updated_at,
  };
}

const INSERT_FLOW_RUN_SQL =
  "INSERT INTO flow_runs (flow_run_id, flow_id, dag_version, status, state_json, resumed_from, started_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)";
const GET_FLOW_RUN_SQL = "SELECT * FROM flow_runs WHERE flow_run_id = ?";
const UPDATE_FLOW_RUN_STATE_SQL =
  "UPDATE flow_runs SET status = ?, state_json = ?, updated_at = ? WHERE flow_run_id = ?";
const LIST_FLOW_RUNS_BY_STATUS_SQL =
  "SELECT * FROM flow_runs WHERE status = ? ORDER BY started_at DESC";

export function insertFlowRun(db: ShamuDatabase, input: InsertFlowRunInput): void {
  const now = input.startedAt ?? Date.now();
  db.prepare(INSERT_FLOW_RUN_SQL).run(
    input.flowRunId,
    input.flowId,
    input.dagVersion,
    input.status,
    input.stateJson,
    input.resumedFrom ?? null,
    now,
    now,
  );
}

export function getFlowRun(db: ShamuDatabase, id: WorkflowRunId): FlowRunRow | null {
  const row = db.prepare(GET_FLOW_RUN_SQL).get(id) as RawFlowRunRow | undefined;
  return row ? mapRow(row) : null;
}

export function updateFlowRunState(
  db: ShamuDatabase,
  id: WorkflowRunId,
  status: FlowRunStatus,
  stateJson: string,
  updatedAt: number = Date.now(),
): void {
  db.prepare(UPDATE_FLOW_RUN_STATE_SQL).run(status, stateJson, updatedAt, id);
}

export function listFlowRunsByStatus(
  db: ShamuDatabase,
  status: FlowRunStatus,
): readonly FlowRunRow[] {
  const rows = db.prepare(LIST_FLOW_RUNS_BY_STATUS_SQL).all(status) as RawFlowRunRow[];
  return rows.map(mapRow);
}
