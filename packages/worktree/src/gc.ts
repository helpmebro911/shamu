/**
 * `garbageCollect` — sweep stale `.shamu/worktrees/<run-id>` worktrees.
 *
 * Two-phase sweep:
 *
 *   1. Ask git for the list of registered worktrees via
 *      `git worktree list --porcelain`. Parsing the porcelain form is more
 *      reliable than scanning the filesystem — it yields the canonical
 *      absolute path, the branch, HEAD, and any `bare`/`locked`/`prunable`
 *      annotations. It also naturally ignores stray directories under
 *      `.shamu/worktrees/` that git itself doesn't know about (leftover
 *      junk from a manual `cp -r`, etc.).
 *
 *   2. For each worktree whose path is under `.shamu/worktrees/<run-id>`,
 *      call the injected `persistenceReadRun` to ask whether the run is
 *      terminal AND older than the threshold. Only then invoke
 *      `git worktree remove` and record it in `removed`.
 *
 * The sweep ends with `git worktree prune` to clean up any admin entries
 * left behind by worktrees whose directories vanished outside of git's
 * control. **`-q` is BANNED on `prune`** (git 2.50 rejects the flag);
 * `runGit` captures stdout/stderr so there's no TTY noise anyway.
 *
 * This module deliberately does NOT import `@shamu/persistence`. The GC
 * driver passes a callback that reads whatever row it needs; the package
 * is reusable in tests and in any composition that wires up the read
 * itself.
 */

import { runGit } from "./git.ts";
import { runIdFromWorktreePath } from "./naming.ts";
import type { GCErrorEntry, GCOptions, GCRemovedEntry, GCReport, GCSkippedEntry } from "./types.ts";

const DEFAULT_MAX_AGE_HOURS = 24;
const DEFAULT_TERMINAL_STATUSES: readonly string[] = ["completed", "failed"];
const MS_PER_HOUR = 60 * 60 * 1000;

interface ParsedWorktree {
  readonly path: string;
  readonly branch: string | null;
  readonly isBare: boolean;
  readonly isDetached: boolean;
}

export async function garbageCollect(opts: GCOptions): Promise<GCReport> {
  const maxAgeHours = opts.maxAgeHours ?? DEFAULT_MAX_AGE_HOURS;
  const terminalStatuses = opts.terminalStatuses ?? DEFAULT_TERMINAL_STATUSES;
  const force = opts.force ?? false;

  const removed: GCRemovedEntry[] = [];
  const skipped: GCSkippedEntry[] = [];
  const errors: GCErrorEntry[] = [];

  const listResult = await runGit(["worktree", "list", "--porcelain"], {
    cwd: opts.repoRoot,
  });
  const worktrees = parseWorktreeList(listResult.stdout);

  for (const wt of worktrees) {
    const runId = runIdFromWorktreePath(wt.path);
    if (runId === null) {
      skipped.push({
        path: wt.path,
        runId: null,
        reason: "path_not_under_shamu_worktrees",
      });
      continue;
    }
    if (wt.isBare) {
      // A bare worktree under `.shamu/worktrees/` is pathological — not
      // something Shamu creates. Flag as not-ours and skip.
      skipped.push({ path: wt.path, runId, reason: "not_owned_by_shamu" });
      continue;
    }

    const snapshot = opts.persistenceReadRun(runId);
    if (snapshot === null) {
      skipped.push({ path: wt.path, runId, reason: "run_row_missing" });
      continue;
    }
    if (!terminalStatuses.includes(snapshot.status)) {
      skipped.push({ path: wt.path, runId, reason: "run_not_terminal" });
      continue;
    }
    const ageMs = opts.now - snapshot.updatedAt;
    if (ageMs < maxAgeHours * MS_PER_HOUR) {
      skipped.push({ path: wt.path, runId, reason: "run_too_recent" });
      continue;
    }

    try {
      await removeOne(opts.repoRoot, wt.path, force);
      removed.push({ runId, path: wt.path });
    } catch (err) {
      errors.push({
        path: wt.path,
        runId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Final prune — clean up admin dirs whose worktree paths vanished.
  // `-q` is forbidden on git 2.50+; we don't pass it (and `runGit` would
  // throw if we did). stdout/stderr are captured, so no TTY noise.
  try {
    await runGit(["worktree", "prune"], { cwd: opts.repoRoot });
  } catch (err) {
    errors.push({
      path: opts.repoRoot,
      runId: null,
      message: err instanceof Error ? err.message : String(err),
    });
  }

  return { removed, skipped, errors };
}

async function removeOne(repoRoot: string, path: string, force: boolean): Promise<void> {
  const args: string[] = ["worktree", "remove"];
  if (force) args.push("--force");
  args.push(path);
  await runGit(args, { cwd: repoRoot });
}

/**
 * Parse `git worktree list --porcelain` output.
 *
 * The porcelain v1 format is a sequence of empty-line-separated records.
 * Each record's first line is `worktree <path>`. Subsequent lines include
 * `HEAD <sha>`, `branch <ref>`, `bare`, `detached`, `locked`, `prunable`.
 * We only need the absolute path, the branch (if any), and whether the
 * worktree is bare/detached.
 *
 * Reference: `git-worktree(1)` — PORCELAIN FORMAT section.
 */
export function parseWorktreeList(output: string): readonly ParsedWorktree[] {
  const out: ParsedWorktree[] = [];
  const records = output.split(/\n\n+/);
  for (const rec of records) {
    const lines = rec.split("\n").filter((l) => l.length > 0);
    if (lines.length === 0) continue;
    const [first, ...rest] = lines;
    if (first === undefined || !first.startsWith("worktree ")) continue;
    const path = first.slice("worktree ".length);
    let branch: string | null = null;
    let isBare = false;
    let isDetached = false;
    for (const line of rest) {
      if (line === "bare") isBare = true;
      else if (line === "detached") isDetached = true;
      else if (line.startsWith("branch ")) branch = line.slice("branch ".length);
    }
    out.push({ path, branch, isBare, isDetached });
  }
  return out;
}

/** Re-export the default for callers that want to advertise the window. */
export const GC_DEFAULTS = {
  maxAgeHours: DEFAULT_MAX_AGE_HOURS,
  terminalStatuses: DEFAULT_TERMINAL_STATUSES,
} as const;
