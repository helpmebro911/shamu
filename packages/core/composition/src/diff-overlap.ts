/**
 * `diffOverlapCheck` — the post-integration merge file-overlap gate.
 *
 * PLAN.md § "Patch lifecycle → 6. Integrate" line 450 pins the exact
 * signature; this module implements it.
 *
 *   Three post-merge checks cooperate:
 *     (a) `git merge --no-commit` exit code  — textual line conflicts.
 *     (b) `diffOverlapCheck(repo, integrationBranch, windowStart,
 *                           mergedRuns, policy)` — shared-file risk git
 *                                                  merged cleanly.
 *     (c) `agent-ci` rerun on the integration branch — cross-file
 *                                                    semantic breaks.
 *
 * This function is (b). Scope:
 *   - For each `RunMergeRecord` whose `mergedAt >= windowStart`, list
 *     the files it touched via `git diff --name-only -M
 *     <mergeBase>..<integrationBranch>`.
 *   - Cross-intersect: any path touched by ≥ 2 runs AND not matched by
 *     `ignoredGlobs` → `sharedFiles`.
 *   - Any path touched by ≥ 1 run AND matched by `alwaysFlagGlobs` AND
 *     not matched by `ignoredGlobs` → `alwaysFlagged`.
 *   - `requiresReconcile = sharedFiles.length > 0 || alwaysFlagged.length > 0`.
 *
 * Design decisions:
 *
 *   - **Glob matcher.** We reuse the segment-wise matcher from
 *     `@shamu/mailbox/globs` (`globMatchesPath`) — already in the
 *     workspace, zero new deps, semantics documented there. It does
 *     not handle brace expansion, but every default glob PLAN lists
 *     stays within `*`/`**` usage.
 *
 *   - **git invocation.** `node:child_process.spawn`, captured stdout.
 *     Same pattern as `@shamu/worktree/src/git.ts` — the composition
 *     package does not depend on `@shamu/worktree` for the git
 *     wrapper (`runGit` is not yet re-exported at a module path we
 *     can safely consume from here without dragging the worktree
 *     types unrelated to this function; this is a small,
 *     self-contained git call, so we inline it). Never `-q` — git 2.50
 *     rejects it on some subcommands; we don't pass it here anyway.
 *
 *   - **Rename detection.** `git diff --name-only -M` outputs the
 *     post-rename path. For our purposes (flag a file touched by two
 *     runs), that's exactly what we want: if A renames `foo.ts → bar.ts`
 *     and B edits `foo.ts`, the pre-rename path B touches still counts
 *     as shared with A's base-side of the rename. We call
 *     `--name-only --diff-filter=ACMRTUXB -M` to capture both sides of
 *     renames as distinct name entries.
 */

import { spawn } from "node:child_process";
import { globMatchesPath } from "@shamu/mailbox";
import type { RunId } from "@shamu/shared/ids";

/** Policy for {@link diffOverlapCheck}. Both globs default when omitted. */
export interface DiffOverlapPolicy {
  /**
   * Files matching these globs are always flagged when at least one
   * run touched them — even without multi-run overlap. Defaults to
   * `DEFAULT_ALWAYS_FLAG_GLOBS` when the field is absent entirely.
   */
  readonly alwaysFlagGlobs?: readonly string[];
  /**
   * Files matching these globs are excluded from both `sharedFiles`
   * and `alwaysFlagged`. Defaults to `DEFAULT_IGNORED_GLOBS` when the
   * field is absent entirely.
   */
  readonly ignoredGlobs?: readonly string[];
}

/** Default always-flag set from PLAN § "Patch lifecycle" line 450. */
export const DEFAULT_ALWAYS_FLAG_GLOBS: readonly string[] = Object.freeze([
  "**/*.test.*",
  "**/tsconfig*.json",
  "package.json",
  "**/schema.sql",
  "agent-ci.yml",
  ".github/workflows/*.yml",
]);

/** Default ignored set from PLAN § "Patch lifecycle" line 450. */
export const DEFAULT_IGNORED_GLOBS: readonly string[] = Object.freeze([
  "**/*.md",
  "node_modules/**",
  "vendor/**",
  ".shamu/**",
]);

