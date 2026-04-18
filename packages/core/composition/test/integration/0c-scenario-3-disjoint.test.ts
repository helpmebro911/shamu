/**
 * Phase 0.C Scenario 3 — Non-overlapping edits, same file.
 *
 * Port of `docs/phase-0/worktree-merge-spike/scripts/scenario-3-disjoint.sh`.
 *
 * A rewrites `src/foo.ts` lines 1-5; B rewrites `src/foo.ts` lines 50-55.
 * Git merges cleanly (disjoint line ranges). `diffOverlapCheck` flags
 * the shared file because both runs touched it — line-range "merge-ness"
 * is not a proxy for semantic safety.
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

describe("Phase 0.C scenario 3 — disjoint same-file edits", () => {
  let repo: TempRepo;

  beforeEach(async () => {
    repo = await createSpikeRepo("shamu-0c-s3-");
  });

  afterEach(() => {
    repo.cleanup();
  });

  it("git merges cleanly; diff-overlap flags the shared file", async () => {
    const runIdA = newRunId();
    const runIdB = newRunId();

    const wtA = await createWorktree({ repoRoot: repo.path, runId: runIdA, baseBranch: "main" });
    const wtB = await createWorktree({ repoRoot: repo.path, runId: runIdB, baseBranch: "main" });

    // Seed foo.ts has 60 numbered lines. A rewrites 0-4; B rewrites 50-54.
    const seedLinesA = Array.from({ length: 60 }, (_, i) => `// foo line ${i}`);
    const seedLinesB = seedLinesA.slice();
    for (let i = 0; i < 5; i++) seedLinesA[i] = `// A top ${i}`;
    for (let i = 50; i < 55; i++) seedLinesB[i] = `// B mid ${i}`;

    writeAt(wtA.path, "src/foo.ts", `${seedLinesA.join("\n")}\n`);
    writeAt(wtB.path, "src/foo.ts", `${seedLinesB.join("\n")}\n`);
    await runCmd("git", ["add", "src/foo.ts"], wtA.path);
    await runCmd("git", ["commit", "-m", "A: rewrite 0-4"], wtA.path);
    await runCmd("git", ["add", "src/foo.ts"], wtB.path);
    await runCmd("git", ["commit", "-m", "B: rewrite 50-54"], wtB.path);

    await runCmd("git", ["branch", "shamu/integration/s3"], repo.path);

    const baseA = await captureMergeBase(repo.path, "shamu/integration/s3", `shamu/${runIdA}`);
    const baseB = await captureMergeBase(repo.path, "shamu/integration/s3", `shamu/${runIdB}`);

    // Both merges should be clean — disjoint line ranges let git's
    // three-way merge resolve automatically.
    await mergeNoFf(repo.path, "shamu/integration/s3", `shamu/${runIdA}`);
    await mergeNoFf(repo.path, "shamu/integration/s3", `shamu/${runIdB}`);

    const records: RunMergeRecord[] = [
      { runId: runIdA, branch: `shamu/${runIdA}`, mergeBase: baseA, mergedAt: 1_000 },
      { runId: runIdB, branch: `shamu/${runIdB}`, mergeBase: baseB, mergedAt: 2_000 },
    ];
    const result = await diffOverlapCheck(repo.path, "shamu/integration/s3", 0, records);
    expect(result.sharedFiles).toContain("src/foo.ts");
    expect(result.requiresReconcile).toBe(true);

    await cleanupWorktrees([wtA, wtB]);
  });
});

async function cleanupWorktrees(handles: readonly WorktreeHandle[]): Promise<void> {
  for (const h of handles) {
    try {
      await destroyWorktree(h, { force: true });
    } catch {
      rmSync(h.path, { recursive: true, force: true });
    }
  }
}
