/**
 * Temp-repo helper for integration tests.
 *
 * Creates an isolated git repo via `mkdtemp`, commits a placeholder file
 * so `HEAD` resolves, and returns the absolute path plus a `cleanup()`
 * that recursively deletes the directory. Tests MUST call `cleanup()` in
 * `afterEach` to avoid leaking directories into CI runners.
 *
 * The helper uses `node:child_process` so it runs under both Bun and the
 * Vitest Node worker pool. It pins the initial branch to `main` so tests
 * aren't sensitive to the host's `init.defaultBranch` setting.
 *
 * It also plants a minimal `user.name` / `user.email` so `git commit`
 * succeeds in environments (CI containers, fresh macOS setups) where the
 * global config is empty — an integration test must not prompt for
 * interactive git identity.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TempRepo {
  readonly path: string;
  cleanup(): void;
}

/**
 * Create a fresh git repo in a temp directory and return its root.
 *
 * @param label — short prefix for the temp directory name (no slashes).
 *                Defaults to `"shamu-wt-test-"`.
 */
export async function createTempRepo(label = "shamu-wt-test-"): Promise<TempRepo> {
  const rawDir = mkdtempSync(join(tmpdir(), label));
  // macOS `tmpdir()` resolves to `/var/folders/...` which is a symlink to
  // `/private/var/folders/...`. `git worktree list` always reports the
  // realpath; if the test's asserted path differs from the realpath, the
  // comparison fails. We canonicalize up front so both sides match.
  const dir = realpathSync(rawDir);
  // `--initial-branch=main` is supported on git 2.28+; required here
  // because some CI images still default to `master`.
  await runCmd("git", ["init", "--initial-branch=main"], dir);
  await runCmd("git", ["config", "user.email", "shamu-test@example.invalid"], dir);
  await runCmd("git", ["config", "user.name", "Shamu Test"], dir);
  await runCmd("git", ["config", "commit.gpgsign", "false"], dir);
  // Commit an empty file so HEAD resolves. `.gitkeep` is conventional for
  // empty-dir markers; we use it as a single-file sentinel.
  writeFileSync(join(dir, ".gitkeep"), "", { encoding: "utf8" });
  await runCmd("git", ["add", ".gitkeep"], dir);
  await runCmd("git", ["commit", "-m", "init"], dir);

  return {
    path: dir,
    cleanup: () => {
      try {
        rmSync(rawDir, { recursive: true, force: true });
      } catch {
        // Best-effort — CI cleanup will sweep leftover temp dirs anyway.
      }
    },
  };
}

interface CmdResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export function runCmd(cmd: string, args: readonly string[], cwd: string): Promise<CmdResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, [...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout?.on("data", (d: Buffer) => stdoutChunks.push(d));
    child.stderr?.on("data", (d: Buffer) => stderrChunks.push(d));
    child.on("error", (e) => reject(e));
    child.on("close", (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if ((code ?? -1) !== 0) {
        reject(
          new Error(
            `${cmd} ${args.join(" ")} failed (exit ${code}) in ${cwd}: ${stderr.trim() || stdout.trim()}`,
          ),
        );
        return;
      }
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}