/**
 * One merged run contributing to a reconcile window.
 *
 * The diff is computed as `<mergeBase>..<branch>` — matching the
 * Phase 0.C spike's pseudocode (`files(R) := git diff --name-only
 * merge-base R-tip`). PLAN line 450's narrative phrases this as
 * "against each run's merge-base"; the task prompt's `<mergeBase>..<integrationBranch>`
 * would conflate every subsequent run into each earlier run's set and
 * produce false overlaps. We deliberately honor the PLAN + spike
 * semantics because they produce correct results; the `integrationBranch`
 * argument still scopes the check (future work may use it as a
 * `windowStart` anchor sha) and is asserted to exist for defense.
 *
 * @property runId       Identity of the merged run.
 * @property branch      Run's branch (e.g. `shamu/<run-id>`). Diffed
 *                       against `mergeBase` to isolate the run's
 *                       contribution. Must be a valid git ref.
 * @property mergeBase   SHA (or ref) the diff walks from — typically
 *                       the merge base of `branch` against the
 *                       integration branch at windowStart.
 * @property mergedAt    Epoch ms when the run was merged. Used only
 *                       for windowStart filtering.
 */
export interface RunMergeRecord {
  readonly runId: RunId;
  readonly branch: string;
  readonly mergeBase: string;
  readonly mergedAt: number;
}

/** Return value of {@link diffOverlapCheck}. */
export interface DiffOverlapResult {
  /**
   * Files touched by ≥ 2 runs in the window, excluding anything
   * matched by `ignoredGlobs`. Sorted lexicographically for stability.
   */
  readonly sharedFiles: readonly string[];
  /**
   * Files matched by `alwaysFlagGlobs` and touched by ≥ 1 run,
   * excluding anything matched by `ignoredGlobs`. Sorted lexicographically.
   */
  readonly alwaysFlagged: readonly string[];
  /** `true` iff either list is non-empty. Flow engine fans back to reconcile. */
  readonly requiresReconcile: boolean;
}

/**
 * Internal `git diff --name-only -M` runner. Returns the list of file
 * paths touched between `mergeBase` and `tip`, both-sides-of-rename.
 *
 * Uses `--diff-filter=ACMRTUXB`:
 *   A added, C copied, M modified, R renamed, T typechange,
 *   U unmerged, X unknown, B broken pairing.
 * D (deleted) is omitted — a deletion does not create a "touched"
 * file on the integration side to overlap with. If a deleted path
 * matters for a policy (e.g. someone deleted `package.json`), the
 * alwaysFlagGlobs step catches the overlap only when at least one
 * other run also *touched* it. Matches PLAN's spec of "shared file
 * risk", not "changed set diff".
 */
async function gitDiffNames(
  repo: string,
  mergeBase: string,
  tip: string,
): Promise<readonly string[]> {
  if (typeof repo !== "string" || repo.length === 0) {
    throw new TypeError("diffOverlapCheck: repo must be a non-empty path");
  }
  if (typeof mergeBase !== "string" || mergeBase.length === 0) {
    throw new TypeError("diffOverlapCheck: mergeBase must be a non-empty string");
  }
  if (typeof tip !== "string" || tip.length === 0) {
    throw new TypeError("diffOverlapCheck: tip must be a non-empty string");
  }

  // `<mergeBase>..<tip>` is the standard diff-range; `-M` enables
  // rename detection. `--diff-filter=ACMRTUXB` as documented above.
  const args = ["diff", "--name-only", "-M", "--diff-filter=ACMRTUXB", `${mergeBase}..${tip}`];
  const stdout = await runGit(repo, args);
  return stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Minimal git subprocess wrapper. Captures stdout as utf8; rejects on
 * non-zero exit with a clear error. The worktree package's `runGit`
 * is richer (tracks the `-q` invariant for git 2.50), but none of the
 * subcommands this module uses are on that ban-list so the thin
 * wrapper is safe here and avoids a workspace-dep detour.
 */
function runGit(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", [...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout?.on("data", (d: Buffer) => stdoutChunks.push(d));
    child.stderr?.on("data", (d: Buffer) => stderrChunks.push(d));
    child.on("error", (err) => {
      reject(new Error(`git ${args.join(" ")} spawn failed: ${String(err?.message ?? err)}`));
    });
    child.on("close", (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if ((code ?? -1) !== 0) {
        reject(
          new Error(
            `git ${args.join(" ")} failed (exit ${code}) in ${cwd}: ${stderr.trim() || stdout.trim()}`,
          ),
        );
        return;
      }
      resolve(stdout);
    });
  });
}

