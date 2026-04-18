/**
 * Integration test: create + destroy a real git worktree against a temp repo.
 *
 * Each test spins up its own `mkdtemp` repo via `createTempRepo`, which is
 * committed to `main` with a single `.gitkeep`. The tests then exercise
 * the full lifecycle: `createWorktree` → verify disk state → verify
 * branch state → `destroyWorktree` → verify teardown. Cleanup runs in
 * `afterEach` regardless of outcome so no temp dirs leak into CI.
 */

import { existsSync } from "node:fs";
import { newRunId } from "@shamu/shared/ids";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorktree } from "../src/create.ts";
import { destroyWorktree } from "../src/destroy.ts";
import { runGit } from "../src/git.ts";
import { branchForRun, worktreePathForRun } from "../src/naming.ts";
import { createTempRepo, type TempRepo } from "./support/repo.ts";

describe("createWorktree + destroyWorktree", () => {
  let repo: TempRepo;

  beforeEach(async () => {
    repo = await createTempRepo("shamu-create-destroy-");
  });

  afterEach(() => {
    repo.cleanup();
  });

  it("creates a worktree with the canonical branch + path", async () => {
    const rid = newRunId();
    const handle = await createWorktree({
      repoRoot: repo.path,
      runId: rid,
      baseBranch: "main",
    });

    expect(handle.runId).toBe(rid);
    expect(handle.branch).toBe(branchForRun(rid));
    expect(handle.path).toBe(worktreePathForRun(repo.path, rid));
    expect(handle.baseBranch).toBe("main");
    expect(handle.repoRoot).toBe(repo.path);

    // Disk state: the worktree dir exists and contains the seeded file.
    expect(existsSync(handle.path)).toBe(true);
    expect(existsSync(`${handle.path}/.gitkeep`)).toBe(true);

    // Branch state: `shamu/<rid>` exists in the repo's ref list.
    const branches = await runGit(["branch", "--list", handle.branch], { cwd: repo.path });
    expect(branches.stdout).toContain(handle.branch);

    // And `git worktree list` knows about it.
    const list = await runGit(["worktree", "list", "--porcelain"], { cwd: repo.path });
    expect(list.stdout).toContain(`worktree ${handle.path}`);
    expect(list.stdout).toContain(`branch refs/heads/${handle.branch}`);
  });

  it("destroyWorktree removes the directory but preserves the branch by default", async () => {
    const rid = newRunId();
    const handle = await createWorktree({
      repoRoot: repo.path,
      runId: rid,
      baseBranch: "main",
    });

    await destroyWorktree(handle);

    expect(existsSync(handle.path)).toBe(false);

    // Branch is preserved.
    const branches = await runGit(["branch", "--list", handle.branch], { cwd: repo.path });
    expect(branches.stdout).toContain(handle.branch);

    // `git worktree list` no longer references the path.
    const list = await runGit(["worktree", "list", "--porcelain"], { cwd: repo.path });
    expect(list.stdout).not.toContain(handle.path);
  });

  it("destroyWorktree with pruneBranch=true deletes the branch", async () => {
    const rid = newRunId();
    const handle = await createWorktree({
      repoRoot: repo.path,
      runId: rid,
      baseBranch: "main",
    });

    await destroyWorktree(handle, { pruneBranch: true });

    const branches = await runGit(["branch", "--list", handle.branch], { cwd: repo.path });
    expect(branches.stdout.trim()).toBe("");
  });

  it("destroyWorktree with force=true tears down a dirty worktree", async () => {
    const rid = newRunId();
    const handle = await createWorktree({
      repoRoot: repo.path,
      runId: rid,
      baseBranch: "main",
    });

    // Dirty the worktree with an unstaged edit.
    const { writeFileSync } = await import("node:fs");
    writeFileSync(`${handle.path}/dirty.txt`, "uncommitted\n", { encoding: "utf8" });

    // Plain destroy refuses (non-zero exit from git worktree remove).
    await expect(destroyWorktree(handle)).rejects.toThrow();

    // Force succeeds.
    await destroyWorktree(handle, { force: true });
    expect(existsSync(handle.path)).toBe(false);
  });

  it("destroyWorktree tolerates a worktree whose directory was removed outside git", async () => {
    const rid = newRunId();
    const handle = await createWorktree({
      repoRoot: repo.path,
      runId: rid,
      baseBranch: "main",
    });

    const { rmSync } = await import("node:fs");
    rmSync(handle.path, { recursive: true, force: true });

    // destroyWorktree should detect the gone path and prune silently.
    await destroyWorktree(handle);

    const list = await runGit(["worktree", "list", "--porcelain"], { cwd: repo.path });
    expect(list.stdout).not.toContain(handle.path);
  });
});
