/**
 * `createWorktree` — materialize a per-run worktree on disk.
 *
 * We invoke:
 *
 *   git -C <repoRoot> worktree add -b shamu/<run-id> .shamu/worktrees/<run-id> <baseBranch>
 *
 * The `-b` form creates the branch as part of the add, which is atomic:
 * if the add fails, the branch isn't left behind. The worktree path is
 * passed relative to the repo root so git normalizes it into the canonical
 * location under `.shamu/worktrees/` regardless of the caller's cwd.
 *
 * `git worktree add` also creates any missing parent directories of the
 * target path, so `.shamu/worktrees/` doesn't need to exist ahead of time.
 */

import type { RunId } from "@shamu/shared/ids";
import { runGit } from "./git.ts";
import { branchForRun, relativeWorktreePathForRun, worktreePathForRun } from "./naming.ts";
import type { WorktreeHandle } from "./types.ts";

export interface CreateWorktreeOptions {
  /** Absolute path to the hosting repo root. */
  readonly repoRoot: string;
  /** The orchestrator-minted run id. Becomes part of the branch + path. */
  readonly runId: RunId;
  /**
   * The branch the new worktree's HEAD is initialized from (e.g. `main`).
   * Must exist locally — `git worktree add` fails otherwise.
   */
  readonly baseBranch: string;
}

export async function createWorktree(opts: CreateWorktreeOptions): Promise<WorktreeHandle> {
  const branch = branchForRun(opts.runId);
  const relativePath = relativeWorktreePathForRun(opts.runId);
  const absolutePath = worktreePathForRun(opts.repoRoot, opts.runId);

  // `worktree add -b <branch> <path> <start-point>` is the documented
  // atomic form. No `-q` flag anywhere — not banned on this subcommand,
  // but we prefer full output surfacing through our wrapper so test
  // failures are diagnosable.
  await runGit(["worktree", "add", "-b", branch, relativePath, opts.baseBranch], {
    cwd: opts.repoRoot,
  });

  return {
    runId: opts.runId,
    branch,
    path: absolutePath,
    baseBranch: opts.baseBranch,
    repoRoot: opts.repoRoot,
  };
}
