/**
 * Typed query helpers for the `leases` table.
 *
 * Stale-lease reclaim logic (git status --porcelain in the holder's
 * worktree) lives in `packages/mailbox` (Phase 3.C). This module only owns
 * the CRUD.
 */

import type { LeaseId, RunId, SwarmId } from "@shamu/shared/ids";
import { leaseId as brandLeaseId } from "@shamu/shared/ids";
import type { ShamuDatabase } from "../db.ts";

export interface LeaseRow {
  readonly leaseId: LeaseId;
  readonly swarmId: SwarmId;
  readonly agent: string;
  readonly holderRunId: RunId;
  readonly holderWorktreePath: string;
  readonly glob: string;
  readonly acquiredAt: number;
  readonly expiresAt: number;
}

export interface AcquireLeaseInput {
  readonly leaseId: LeaseId;
  readonly swarmId: SwarmId;
  readonly agent: string;
  readonly holderRunId: RunId;
  readonly holderWorktreePath: string;
  readonly glob: string;
  readonly acquiredAt?: number;
  readonly expiresAt: number;
}

interface RawLeaseRow {
  lease_id: string;
  swarm_id: string;
  agent: string;
  holder_run_id: string;
  holder_worktree_path: string;
  glob: string;
  acquired_at: number;
  expires_at: number;
}

function mapRow(r: RawLeaseRow): LeaseRow {
  return {
    leaseId: brandLeaseId(r.lease_id),
    swarmId: r.swarm_id as SwarmId,
    agent: r.agent,
    holderRunId: r.holder_run_id as RunId,
    holderWorktreePath: r.holder_worktree_path,
    glob: r.glob,
    acquiredAt: r.acquired_at,
    expiresAt: r.expires_at,
  };
}

const INSERT_LEASE_SQL =
  "INSERT INTO leases (lease_id, swarm_id, agent, holder_run_id, holder_worktree_path, glob, acquired_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)";

const DELETE_LEASE_SQL = "DELETE FROM leases WHERE lease_id = ?";

const LIST_ACTIVE_SQL = "SELECT * FROM leases WHERE expires_at > ? ORDER BY acquired_at";

const LIST_STALE_SQL = "SELECT * FROM leases WHERE expires_at <= ? ORDER BY acquired_at";

const MARK_STALE_SQL = "UPDATE leases SET expires_at = ? WHERE lease_id = ?";

export function acquireLease(db: ShamuDatabase, input: AcquireLeaseInput): void {
  db.prepare(INSERT_LEASE_SQL).run(
    input.leaseId,
    input.swarmId,
    input.agent,
    input.holderRunId,
    input.holderWorktreePath,
    input.glob,
    input.acquiredAt ?? Date.now(),
    input.expiresAt,
  );
}

export function releaseLease(db: ShamuDatabase, id: LeaseId): void {
  db.prepare(DELETE_LEASE_SQL).run(id);
}

export function listActive(db: ShamuDatabase, now: number = Date.now()): readonly LeaseRow[] {
  const rows = db.prepare(LIST_ACTIVE_SQL).all(now) as RawLeaseRow[];
  return rows.map(mapRow);
}

export function listStale(db: ShamuDatabase, now: number = Date.now()): readonly LeaseRow[] {
  const rows = db.prepare(LIST_STALE_SQL).all(now) as RawLeaseRow[];
  return rows.map(mapRow);
}

/**
 * Mark a lease as stale by clamping its expiry to `now`. The canonical
 * reclaim path (stale-lease + holder-worktree check) lives in Phase 3.C.
 */
export function markStale(db: ShamuDatabase, id: LeaseId, now: number = Date.now()): void {
  db.prepare(MARK_STALE_SQL).run(now, id);
}
