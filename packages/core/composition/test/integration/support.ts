/**
 * Shared helpers for integration tests in the composition package.
 *
 * Creates a scratch git repo, a seeded `src/foo.ts` (used by scenarios
 * 2 and 3), and the shell helpers for `git worktree add`. Mirrors the
 * patterns in `@shamu/worktree/test/support/repo.ts`.
 */

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface TempRepo {
  readonly path: string;
  cleanup(): void;
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

/**
 * Create a scratch repo with a seeded `src/foo.ts` / `src/bar.ts` plus
 * `package.json` so the Phase 0.C scenarios have realistic content to
 * edit and merge.
 */
export async function createSpikeRepo(label: string): Promise<TempRepo> {
  const rawDir = mkdtempSync(join(tmpdir(), label));
  const dir = realpathSync(rawDir);
  await runCmd("git", ["init", "--initial-branch=main"], dir);
  await runCmd("git", ["config", "user.email", "shamu-test@example.invalid"], dir);
  await runCmd("git", ["config", "user.name", "Shamu Test"], dir);
  await runCmd("git", ["config", "commit.gpgsign", "false"], dir);

  // Seed content reminiscent of the 0.C spike's repo — foo/bar source
  // files + a package.json so the sentinel-glob scenario has something
  // real to hit.
  mkdirSync(join(dir, "src"), { recursive: true });
  const fooSeed = Array.from({ length: 60 }, (_, i) => `// foo line ${i}`).join("\n");
  const barSeed = Array.from({ length: 20 }, (_, i) => `// bar line ${i}`).join("\n");
  writeFileSync(join(dir, "src", "foo.ts"), `${fooSeed}\n`, { encoding: "utf8" });
  writeFileSync(join(dir, "src", "bar.ts"), `${barSeed}\n`, { encoding: "utf8" });
  writeFileSync(join(dir, "package.json"), `{\n  "name": "spike",\n  "version": "0.0.1"\n}\n`, {
    encoding: "utf8",
  });
  await runCmd("git", ["add", "."], dir);
  await runCmd("git", ["commit", "-m", "seed"], dir);

  return {
    path: dir,
    cleanup: () => {
      try {
        rmSync(rawDir, { recursive: true, force: true });
      } catch {
        // Best-effort.
      }
    },
  };
}

/** Write `content` to `<cwd>/<path>`, creating parents as needed. */
export function writeAt(cwd: string, path: string, content: string): void {
  const full = join(cwd, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, { encoding: "utf8" });
}

/**
 * Compute `git merge-base(integration, runBranch)` in `repoRoot` and
 * return the sha. Captured BEFORE a merge so later merges don't
 * collapse the result.
 */
export async function captureMergeBase(
  repoRoot: string,
  integrationBranch: string,
  runBranch: string,
): Promise<string> {
  const out = await runCmd("git", ["merge-base", integrationBranch, runBranch], repoRoot);
  return out.stdout.trim();
}

/**
 * Merge `runBranch` into `integrationBranch` (--no-ff --no-edit) from
 * `repoRoot`. Switches back to `main` when done to avoid side-effects
 * on the caller's index. Returns nothing — use {@link captureMergeBase}
 * BEFORE calling this to get the diff anchor.
 */
export async function mergeNoFf(
  repoRoot: string,
  integrationBranch: string,
  runBranch: string,
): Promise<void> {
  await runCmd("git", ["checkout", integrationBranch], repoRoot);
  await runCmd("git", ["merge", "--no-ff", "--no-edit", runBranch], repoRoot);
  await runCmd("git", ["checkout", "main"], repoRoot);
}
