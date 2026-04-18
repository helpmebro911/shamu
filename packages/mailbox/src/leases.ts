/**
 * Lease primitives — acquire, release, listActive, reclaimIfStale.
 *
 * Built on `@shamu/persistence/queries/leases`. The persistence layer
 * owns the CRUD; this module owns the invariants:
 *
 *   - Overlap check on acquire. A new glob cannot overlap any live lease
 *     (see {@link globsOverlap}); acquisition fails with
 *     {@link LeaseConflictError}.
 *   - Ownership check on release. Only the run that holds a lease can
 *     release it — `ctx.runId` must match `holder_run_id`.
 *   - Stale-lease reclaim. PLAN.md § "Patch lifecycle" § 1 and § "Core
 *     architecture → 5": the reclaim path runs
 *     `git status --porcelain --untracked-files=all --ignored=no` inside
 *     the holder's recorded worktree, scoped to the lease glob
 *     (pathspec). Non-empty output or missing worktree refuses reclaim
 *     and emits an escalation. Clean worktree → the lease is deleted.
 *
 * The reclaim path is where the package's only `execFile` call lives —
 * we deliberately avoid shelling elsewhere.
 */

import { execFile } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import type { ShamuDatabase } from "@shamu/persistence/db";
import {
  type LeaseRow,
  acquireLease as persistAcquire,
  listActive as persistListActive,
  releaseLease as persistRelease,
} from "@shamu/persistence/queries/leases";
import { type LeaseId, newLeaseId } from "@shamu/shared/ids";
import { type AuthContext, assertAuthContext } from "./auth.ts";
import { type EscalationEmitter, noopEmitter } from "./escalation.ts";
import { globsOverlap } from "./globs.ts";
import type { ReclaimResult } from "./types.ts";

/**
 * Thrown when an acquire request overlaps a live lease. Callers can
 * retry with a narrower glob or wait for the live lease to expire.
 */
export class LeaseConflictError extends Error {
  public readonly code = "lease_conflict" as const;
  public override readonly name = "LeaseConflictError";
  public readonly conflictingLeaseId: string;

  constructor(message: string, conflictingLeaseId: string) {
    super(message);
    this.conflictingLeaseId = conflictingLeaseId;
  }
}

/**
 * Thrown when a release / reclaim request targets a lease owned by a
 * different run (ownership check failed).
 */
export class LeaseOwnershipError extends Error {
  public readonly code = "lease_ownership" as const;
  public override readonly name = "LeaseOwnershipError";
}

/** Options for {@link acquireLease}. */
export interface AcquireLeaseOptions {
  /** Glob (forward-slash separated). `**` and `*` supported. */
  readonly glob: string;
  /** Time-to-live in milliseconds, added to `now` at acquire time. */
  readonly ttlMs: number;
  /**
   * Absolute path of the holder's worktree root. Stored on the row so
   * the stale-lease reclaim path knows where to run `git status`. The
   * orchestrator passes the worktree path it created for this run.
   */
  readonly worktreePath: string;
  /** Optional override for "now" (tests). */
  readonly now?: number;
}

/**
 * Acquire a new lease for `ctx.runId` over `glob`. Fails if any live
 * lease overlaps.
 *
 * Returns the created {@link LeaseRow}. `holder_run_id = ctx.runId`,
 * `agent = ctx.agent`, `holder_worktree_path = opts.worktreePath`.
 */
