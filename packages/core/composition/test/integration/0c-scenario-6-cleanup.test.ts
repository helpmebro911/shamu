/**
 * Phase 0.C Scenario 6 — Cleanup cost.
 *
 * Port of `docs/phase-0/worktree-merge-spike/scripts/scenario-6-cleanup.sh`.
 *
 * Creates 10 concurrent worktrees, destroys them all, and asserts the
 * total wall-clock create + destroy cost stays within a generous
 * ceiling. The Phase 0 spike observed ~23 ms/worktree on SSD for N=10;
 * we assert < 10 s total with a 400× multiplier so slow CI runners
 * (encrypted FS, noisy neighbors) don't flake. If a future regression
 * pushes the cost meaningfully higher, the bound trips and the
 * regression surfaces.
 *
 * Also confirms `git worktree prune` happily reaps an out-of-band
 * `rm -rf`'d worktree (the scenario in the spike's last bullet).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { newRunId } from "@shamu/shared/ids";
import {
  createWorktree,
  destroyWorktree,
  garbageCollect,
  type WorktreeHandle,
} from "@shamu/worktree";
import { createSpikeRepo, runCmd, type TempRepo } from "./support.ts";

describe("Phase 0.C scenario 6 — cleanup cost", () => {
  let repo: TempRepo;

  beforeEach(async () => {
    repo = await createSpikeRepo("shamu-0c-s6-");
  });

  afterEach(() => {
    repo.cleanup();
  });

  it("creates + destroys 10 worktrees within a generous time budget", async () => {
    // Per PLAN-confirmed spike numbers: ~23 ms/worktree create + ~22
    // ms destroy on SSD. 10 worktrees ≈ ~450 ms total on the spike
    // machine. The bound below is 10 s — a 20× multiplier over typical
    // macOS dev-laptop numbers, tolerating slow CI and background IO.
    const N = 10;
    const BUDGET_MS = 10_000;

    const handles: WorktreeHandle[] = [];
    const start = Date.now();
    for (let i = 0; i < N; i++) {
      const wt = await createWorktree({
        repoRoot: repo.path,
        runId: newRunId(),
        baseBranch: "main",
      });
      handles.push(wt);
    }
    const createdAt = Date.now();

    expect(handles).toHaveLength(N);
    for (const h of handles) {
      expect(existsSync(h.path)).toBe(true);
    }

    // Destroy each one. `force: true` covers the case where the
    // sandbox left untracked state; none of our seeds produce dirty
    // trees, so this should be a no-op flag in practice.
    for (const h of handles) {
      await destroyWorktree(h, { force: true });
    }
    const destroyedAt = Date.now();

    for (const h of handles) {
      expect(existsSync(h.path)).toBe(false);
    }

    const totalMs = destroyedAt - start;
    const createMs = createdAt - start;
    const destroyMs = destroyedAt - createdAt;
    // The spike observed < 1s on a Mac laptop; we allow 10s to
    // absorb CI jitter. If this trips reliably, either the primitive
    // regressed or the machine is much slower than expected.
    expect(totalMs).toBeLessThan(BUDGET_MS);
    // Emit a diagnostic log line on the console (allowed by Biome) so
    // slow runs surface the number without the test failing.
    console.warn(
      `[scenario 6] N=${N} create=${createMs}ms destroy=${destroyMs}ms total=${totalMs}ms (budget=${BUDGET_MS}ms; spike observed <1000ms locally)`,
    );
  });

  it("garbageCollect + `git worktree prune` reap an out-of-band rm -rf'd worktree", async () => {
    // Create a worktree, then delete the directory directly. `git
    // worktree list` will still show the admin entry as prunable;
    // `garbageCollect` triggers `git worktree prune` as its final
    // step and cleans up.
    const rid = newRunId();
    const wt = await createWorktree({
      repoRoot: repo.path,
      runId: rid,
      baseBranch: "main",
    });
    expect(existsSync(wt.path)).toBe(true);

    // Simulate a crash that deleted the directory without running
    // `git worktree remove`.
    rmSync(wt.path, { recursive: true, force: true });
    expect(existsSync(wt.path)).toBe(false);

    // GC with a never-terminal lookup — the prune is what matters.
    const report = await garbageCollect({
      repoRoot: repo.path,
      now: Date.now(),
      persistenceReadRun: () => null,
    });
    // Errors list is the important assertion; prune failing would
    // surface there. (The specific worktree is skipped because its
    // path isn't under `.shamu/worktrees/<non-existent>` once the
    // dir is gone — actually it IS still under that path, and git
    // reports a "prunable" annotation on the porcelain entry; the
    // final `git worktree prune` call mops it up. We assert no
    // errors as the smoke test.)
    expect(report.errors).toEqual([]);

    // Verify `git worktree list` no longer knows about the dead
    // worktree's admin dir.
    const listAfter = await runCmd("git", ["worktree", "list", "--porcelain"], repo.path);
    expect(listAfter.stdout).not.toContain(wt.path);
  });
});
