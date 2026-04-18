/**
 * `destroyWorktree` — tear down a per-run worktree.
 *
 * Default behavior is strict: `git worktree remove <path>` refuses a
 * worktree with uncommitted changes. The caller opts into `--force` if
 * they've decided the worktree is disposable (e.g., GC on a failed run).
 *
 * Branch removal is explicitly opt-in. Phase 3's flow preserves branches
 * of failed / quarantined runs so reviewers can inspect the tree. Only the
 * callers that know a branch is safe to discard pass `pruneBranch: true`.
 *
 * This module also handles the "already-gone" case: if the worktree
 * directory no longer exists on disk (e.g., a human `rm -rf`'d it), the
 * worktree entry in `.git/worktrees/` is stale. `git worktree remove`
 * reports this as a non-zero exit; we detect the error text and fall
 * through to a `git worktree prune` sweep. Note: `-q` is BANNED on
 * `git worktree prune`; we rely on stdout/stderr being captured (and thus
 * silenced from the parent's TTY) by the `runGit` wrapper.
 */

import { GitCommandError, runGit } from "./git.ts";
import type { DestroyWorktreeOptions, WorktreeHandle } from "./types.ts";

export async function destroyWorktree(
  handle: WorktreeHandle,
  opts: DestroyWorktreeOptions = {},
): Promise<void> {
  const force = opts.force ?? false;
  const pruneBranch = opts.pruneBranch ?? false;

  const removeArgs: string[] = ["worktree", "remove"];
  if (force) removeArgs.push("--force");
  removeArgs.push(handle.path);

  try {
    await runGit(removeArgs, { cwd: handle.repoRoot });
  } catch (err) {
    if (err instanceof GitCommandError && isWorktreePathGoneError(err)) {
      // Directory was removed outside of git's knowledge. Prune the stale
      // admin dir so future adds with the same name succeed. Note the
      // `-q` invariant is enforced by `runGit`; we deliberately pass no
      // `-q` here.
      await runGit(["worktree", "prune"], { cwd: handle.repoRoot });
    } else {
      throw err;
    }
  }

  if (pruneBranch) {
    // `-D` (capital) deletes regardless of merge state. The caller asked
    // for destructive removal; honor it.
    await runGit(["branch", "-D", handle.branch], { cwd: handle.repoRoot });
  }
}

/**
 * Detect the "worktree path is missing / not a working tree" family of
 * errors emitted by `git worktree remove`. Text varies slightly across
 * git versions (observed 2.40 vs 2.50). We match on the two stable
 * fragments git always includes.
 */
function isWorktreePathGoneError(err: GitCommandError): boolean {
  const stderr = err.stderr.toLowerCase();
  return (
    stderr.includes("is not a working tree") ||
    stderr.includes("no such file or directory") ||
    stderr.includes("not a valid path")
  );
}