export function acquireLease(
  db: ShamuDatabase,
  ctx: AuthContext,
  opts: AcquireLeaseOptions,
): LeaseRow {
  assertAuthContext(ctx);
  if (typeof opts.glob !== "string" || opts.glob.length === 0) {
    throw new TypeError("acquireLease opts.glob must be a non-empty string");
  }
  if (typeof opts.ttlMs !== "number" || opts.ttlMs <= 0) {
    throw new TypeError("acquireLease opts.ttlMs must be a positive number");
  }
  if (typeof opts.worktreePath !== "string" || opts.worktreePath.length === 0) {
    throw new TypeError("acquireLease opts.worktreePath must be a non-empty string");
  }

  const now = opts.now ?? Date.now();

  // Atomic: check-overlap + insert under a single transaction so two
  // concurrent acquirers can't both pass the overlap check.
  let row: LeaseRow | null = null;
  db.transaction(() => {
    const live = persistListActive(db, now);
    for (const existing of live) {
      if (globsOverlap(existing.glob, opts.glob)) {
        throw new LeaseConflictError(
          `Glob "${opts.glob}" overlaps live lease ${existing.leaseId} (glob="${existing.glob}")`,
          existing.leaseId,
        );
      }
    }
    const id = newLeaseId();
    const expiresAt = now + opts.ttlMs;
    persistAcquire(db, {
      leaseId: id,
      swarmId: ctx.swarmId,
      agent: ctx.agent,
      holderRunId: ctx.runId,
      holderWorktreePath: opts.worktreePath,
      glob: opts.glob,
      acquiredAt: now,
      expiresAt,
    });
    row = {
      leaseId: id,
      swarmId: ctx.swarmId,
      agent: ctx.agent,
      holderRunId: ctx.runId,
      holderWorktreePath: opts.worktreePath,
      glob: opts.glob,
      acquiredAt: now,
      expiresAt,
    };
  });

  if (row === null) {
    // Unreachable: transaction either set row or threw.
    throw new Error("acquireLease: transaction completed without producing a row");
  }
  return row;
}

/**
 * Release the lease owned by `ctx.runId`. Throws if the lease exists
 * but is held by a different run.
 *
 * Releasing a non-existent lease id is a no-op (idempotent from the
 * caller's perspective — the desired postcondition is "that lease does
 * not exist", which is already true).
 */
export function releaseLease(db: ShamuDatabase, ctx: AuthContext, leaseId: LeaseId): void {
  assertAuthContext(ctx);

  const row = db.prepare("SELECT holder_run_id FROM leases WHERE lease_id = ?").get(leaseId) as
    | { holder_run_id: string }
    | null
    | undefined;

  if (row === undefined || row === null) return;

  if (row.holder_run_id !== ctx.runId) {
    throw new LeaseOwnershipError(
      `Lease ${leaseId} is held by run ${row.holder_run_id}, not ${ctx.runId}`,
    );
  }

  persistRelease(db, leaseId);
}

/**
 * List live leases in `ctx.swarmId`.
 */
export function listActive(
  db: ShamuDatabase,
  ctx: AuthContext,
  now: number = Date.now(),
): readonly LeaseRow[] {
  assertAuthContext(ctx);
  return persistListActive(db, now).filter((l) => l.swarmId === ctx.swarmId);
}

// --- Stale-lease reclaim -----------------------------------------------------

interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
}

type ExecFn = (cmd: string, args: readonly string[], cwd: string) => Promise<ExecResult>;

const defaultExec: ExecFn = (cmd, args, cwd) =>
  new Promise((resolve, reject) => {
    execFile(cmd, [...args], { cwd, encoding: "utf8" }, (err, stdout, stderr) => {
      if (err !== null) {
        reject(err);
        return;
      }
      resolve({ stdout, stderr });
    });
  });

/** Options for {@link reclaimIfStale}. */
export interface ReclaimOptions {
  /** Clock override for tests. */
  readonly now?: number;
  /** Escalation emitter — defaults to {@link noopEmitter}. */
  readonly emitter?: EscalationEmitter;
  /** Exec override for tests that don't want to shell to real git. */
  readonly exec?: ExecFn;
  /** `existsSync`-like override for tests. Returns true iff dir exists. */
  readonly worktreeExists?: (path: string) => boolean;
}

