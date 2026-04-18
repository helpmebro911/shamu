/**
 * `@shamu/worktree` — per-run git worktree lifecycle.
 *
 * Public surface:
 *
 *   createWorktree     — materialize `.shamu/worktrees/<run-id>` with a
 *                        fresh `shamu/<run-id>` branch.
 *   destroyWorktree    — tear it down; optional `--force` + branch-prune.
 *   garbageCollect     — sweep stale worktrees whose run is terminal + old.
 *   installPreCommitHook — plant the lease-aware pre-commit hook
 *                          (placeholder until Phase 3.C's mailbox lands).
 *   branchForRun / worktreePathForRun / runIdFromWorktreePath
 *                      — canonical naming helpers; pure.
 *   runGit / GitCommandError / GitInvariantError
 *                      — the thin subprocess wrapper and its typed errors.
 *                        Exposed so callers that need to invoke a neighboring
 *                        git command (not covered by the above) stay under
 *                        the same `-q` invariant.
 */

export { type CreateWorktreeOptions, createWorktree } from "./create.ts";
export { destroyWorktree } from "./destroy.ts";
export { GC_DEFAULTS, garbageCollect, parseWorktreeList } from "./gc.ts";
export type { GitResult, RunGitOptions } from "./git.ts";
export { assertNoBannedQuietFlag, GitCommandError, GitInvariantError, runGit } from "./git.ts";
export { HookInstallError, installPreCommitHook, renderHookScript } from "./hook.ts";
export {
  branchForRun,
  isShamuBranch,
  relativeWorktreePathForRun,
  runIdFromWorktreePath,
  WORKTREES_SUBDIR,
  worktreePathForRun,
} from "./naming.ts";
export type {
  DestroyWorktreeOptions,
  GCErrorEntry,
  GCOptions,
  GCReadRun,
  GCRemovedEntry,
  GCReport,
  GCRunSnapshot,
  GCSkippedEntry,
  GCSkipReason,
  HookOptions,
  InstalledHook,
  WorktreeHandle,
} from "./types.ts";
