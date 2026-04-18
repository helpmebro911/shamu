/**
 * Canonical naming: branch name + on-disk worktree path.
 *
 * Every worktree Shamu creates follows two conventions:
 *
 *   branch   = `shamu/<run-id>`
 *   path     = `<repoRoot>/.shamu/worktrees/<run-id>`
 *
 * We centralize the string shape here so callers and GC can parse it back
 * into a `RunId` without duplicating the split logic. The path pattern is
 * deliberately scoped under `.shamu/` (per PLAN.md § "Security & threat
 * model → Filesystem") rather than `.git/worktrees/`, so all Shamu-managed
 * state lives under a single top-level directory that's easy to gitignore
 * and easy to nuke.
 */

import { posix, sep } from "node:path";
import { runId as brandRunId, type RunId } from "@shamu/shared/ids";

const BRANCH_PREFIX = "shamu/";
/** The relative directory inside the repo where Shamu worktrees live. */
export const WORKTREES_SUBDIR = ".shamu/worktrees";

/** Return `shamu/<run-id>`. */
export function branchForRun(runId: RunId): string {
  return `${BRANCH_PREFIX}${runId}`;
}

/**
 * Return the absolute worktree path for a run, anchored under `repoRoot`.
 *
 * Always produces a path using the host OS separator; the `WORKTREES_SUBDIR`
 * segment is POSIX-shaped but `posix.join` turns it into a single segment
 * list that we then re-join with the OS separator. This keeps round-trips
 * working on both macOS/Linux (where `/` is native) and hypothetically on
 * Windows (not supported in v1 but we want no platform-specific string math).
 */
export function worktreePathForRun(repoRoot: string, runId: RunId): string {
  if (typeof repoRoot !== "string" || repoRoot.length === 0) {
    throw new TypeError("worktreePathForRun: repoRoot must be a non-empty string");
  }
  const subdirParts = WORKTREES_SUBDIR.split("/");
  return [repoRoot, ...subdirParts, runId].join(sep);
}

/**
 * Relative form of `worktreePathForRun`: `.shamu/worktrees/<run-id>`. Used
 * when we invoke `git worktree add` (git accepts either absolute or
 * repo-relative paths for the new worktree root).
 */
export function relativeWorktreePathForRun(runId: RunId): string {
  return posix.join(WORKTREES_SUBDIR, runId);
}

/**
 * Given an absolute path that was produced by `worktreePathForRun`, extract
 * the `RunId`. Returns `null` if the path doesn't match the pattern — in
 * particular, we require `.shamu/worktrees/<id>` anywhere inside the path
 * (GC uses this on paths emitted by `git worktree list --porcelain`, which
 * may be absolute and not rooted at a specific repo).
 */
export function runIdFromWorktreePath(path: string): RunId | null {
  if (typeof path !== "string" || path.length === 0) return null;
  // Normalize separators for parsing; we don't write a new string back.
  const normalized = path.split(sep).join("/");
  const marker = `/${WORKTREES_SUBDIR}/`;
  const idx = normalized.lastIndexOf(marker);
  if (idx === -1) return null;
  const tail = normalized.slice(idx + marker.length);
  // Strip any trailing slash and refuse nested subdirectories.
  const trimmed = tail.replace(/\/+$/, "");
  if (trimmed.length === 0 || trimmed.includes("/")) return null;
  try {
    return brandRunId(trimmed);
  } catch {
    return null;
  }
}

/** `true` iff `branch` matches `shamu/<non-empty>`. */
export function isShamuBranch(branch: string): boolean {
  return (
    typeof branch === "string" &&
    branch.startsWith(BRANCH_PREFIX) &&
    branch.length > BRANCH_PREFIX.length
  );
}
