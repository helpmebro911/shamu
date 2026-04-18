/**
 * Phase 0.C Scenario 1 — Clean concurrent edits.
 *
 * Port of `docs/phase-0/worktree-merge-spike/scripts/scenario-1-clean.sh`
 * to a programmatic contract test built on `@shamu/worktree` (not
 * shelling out). Two worktrees edit disjoint files; both run-branches
 * merge cleanly into an integration branch; `diffOverlapCheck` reports
 * no shared files — baseline happy path.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { newRunId } from "@shamu/shared/ids";
import { createWorktree, destroyWorktree, type WorktreeHandle } from "@shamu/worktree";
import { diffOverlapCheck, type RunMergeRecord } from "../../src/diff-overlap.ts";
import {
  captureMergeBase,
  createSpikeRepo,
  mergeNoFf,
  runCmd,
  type TempRepo,
  writeAt,
} from "./support.ts";

describe("Phase 0.C scenario 1 — clean concurrent edits", () => {
  let repo: TempRepo;

  beforeEach(async () => {
    repo = await createSpikeRepo("shamu-0c-s1-");
  });

  afterEach(() => {
    repo.cleanup();
  });

  it("two disjoint-file worktrees merge cleanly; diff-overlap is empty", async () => {
    const runIdA = newRunId();
    const runIdB = newRunId();

    const wtA = await createWorktree({
      repoRoot: repo.path,
      runId: runIdA,
      baseBranch: "main",
    });
    const wtB = await createWorktree({
      repoRoot: repo.path,
      runId: runIdB,
      baseBranch: "main",
    });

    // A edits src/foo.ts (header comment); B edits src/bar.ts.
    // Configure committer identity inside each worktree (git config
    // lives at the repo level so it's already inherited, but the
    // copy-on-create semantics of worktrees mean we still need the
    // user config present — inherited here via the shared `.git/config`).
    writeAt(wtA.path, "src/foo.ts", "// A edits top of foo.ts\n");
    writeAt(wtB.path, "src/bar.ts", "// B edits top of bar.ts\n");
    await runCmd("git", ["add", "src/foo.ts"], wtA.path);
    await runCmd("git", ["commit", "-m", "A: edit foo"], wtA.path);
    await runCmd("git", ["add", "src/bar.ts"], wtB.path);
    await runCmd("git", ["commit", "-m", "B: edit bar"], wtB.path);

    // Integration branch off main.
    await runCmd("git", ["branch", "shamu/integration/s1"], repo.path);

    // Capture each run's true merge-base against integration BEFORE
    // merging. Both runs branched off main-seed, so their merge-bases
    // are the same pre-merge sha.
    const baseA = await captureMergeBase(repo.path, "shamu/integration/s1", `shamu/${runIdA}`);
    const baseB = await captureMergeBase(repo.path, "shamu/integration/s1", `shamu/${runIdB}`);

    // Merge A then B into integration. `git merge --no-ff` exit code
    // is 0 for both (scenario 1 == clean concurrent, disjoint files).
    await mergeNoFf(repo.path, "shamu/integration/s1", `shamu/${runIdA}`);
    await mergeNoFf(repo.path, "shamu/integration/s1", `shamu/${runIdB}`);

    const records: RunMergeRecord[] = [
      { runId: runIdA, branch: `shamu/${runIdA}`, mergeBase: baseA, mergedAt: 1_000 },
      { runId: runIdB, branch: `shamu/${runIdB}`, mergeBase: baseB, mergedAt: 2_000 },
    ];
    const result = await diffOverlapCheck(repo.path, "shamu/integration/s1", 0, records);
    expect(result.sharedFiles).toEqual([]);
    // package.json was seeded unchanged — should not surface.
    expect(result.alwaysFlagged).toEqual([]);
    expect(result.requiresReconcile).toBe(false);

    await cleanupWorktrees(repo.path, [wtA, wtB]);
  });
});

async function cleanupWorktrees(
  repoRoot: string,
  handles: readonly WorktreeHandle[],
): Promise<void> {
  await runCmd("git", ["checkout", "main"], repoRoot);
  for (const h of handles) {
    try {
      await destroyWorktree(h, { force: true });
    } catch {
      rmSync(h.path, { recursive: true, force: true });
    }
  }
}