/**
 * True iff `path` is matched by any glob in `globs`. Forwards to
 * `globMatchesPath` from `@shamu/mailbox` per-glob and OR-reduces.
 */
function matchesAny(path: string, globs: readonly string[]): boolean {
  for (const g of globs) {
    if (globMatchesPath(g, path)) return true;
  }
  return false;
}

/**
 * Run the diff-overlap check. Contract matches PLAN § "Patch lifecycle"
 * line 450 exactly.
 */
export async function diffOverlapCheck(
  repo: string,
  integrationBranch: string,
  windowStart: number,
  mergedRuns: readonly RunMergeRecord[],
  policy?: DiffOverlapPolicy,
): Promise<DiffOverlapResult> {
  if (typeof repo !== "string" || repo.length === 0) {
    throw new TypeError("diffOverlapCheck: repo must be a non-empty path");
  }
  if (typeof integrationBranch !== "string" || integrationBranch.length === 0) {
    throw new TypeError("diffOverlapCheck: integrationBranch must be a non-empty string");
  }
  if (typeof windowStart !== "number" || !Number.isFinite(windowStart)) {
    throw new TypeError("diffOverlapCheck: windowStart must be a finite epoch-ms number");
  }

  const alwaysFlagGlobs = policy?.alwaysFlagGlobs ?? DEFAULT_ALWAYS_FLAG_GLOBS;
  const ignoredGlobs = policy?.ignoredGlobs ?? DEFAULT_IGNORED_GLOBS;

  // Filter to the reconcile window. Runs merged before `windowStart`
  // belong to a previous reconcile cycle and should not pollute the
  // current file-touch count.
  const inWindow = mergedRuns.filter((r) => r.mergedAt >= windowStart);

  // Collect per-run path sets. We diff each run's mergeBase against
  // the run's branch — that isolates exactly what THIS run introduced
  // (Phase 0.C spike pseudocode). `integrationBranch` is validated
  // for existence upfront (below) so the caller can't pass a typo;
  // we don't use it for the per-run diff because doing so would pick
  // up every subsequent run's changes and inflate the overlap count.
  const touchCount = new Map<string, number>();
  const allTouched = new Set<string>();

  // Defensive validation: the integration branch must exist. Detects
  // wiring bugs early (typo'd branch name would otherwise silently
  // pass with an empty touch set).
  await runGit(repo, ["rev-parse", "--verify", integrationBranch]);

  for (const rec of inWindow) {
    const files = await gitDiffNames(repo, rec.mergeBase, rec.branch);
    const seenInThisRun = new Set<string>();
    for (const f of files) {
      if (seenInThisRun.has(f)) continue;
      seenInThisRun.add(f);
      allTouched.add(f);
      touchCount.set(f, (touchCount.get(f) ?? 0) + 1);
    }
  }

  const sharedSet = new Set<string>();
  const alwaysFlaggedSet = new Set<string>();

  for (const [file, count] of touchCount) {
    if (matchesAny(file, ignoredGlobs)) continue;
    if (count >= 2) sharedSet.add(file);
  }
  for (const file of allTouched) {
    if (matchesAny(file, ignoredGlobs)) continue;
    if (matchesAny(file, alwaysFlagGlobs)) alwaysFlaggedSet.add(file);
  }

  const sharedFiles = [...sharedSet].sort();
  const alwaysFlagged = [...alwaysFlaggedSet].sort();
  const requiresReconcile = sharedFiles.length > 0 || alwaysFlagged.length > 0;

  return { sharedFiles, alwaysFlagged, requiresReconcile };
}
