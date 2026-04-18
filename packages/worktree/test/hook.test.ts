/**
 * Integration test: install the pre-commit hook into a real worktree.
 *
 * Verifies:
 *   - the file lands under `GIT_DIR/shamu-hooks/pre-commit`, NOT under
 *     the shared `GIT_COMMON_DIR/hooks/`
 *   - mode is `0o755`
 *   - contents embed the supplied checker path verbatim
 *   - `core.hooksPath` is set with `--worktree` scope so the hook applies
 *     to this worktree only, not its siblings
 *   - the hook actually fires on `git commit` and can block it
 *
 * We also assert the pure `renderHookScript` helper's output shape so
 * downstream changes to the template are visible in a dedicated test.
 */

import { chmodSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { newRunId } from "@shamu/shared/ids";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorktree } from "../src/create.ts";
import { HookInstallError, installPreCommitHook, renderHookScript } from "../src/hook.ts";
import { createTempRepo, runCmd, type TempRepo } from "./support/repo.ts";

describe("renderHookScript", () => {
  it("produces a bash script that execs the checker with forwarded argv", () => {
    const out = renderHookScript("/usr/local/bin/shamu-lease-check");
    expect(out).toContain("#!/usr/bin/env bash");
    expect(out).toContain('exec "/usr/local/bin/shamu-lease-check" "$@"');
    expect(out).toContain("@shamu/worktree.installPreCommitHook");
    // Ends with a trailing newline for POSIX-friendliness.
    expect(out.endsWith("\n")).toBe(true);
  });

  it("escapes double quotes and backslashes in the checker path", () => {
    const out = renderHookScript('/opt/with"quote/and\\backslash');
    expect(out).toContain('exec "/opt/with\\"quote/and\\\\backslash" "$@"');
  });
});

