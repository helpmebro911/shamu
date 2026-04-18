/**
 * Phase 0.C Scenario 4 — Cross-file semantic conflict.
 *
 * Port of `docs/phase-0/worktree-merge-spike/scripts/scenario-4-semantic.sh`.
 *
 * A renames `doThing` → `doThingV2` inside `src/foo.ts`. B annotates
 * `src/bar.ts` (which imports `doThing`). Both merges succeed
 * textually, but the result is semantically broken.
 *
 * At the diff-overlap layer: the two runs touch DIFFERENT files, so
 * diff-overlap correctly reports no shared file. This is intentional:
 * cross-file semantic coupling is the `rerun agent-ci` step's job to
 * catch (see PLAN § "Patch lifecycle" line 451). This test is a
 * defense-in-depth assertion that diff-overlap does NOT false-flag
 * independent files — keeping the reconcile fan-out signal strong.
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

describe("Phase 0.C scenario 4 — cross-file semantic conflict", () => {
  let repo: TempRepo;

  beforeEach(async () => {
    repo = await createSpikeRepo("shamu-0c-s4-");
  });

  afterEach(() => {
    repo.cleanup();
  });

  it("diff-overlap is silent on cross-file coupling (rerun-ci catches it)", async () => {
    const runIdA = newRunId();
    const runIdB = newRunId();

    const wtA = await createWorktree({ repoRoot: repo.path, runId: runIdA, baseBranch: "main" });
    const wtB = await createWorktree({ repoRoot: repo.path, runId: runIdB, baseBranch: "main" });

    // A: rename doThing → doThingV2 in foo.ts (adds export at the end).
    writeAt(
      wtA.path,
      "src/foo.ts",
      `// foo.ts\nexport function doThingV2(input: string): string {\n  return \`did:\${input}\`;\n}\n`,
    );
    // B: annotate bar.ts (still imports doThing — the semantic break).
    writeAt(
      wtB.path,
      "src/bar.ts",
      `// bar.ts — annotated by B\nimport { doThing } from "./foo";\nexport const useBar = () => doThing("x");\n`,
    );
    await runCmd("git", ["add", "src/foo.ts"], wtA.path);
    await runCmd("git", ["commit", "-m", "A: rename doThing"], wtA.path);
    await runCmd("git", ["add", "src/bar.ts"], wtB.path);
    await runCmd("git", ["commit", "-m", "B: annotate bar"], wtB.path);

    await runCmd("git", ["branch", "shamu/integration/s4"], repo.path);

    const baseA = await captureMergeBase(repo.path, "shamu/integration/s4", `shamu/${runIdA}`);
    const baseB = await captureMergeBase(repo.path, "shamu/integration/s4", `shamu/${runIdB}`);

    // Both merges succeed textually.
    await mergeNoFf(repo.path, "shamu/integration/s4", `shamu/${runIdA}`);
    await mergeNoFf(repo.path, "shamu/integration/s4", `shamu/${runIdB}`);

    const records: RunMergeRecord[] = [
      { runId: runIdA, branch: `shamu/${runIdA}`, mergeBase: baseA, mergedAt: 1_000 },
      { runId: runIdB, branch: `shamu/${runIdB}`, mergeBase: baseB, mergedAt: 2_000 },
    ];
    const result = await diffOverlapCheck(repo.path, "shamu/integration/s4", 0, records);
    // INTENTIONAL: diff-overlap does not inspect ASTs; it reports
    // touched-file overlap only. A and B touched different files. The
    // rerun-agent-ci step is where this class of break is caught.
    expect(result.sharedFiles).toEqual([]);
    expect(result.requiresReconcile).toBe(false);

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
