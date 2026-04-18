/**
 * Public type surface for `@shamu/worktree`.
 *
 * A `WorktreeHandle` is the full identity of a per-run worktree: the run's
 * branded id, the canonical branch name (`shamu/<run-id>`), the on-disk
 * path (`.shamu/worktrees/<run-id>`), the base branch the worktree was
 * branched from, and the absolute path of the hosting repo. It is a plain
 * value — no process state, no file handles — so it round-trips through
 * JSON / SQLite / IPC untouched.
 *
 * `GCReport` is the structured return of `garbageCollect`. It enumerates
 * which worktree directories were removed, which were skipped (and why),
 * and any errors that surfaced without aborting the sweep.
 *
 * `HookOptions` is intentionally narrow: Phase 3.B only installs the
 * placeholder script that Phase 3.C (`@shamu/mailbox`) fills in with the
 * real lease-check binary. We reserve the shape now so the later wiring is
 * a one-line injection and not a hook-install rewrite.
 */

import type { RunId } from "@shamu/shared/ids";

/** Everything a caller needs to work with a created worktree. */
export interface WorktreeHandle {
  /** The run this worktree belongs to. */
  readonly runId: RunId;
  /** Branch name — `shamu/<run-id>`. */
  readonly branch: string;
  /** Absolute path to the worktree root on disk. */
  readonly path: string;
  /** The branch the worktree was spawned from (e.g., `main`). */
  readonly baseBranch: string;
  /** Absolute path of the hosting repo (the `git worktree add` was invoked here). */
  readonly repoRoot: string;
}

export interface DestroyWorktreeOptions {
  /**
   * When true, pass `--force` to `git worktree remove` if the worktree has
   * uncommitted state. Defaults to false (never silently discard edits).
   */
  readonly force?: boolean;
  /**
   * When true, delete the per-run branch with `git branch -D` after the
   * worktree removal succeeds. Defaults to false — callers typically want
   * the branch preserved for post-mortem / quarantine inspection.
   */
  readonly pruneBranch?: boolean;
}

/** Injected read-shape for runs; the package never imports `@shamu/persistence` directly. */
export interface GCRunSnapshot {
  readonly status: string;
  /** Unix epoch milliseconds; the timestamp the worktree was last known to be touched. */
  readonly updatedAt: number;
}

export type GCReadRun = (runId: RunId) => GCRunSnapshot | null;

export interface GCOptions {
  /** Absolute path to the hosting repo. */
  readonly repoRoot: string;
  /** Current wall-clock time, injected for determinism in tests. */
  readonly now: number;
  /** Look up a run's status + last-updated. The package doesn't own persistence. */
  readonly persistenceReadRun: GCReadRun;
  /**
   * A worktree is eligible for prune only if its run row is in one of these
   * terminal statuses AND older than `maxAgeHours`. Defaults to
   * `["completed", "failed"]`.
   */
  readonly terminalStatuses?: readonly string[];
  /** Age threshold in hours. Defaults to 24. */
  readonly maxAgeHours?: number;
  /**
   * When true, forward `--force` into `git worktree remove` for dirty
   * worktrees. Defaults to false — GC refuses to clobber uncommitted work.
   */
  readonly force?: boolean;
}

export type GCSkipReason =
  | "run_row_missing"
  | "run_not_terminal"
  | "run_too_recent"
  | "path_not_under_shamu_worktrees"
  | "not_owned_by_shamu"; // e.g., the primary worktree, or a foreign add.

export interface GCRemovedEntry {
  readonly runId: RunId;
  readonly path: string;
}

export interface GCSkippedEntry {
  readonly path: string;
  /** Populated only when the worktree path was parseable as `.shamu/worktrees/<run-id>`. */
  readonly runId: RunId | null;
  readonly reason: GCSkipReason;
}

export interface GCErrorEntry {
  readonly path: string;
  readonly runId: RunId | null;
  readonly message: string;
}

export interface GCReport {
  readonly removed: readonly GCRemovedEntry[];
  readonly skipped: readonly GCSkippedEntry[];
  readonly errors: readonly GCErrorEntry[];
}

export interface HookOptions {
  /**
   * Absolute path to the lease-check executable that Phase 3.C's mailbox
   * package will supply. The installed `pre-commit` hook execs this with
   * the staged paths on stdin. Until 3.C lands, callers typically pass the
   * path of a placeholder script that exits 0.
   */
  readonly leaseCheckerScript: string;
}

export interface InstalledHook {
  /** Absolute path of the installed hook file. */
  readonly path: string;
  /** `0o755`, unconditionally. */
  readonly mode: number;
}