function defaultWorktreeExists(path: string): boolean {
  try {
    accessSync(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reclaim a stale lease if the holder's worktree is clean inside the
 * lease glob.
 *
 * Flow:
 *   1. Look up the lease. If missing → `lease_not_found` (no-op).
 *   2. If `expires_at > now` → `lease_not_stale`; caller should skip.
 *   3. Check `holder_worktree_path` exists. If not → emit
 *      `lease_reclaim_refused_holder_missing` and return
 *      `{ reclaimed: false, reason: "holder_worktree_missing" }`.
 *   4. Run `git status --porcelain --untracked-files=all --ignored=no
 *      -- <glob>` in that worktree. We pass the lease glob as a
 *      pathspec (after the `--` separator) so only files the lease
 *      *claims* count — a holder dirty on unrelated files shouldn't
 *      block reclaim of the targeted glob.
 *   5. Non-empty stdout → emit `lease_reclaim_refused_dirty_holder`
 *      and return `{ reclaimed: false, reason: "dirty_holder" }`.
 *   6. Clean → delete the lease and return `{ reclaimed: true }`.
 *
 * We deliberately do NOT verify that the caller's `ctx.runId` owns the
 * lease: reclaim is a janitorial operation that any run in the swarm
 * can perform once the lease is past its expiry. The safety check is
 * the clean-worktree predicate, not ownership.
 */
export async function reclaimIfStale(
  db: ShamuDatabase,
  ctx: AuthContext,
  leaseId: LeaseId,
  opts: ReclaimOptions = {},
): Promise<ReclaimResult> {
  assertAuthContext(ctx);

  const now = opts.now ?? Date.now();
  const emitter = opts.emitter ?? noopEmitter;
  const exec = opts.exec ?? defaultExec;
  const worktreeExists = opts.worktreeExists ?? defaultWorktreeExists;

  const raw = db
    .prepare(
      "SELECT lease_id, swarm_id, agent, holder_run_id, holder_worktree_path, glob, acquired_at, expires_at FROM leases WHERE lease_id = ?",
    )
    .get(leaseId) as
    | {
        lease_id: string;
        swarm_id: string;
        agent: string;
        holder_run_id: string;
        holder_worktree_path: string;
        glob: string;
        acquired_at: number;
        expires_at: number;
      }
    | null
    | undefined;

  if (raw === undefined || raw === null) {
    return { reclaimed: false, reason: "lease_not_found" };
  }

  if (raw.expires_at > now) {
    return { reclaimed: false, reason: "lease_not_stale" };
  }

  if (!worktreeExists(raw.holder_worktree_path)) {
    emitter.emit({
      kind: "escalation_raised",
      swarmId: raw.swarm_id,
      roleId: null,
      childId: raw.agent,
      cause: "lease_reclaim_refused_holder_missing",
      reason: `Lease ${leaseId} holder worktree ${raw.holder_worktree_path} is missing`,
      at: now,
      restartsInWindow: 0,
      target: "swarm",
    });
    return {
      reclaimed: false,
      reason: "holder_worktree_missing",
      detail: raw.holder_worktree_path,
    };
  }

  let stdout: string;
  try {
    const result = await exec(
      "git",
      ["status", "--porcelain", "--untracked-files=all", "--ignored=no", "--", raw.glob],
      raw.holder_worktree_path,
    );
    stdout = result.stdout;
  } catch (cause) {
    // Treat a failed `git status` like a missing worktree — we can't
    // prove clean, so refuse reclaim and escalate.
    emitter.emit({
      kind: "escalation_raised",
      swarmId: raw.swarm_id,
      roleId: null,
      childId: raw.agent,
      cause: "lease_reclaim_refused_holder_missing",
      reason: `git status failed in ${raw.holder_worktree_path}: ${String(cause)}`,
      at: now,
      restartsInWindow: 0,
      target: "swarm",
    });
    return {
      reclaimed: false,
      reason: "holder_worktree_missing",
      detail: String(cause),
    };
  }

  if (stdout.trim().length > 0) {
    emitter.emit({
      kind: "escalation_raised",
      swarmId: raw.swarm_id,
      roleId: null,
      childId: raw.agent,
      cause: "lease_reclaim_refused_dirty_holder",
      reason: `Lease ${leaseId} holder worktree has uncommitted changes inside glob ${raw.glob}`,
      at: now,
      restartsInWindow: 0,
      target: "role",
    });
    return { reclaimed: false, reason: "dirty_holder", detail: stdout };
  }

  // Clean — drop the lease row.
  persistRelease(db, leaseId);
  return { reclaimed: true };
}
