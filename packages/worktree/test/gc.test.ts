/**
 * Integration test for `garbageCollect`.
 *
 * Scenario: three real worktrees in a temp repo.
 *   - wt1: run status `completed`, updatedAt older than threshold → PRUNED
 *   - wt2: run status `failed`, updatedAt older than threshold → PRUNED
 *   - wt3: run status `running`, updatedAt recent → SKIPPED (not_terminal)
 *
 * We also inject a non-Shamu worktree (via `git worktree add` at a path
 * outside `.shamu/worktrees/`) to verify GC leaves foreign worktrees
 * alone.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { RunId } from "@shamu/shared/ids";
import { newRunId } from "@shamu/shared/ids";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorktree } from "../src/create.ts";
import { garbageCollect } from "../src/gc.ts";
import type { GCRunSnapshot } from "../src/types.ts";
import { createTempRepo, runCmd, type TempRepo } from "./support/repo.ts";

describe("garbageCollect", () => {
  let repo: TempRepo;

  beforeEach(async () => {
    repo = await createTempRepo("shamu-gc-");
  });

  afterEach(() => {
    repo.cleanup();
  });

  it("prunes terminal+old runs and leaves the rest", async () => {
    const r1 = newRunId();
    const r2 = newRunId();
    const r3 = newRunId();

    const wt1 = await createWorktree({ repoRoot: repo.path, runId: r1, baseBranch: "main" });
    const wt2 = await createWorktree({ repoRoot: repo.path, runId: r2, baseBranch: "main" });
    const wt3 = await createWorktree({ repoRoot: repo.path, runId: r3, baseBranch: "main" });

    const now = Date.now();
    const hour = 60 * 60 * 1000;
    const snapshots = new Map<RunId, GCRunSnapshot>([
      [r1, { status: "completed", updatedAt: now - 48 * hour }],
      [r2, { status: "failed", updatedAt: now - 48 * hour }],
      [r3, { status: "running", updatedAt: now - 1 * hour }],
    ]);

    const report = await garbageCollect({
      repoRoot: repo.path,
      now,
      persistenceReadRun: (rid) => snapshots.get(rid) ?? null,
    });

    const removedIds = report.removed.map((r) => r.runId);
    expect(removedIds).toContain(r1);
    expect(removedIds).toContain(r2);
    expect(removedIds).not.toContain(r3);

    expect(existsSync(wt1.path)).toBe(false);
    expect(existsSync(wt2.path)).toBe(false);
    expect(existsSync(wt3.path)).toBe(true);

    // The `r3` skip is classified as `run_not_terminal`.
    const r3Skip = report.skipped.find((s) => s.runId === r3);
    expect(r3Skip?.reason).toBe("run_not_terminal");

    expect(report.errors).toEqual([]);
  });

  it("classifies recency, missing-row, and unknown paths distinctly", async () => {
    const rRecent = newRunId();
    const rMissing = newRunId();

    const wtRecent = await createWorktree({
      repoRoot: repo.path,
      runId: rRecent,
      baseBranch: "main",
    });
    const wtMissing = await createWorktree({
      repoRoot: repo.path,
      runId: rMissing,
      baseBranch: "main",
    });

    // A worktree outside `.shamu/worktrees/` — simulates a user-created
    // one. GC must not touch it.
    const foreignPath = join(repo.path, "foreign-worktree");
    await runCmd("git", ["worktree", "add", "-b", "foreign", foreignPath, "main"], repo.path);

    const now = Date.now();
    const hour = 60 * 60 * 1000;

    const report = await garbageCollect({
      repoRoot: repo.path,
      now,
      persistenceReadRun: (rid) => {
        if (rid === rRecent) return { status: "completed", updatedAt: now - 1 * hour };
        // rMissing → null.
        return null;
      },
      maxAgeHours: 24,
    });

    expect(report.removed).toEqual([]);

    const recentEntry = report.skipped.find((s) => s.runId === rRecent);
    expect(recentEntry?.reason).toBe("run_too_recent");

    const missingEntry = report.skipped.find((s) => s.runId === rMissing);
    expect(missingEntry?.reason).toBe("run_row_missing");

    const foreignEntry = report.skipped.find((s) => s.path === foreignPath);
    expect(foreignEntry?.reason).toBe("path_not_under_shamu_worktrees");

    expect(existsSync(wtRecent.path)).toBe(true);
    expect(existsSync(wtMissing.path)).toBe(true);
    expect(existsSync(foreignPath)).toBe(true);
  });

  it("runs `git worktree prune` at the end without passing -q", async () => {
    // We can't intercept argv from inside `runGit` easily, but we can
    // observe two things:
    //   1. The call returns a valid report (so prune didn't error on `-q`).
    //   2. On git 2.50+, if we HAD passed `-q`, git would exit non-zero
    //      with "unknown switch `q'" — that would surface as an entry in
    //      `report.errors`. The empty errors array confirms compliance.
    const report = await garbageCollect({
      repoRoot: repo.path,
      now: Date.now(),
      persistenceReadRun: () => null,
    });
    expect(report.errors).toEqual([]);
  });

  it("forwards --force when opts.force is true", async () => {
    const rid = newRunId();
    const wt = await createWorktree({ repoRoot: repo.path, runId: rid, baseBranch: "main" });

    // Dirty the worktree.
    const { writeFileSync } = await import("node:fs");
    writeFileSync(`${wt.path}/untracked.txt`, "noise\n", { encoding: "utf8" });

    const now = Date.now();
    const hour = 60 * 60 * 1000;

    // Without force, removal fails and shows up as an error.
    const reportNoForce = await garbageCollect({
      repoRoot: repo.path,
      now,
      persistenceReadRun: () => ({ status: "failed", updatedAt: now - 48 * hour }),
    });
    expect(reportNoForce.removed).toEqual([]);
    expect(reportNoForce.errors.length).toBeGreaterThan(0);

    // With force, removal succeeds.
    const reportForce = await garbageCollect({
      repoRoot: repo.path,
      now,
      persistenceReadRun: () => ({ status: "failed", updatedAt: now - 48 * hour }),
      force: true,
    });
    expect(reportForce.removed.map((r) => r.runId)).toContain(rid);
    expect(existsSync(wt.path)).toBe(false);
  });
});