describe("installPreCommitHook", () => {
  let repo: TempRepo;

  beforeEach(async () => {
    repo = await createTempRepo("shamu-hook-");
  });

  afterEach(() => {
    repo.cleanup();
  });

  it("rejects empty worktreePath and empty leaseCheckerScript", async () => {
    await expect(installPreCommitHook("", { leaseCheckerScript: "/x" })).rejects.toBeInstanceOf(
      HookInstallError,
    );
    await expect(
      installPreCommitHook(repo.path, { leaseCheckerScript: "" }),
    ).rejects.toBeInstanceOf(HookInstallError);
  });

  it("installs into GIT_DIR/shamu-hooks, not the shared hooks directory", async () => {
    const rid = newRunId();
    const wt = await createWorktree({
      repoRoot: repo.path,
      runId: rid,
      baseBranch: "main",
    });

    const checker = "/opt/shamu/lease-checker.sh";
    const installed = await installPreCommitHook(wt.path, { leaseCheckerScript: checker });

    // For a secondary worktree, GIT_DIR is `.git/worktrees/<name>/`.
    // Shamu plants hooks at `<GIT_DIR>/shamu-hooks/pre-commit`.
    const expectedGitDir = join(repo.path, ".git", "worktrees", rid);
    expect(installed.path).toBe(join(expectedGitDir, "shamu-hooks", "pre-commit"));

    // The shared hooks dir must NOT have received a pre-commit from us.
    // The shared dir is `<repoRoot>/.git/hooks/pre-commit`.
    const sharedHook = join(repo.path, ".git", "hooks", "pre-commit");
    expect(installed.path).not.toBe(sharedHook);

    expect(installed.mode).toBe(0o755);
    const st = statSync(installed.path);
    // Low 9 bits are the POSIX permission bits.
    expect(st.mode & 0o777).toBe(0o755);

    const body = readFileSync(installed.path, { encoding: "utf8" });
    expect(body).toBe(renderHookScript(checker));
  });

  it("sets core.hooksPath with --worktree scope", async () => {
    const rid = newRunId();
    const wt = await createWorktree({
      repoRoot: repo.path,
      runId: rid,
      baseBranch: "main",
    });

    await installPreCommitHook(wt.path, { leaseCheckerScript: "/opt/check" });

    // The worktree-local core.hooksPath points at the shamu-hooks dir.
    const res = await runCmd("git", ["config", "--worktree", "core.hooksPath"], wt.path);
    const expected = join(repo.path, ".git", "worktrees", rid, "shamu-hooks");
    expect(res.stdout.trim()).toBe(expected);

    // The primary worktree has NOT been given the same override (that
    // would be a leak). `git config --worktree` only emits the value if
    // the worktree has a local override; we expect a non-zero exit
    // (config key not found) on the primary.
    const primaryRes = await new Promise<{ code: number }>((resolveP) => {
      import("node:child_process").then(({ spawn }) => {
        const child = spawn("git", ["config", "--worktree", "core.hooksPath"], {
          cwd: repo.path,
          stdio: ["ignore", "pipe", "pipe"],
        });
        child.on("close", (code) => resolveP({ code: code ?? -1 }));
      });
    });
    expect(primaryRes.code).not.toBe(0);
  });

  it("the installed hook actually fires on commit inside this worktree", async () => {
    const rid = newRunId();
    const wt = await createWorktree({
      repoRoot: repo.path,
      runId: rid,
      baseBranch: "main",
    });

    // Plant a checker that always exits 1.
    const checker = join(wt.path, "always-reject.sh");
    writeFileSync(checker, "#!/bin/sh\necho 'blocked'\nexit 1\n", { encoding: "utf8" });
    chmodSync(checker, 0o755);

    await installPreCommitHook(wt.path, { leaseCheckerScript: checker });

    // Stage a change and attempt to commit — should fail.
    writeFileSync(join(wt.path, "new.txt"), "hello\n", { encoding: "utf8" });
    await runCmd("git", ["add", "new.txt"], wt.path);

    const { spawn } = await import("node:child_process");
    const commitResult = await new Promise<{ code: number; stdout: string; stderr: string }>(
      (resolveP) => {
        const child = spawn("git", ["commit", "-m", "should-be-blocked"], {
          cwd: wt.path,
          stdio: ["ignore", "pipe", "pipe"],
        });
        const outChunks: Buffer[] = [];
        const errChunks: Buffer[] = [];
        child.stdout?.on("data", (d: Buffer) => outChunks.push(d));
        child.stderr?.on("data", (d: Buffer) => errChunks.push(d));
        child.on("close", (code) => {
          resolveP({
            code: code ?? -1,
            stdout: Buffer.concat(outChunks).toString("utf8"),
            stderr: Buffer.concat(errChunks).toString("utf8"),
          });
        });
      },
    );
    expect(commitResult.code).not.toBe(0);
    // The hook wrote "blocked" on stdout of the rejecting checker.
    expect(commitResult.stdout + commitResult.stderr).toContain("blocked");
  });

  it("overwrites an existing pre-commit file on reinstall", async () => {
    const rid = newRunId();
    const wt = await createWorktree({
      repoRoot: repo.path,
      runId: rid,
      baseBranch: "main",
    });

    const first = await installPreCommitHook(wt.path, { leaseCheckerScript: "/first" });
    const firstBody = readFileSync(first.path, { encoding: "utf8" });
    expect(firstBody).toContain('"/first"');

    const second = await installPreCommitHook(wt.path, { leaseCheckerScript: "/second" });
    expect(second.path).toBe(first.path);
    const secondBody = readFileSync(second.path, { encoding: "utf8" });
    expect(secondBody).toContain('"/second"');
    expect(secondBody).not.toContain('"/first"');
  });

  it("installs on the primary worktree too (GIT_DIR resolves to .git)", async () => {
    const installed = await installPreCommitHook(repo.path, {
      leaseCheckerScript: "/opt/check",
    });
    expect(installed.path).toBe(join(repo.path, ".git", "shamu-hooks", "pre-commit"));
  });
});
