/**
 * Phase 0.C Scenario 2 — Overlapping edits, same lines.
 *
 * Port of `docs/phase-0/worktree-merge-spike/scripts/scenario-2-overlap.sh`.
 * Two worktrees rewrite the same lines of `src/foo.ts`. First merge is
 * clean; second merge returns a non-zero exit and git reports the path
 * as conflicted. We also confirm `diffOverlapCheck` would have flagged
 * the overlap independently (even if git had silently merged, the
 * file would be in `sharedFiles`).
 *
 * Asserts:
 *   - `git merge --no-ff --no-commit` exits 0 for merge A, non-zero for
 *     merge B — no stdout parsing required.
 *   - `diffOverlapCheck` reports `src/foo.ts` in `sharedFiles` once
 *     both runs are accounted for.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { newRunId } from "@shamu/shared/ids";
import { createWorktree, destroyWorktree, type WorktreeHandle } from "@shamu/worktree";
import { diffOverlapCheck, type RunMergeRecord } from "../../src/diff-overlap.ts";
import { captureMergeBase, createSpikeRepo, runCmd, type TempRepo, writeAt } from "./support.ts";

interface MergeResult {
  readonly exitCode: number;
  readonly stderr: string;
}

function runMerge(cwd: string, branch: string): Promise<MergeResult> {
  return new Promise((resolve) => {
    const child = spawn("git", ["merge", "--no-ff", "--no-commit", branch], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stderrChunks: Buffer[] = [];
    child.stderr?.on("data", (d: Buffer) => stderrChunks.push(d));
    child.on("close", (code) => {
      resolve({
        exitCode: code ?? -1,
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      });
    });
  });
}

describe("Phase 0.C scenario 2 — overlapping edits, same lines", () => {
  let repo: TempRepo;

  beforeEach(async () => {
    repo = await createSpikeRepo("shamu-0c-s2-");
  });

  afterEach(() => {
    repo.cleanup();
  });

  it("git merge exit code alone is sufficient to detect textual overlap", async () => {
    const runIdA = newRunId();
    const runIdB = newRunId();

    const wtA = await createWorktree({ repoRoot: repo.path, runId: runIdA, baseBranch: "main" });
    const wtB = await createWorktree({ repoRoot: repo.path, runId: runIdB, baseBranch: "main" });

    // Both rewrite foo.ts lines 10-15 with conflicting content.
    const seedLinesA = Array.from({ length: 60 }, (_, i) => `// foo line ${i}`);
    const seedLinesB = seedLinesA.slice();
    for (let i = 10; i < 16; i++) {
      seedLinesA[i] = `// A rewrite ${i}`;
      seedLinesB[i] = `// B rewrite ${i}`;
    }
    writeAt(wtA.path, "src/foo.ts", `${seedLinesA.join("\n")}\n`);
    writeAt(wtB.path, "src/foo.ts", `${seedLinesB.join("\n")}\n`);
    await runCmd("git", ["add", "src/foo.ts"], wtA.path);
    await runCmd("git", ["commit", "-m", "A: rewrite 10-15"], wtA.path);
    await runCmd("git", ["add", "src/foo.ts"], wtB.path);
    await runCmd("git", ["commit", "-m", "B: rewrite 10-15"], wtB.path);

    await runCmd("git", ["branch", "shamu/integration/s2"], repo.path);

    const baseA = await captureMergeBase(repo.path, "shamu/integration/s2", `shamu/${runIdA}`);
    const baseB = await captureMergeBase(repo.path, "shamu/integration/s2", `shamu/${runIdB}`);

    // Merge A: clean.
    await runCmd("git", ["checkout", "shamu/integration/s2"], repo.path);
    const mergeA = await runMerge(repo.path, `shamu/${runIdA}`);
    expect(mergeA.exitCode).toBe(0);
    await runCmd("git", ["commit", "--no-edit", "-m", `merge shamu/${runIdA}`], repo.path);

    // Merge B: conflicts.
    const mergeB = await runMerge(repo.path, `shamu/${runIdB}`);
    expect(mergeB.exitCode).not.toBe(0);

    // Confirm the conflicted-path filter reports src/foo.ts.
    const conflictedFiles = await runCmd(
      "git",
      ["diff", "--name-only", "--diff-filter=U"],
      repo.path,
    );
    expect(conflictedFiles.stdout.trim()).toBe("src/foo.ts");

    // Abort the conflicted merge to return to a clean state so the
    // diff-overlap check can re-diff the branches cleanly.
    await runCmd("git", ["merge", "--abort"], repo.path);
    await runCmd("git", ["checkout", "main"], repo.path);

    const records: RunMergeRecord[] = [
      { runId: runIdA, branch: `shamu/${runIdA}`, mergeBase: baseA, mergedAt: 1_000 },
      { runId: runIdB, branch: `shamu/${runIdB}`, mergeBase: baseB, mergedAt: 2_000 },
    ];
    const result = await diffOverlapCheck(repo.path, "shamu/integration/s2", 0, records);
    // Even if git had been silent, diff-overlap would have flagged
    // src/foo.ts as touched by two runs.
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
