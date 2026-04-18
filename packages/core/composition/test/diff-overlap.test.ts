/**
 * Tests for `diffOverlapCheck`.
 *
 * Builds small scratch git repos with deterministic histories, merges
 * simulated run-branches into an integration branch, and asserts the
 * per-file flag/shared/ignored accounting.
 *
 * Uses `bun:test` + `node:child_process` for git, same pattern as
 * `@shamu/worktree`'s tests. Fast by design (tiny repos, a few
 * commits each); no `SHAMU_INTEGRATION` gate needed.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { newRunId } from "@shamu/shared/ids";
import {
  DEFAULT_ALWAYS_FLAG_GLOBS,
  DEFAULT_IGNORED_GLOBS,
  diffOverlapCheck,
  type RunMergeRecord,
} from "../src/diff-overlap.ts";

interface CmdResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runCmd(cmd: string, args: readonly string[], cwd: string): Promise<CmdResult> {
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

async function createScratchRepo(label: string): Promise<string> {
  const rawDir = mkdtempSync(join(tmpdir(), label));
  const dir = realpathSync(rawDir);
  await runCmd("git", ["init", "--initial-branch=main"], dir);
  await runCmd("git", ["config", "user.email", "shamu-test@example.invalid"], dir);
  await runCmd("git", ["config", "user.name", "Shamu Test"], dir);
  await runCmd("git", ["config", "commit.gpgsign", "false"], dir);
  writeFileSync(join(dir, ".gitkeep"), "", { encoding: "utf8" });
  await runCmd("git", ["add", ".gitkeep"], dir);
  await runCmd("git", ["commit", "-m", "init"], dir);
  return dir;
}

/**
 * Create a branch off `main`, write files, commit, return to main. The
 * branch's commit sha is returned so the caller can later compute a
 * true `merge-base` against the integration branch at merge time.
 */
async function runBranchWithFiles(
  repo: string,
  branch: string,
  files: Record<string, string>,
): Promise<{ readonly tip: string }> {
  await runCmd("git", ["checkout", "-b", branch], repo);
  for (const [path, content] of Object.entries(files)) {
    const full = join(repo, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, { encoding: "utf8" });
    await runCmd("git", ["add", path], repo);
  }
  await runCmd(
    "git",
    ["commit", "-m", `${branch}: write ${Object.keys(files).length} file(s)`],
    repo,
  );
  const tipResult = await runCmd("git", ["rev-parse", "HEAD"], repo);
  const tip = tipResult.stdout.trim();
  await runCmd("git", ["checkout", "main"], repo);
  return { tip };
}

/**
 * Merge `runBranch` into `integrationBranch` (--no-ff). Captures the
 * true `git merge-base` between the integration branch and the run
 * branch — this is the "common ancestor" sha that, diffed against
 * the run branch, isolates exactly the run's own contribution.
 *
 * Captured BEFORE the merge so later merges can't advance the
 * merge-base (after merging, merge-base(integration, runBranch) would
 * collapse to the run branch's tip).
 */
async function mergeIntoIntegration(
  repo: string,
  integrationBranch: string,
  runBranch: string,
): Promise<{ readonly mergeBase: string }> {
  await runCmd("git", ["checkout", integrationBranch], repo);
  const mb = await runCmd("git", ["merge-base", "HEAD", runBranch], repo);
  const mergeBase = mb.stdout.trim();
  await runCmd("git", ["merge", "--no-ff", "--no-edit", runBranch], repo);
  await runCmd("git", ["checkout", "main"], repo);
  return { mergeBase };
}

describe("diffOverlapCheck", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await createScratchRepo("shamu-diff-overlap-");
    // Create the integration branch off main and return to main.
    await runCmd("git", ["branch", "shamu/integration/s1"], repo);
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("clean concurrent — different files, no overlap", async () => {
    // A edits src/foo.ts; B edits src/bar.ts. Merge both. No shared file.
    await runBranchWithFiles(repo, "shamu/run-A", { "src/foo.ts": "a()\n" });
    await runBranchWithFiles(repo, "shamu/run-B", { "src/bar.ts": "b()\n" });
    const m1 = await mergeIntoIntegration(repo, "shamu/integration/s1", "shamu/run-A");
    const m2 = await mergeIntoIntegration(repo, "shamu/integration/s1", "shamu/run-B");

    const records: RunMergeRecord[] = [
      { runId: newRunId(), branch: "shamu/run-A", mergeBase: m1.mergeBase, mergedAt: 1_000 },
      { runId: newRunId(), branch: "shamu/run-B", mergeBase: m2.mergeBase, mergedAt: 2_000 },
    ];
    const result = await diffOverlapCheck(repo, "shamu/integration/s1", 0, records);
    expect(result.sharedFiles).toEqual([]);
    expect(result.alwaysFlagged).toEqual([]);
    expect(result.requiresReconcile).toBe(false);
  });

  it("overlap on the same file — sharedFiles contains the path", async () => {
    await runBranchWithFiles(repo, "shamu/run-A", { "src/foo.ts": "a-version\n" });
    // B also touches src/foo.ts from the same base. Without merging A first
    // this would conflict textually, so we fork B from main then merge B
    // first and A second — simulating the "clean merge, overlap detected"
    // case. For this test, the textual conflict is not what we care
    // about; we just want both runs to have src/foo.ts in their diff.
    await runBranchWithFiles(repo, "shamu/run-B", { "src/foo.ts": "b-version\n" });
    const m1 = await mergeIntoIntegration(repo, "shamu/integration/s1", "shamu/run-A");
    // Force second merge to succeed by using --strategy=ours on the conflict;
    // this is only to keep the integration branch advancing — the diff
    // against the merge base still reports foo.ts as touched.
    await runCmd("git", ["checkout", "shamu/integration/s1"], repo);
    const baseResult = await runCmd("git", ["merge-base", "HEAD", "shamu/run-B"], repo);
    const m2Base = baseResult.stdout.trim();
    try {
      await runCmd("git", ["merge", "--no-ff", "--no-edit", "shamu/run-B"], repo);
    } catch {
      // Conflict expected — resolve by keeping B.
      await runCmd("git", ["checkout", "--theirs", "src/foo.ts"], repo);
      await runCmd("git", ["add", "src/foo.ts"], repo);
      await runCmd("git", ["commit", "--no-edit"], repo);
    }
    await runCmd("git", ["checkout", "main"], repo);

    const records: RunMergeRecord[] = [
      { runId: newRunId(), branch: "shamu/run-A", mergeBase: m1.mergeBase, mergedAt: 1_000 },
      { runId: newRunId(), branch: "shamu/run-B", mergeBase: m2Base, mergedAt: 2_000 },
    ];
    const result = await diffOverlapCheck(repo, "shamu/integration/s1", 0, records);
    expect(result.sharedFiles).toContain("src/foo.ts");
    expect(result.requiresReconcile).toBe(true);
  });

  it("disjoint same-file edits — git merges cleanly, overlap check flags", async () => {
    // A edits src/foo.ts early lines, B edits src/foo.ts late lines. Git
    // will merge cleanly; diff-overlap must still flag the shared file.
    const seed = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n");
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src/foo.ts"), seed, { encoding: "utf8" });
    await runCmd("git", ["add", "src/foo.ts"], repo);
    await runCmd("git", ["commit", "-m", "seed foo"], repo);
    // Re-anchor the integration branch to include the seed.
    await runCmd("git", ["branch", "-D", "shamu/integration/s1"], repo);
    await runCmd("git", ["branch", "shamu/integration/s1"], repo);

    // A: rewrite lines 1-5.
    const linesA = seed.split("\n");
    for (let i = 0; i < 5; i++) linesA[i] = `A-line ${i}`;
    await runBranchWithFiles(repo, "shamu/run-A", {
      "src/foo.ts": `${linesA.join("\n")}\n`,
    });
    // B: rewrite lines 50-55.
    const linesB = seed.split("\n");
    for (let i = 50; i < 56; i++) linesB[i] = `B-line ${i}`;
    await runBranchWithFiles(repo, "shamu/run-B", {
      "src/foo.ts": `${linesB.join("\n")}\n`,
    });
    const m1 = await mergeIntoIntegration(repo, "shamu/integration/s1", "shamu/run-A");
    // Second merge should succeed cleanly — disjoint line ranges.
    const m2 = await mergeIntoIntegration(repo, "shamu/integration/s1", "shamu/run-B");

    const records: RunMergeRecord[] = [
      { runId: newRunId(), branch: "shamu/run-A", mergeBase: m1.mergeBase, mergedAt: 1_000 },
      { runId: newRunId(), branch: "shamu/run-B", mergeBase: m2.mergeBase, mergedAt: 2_000 },
    ];
    const result = await diffOverlapCheck(repo, "shamu/integration/s1", 0, records);
    expect(result.sharedFiles).toContain("src/foo.ts");
    expect(result.requiresReconcile).toBe(true);
  });

  it("cross-file semantic — different files, no overlap at this layer", async () => {
    // A renames a function in foo.ts; B touches bar.ts (which would import
    // the old name). At this layer we do NOT read AST; the two runs touch
    // disjoint files so diff-overlap correctly returns empty. Comment: the
    // rerun-agent-ci step is where cross-file semantic breaks are caught.
    await runBranchWithFiles(repo, "shamu/run-A", {
      "src/foo.ts": "export function doThingV2() {}\n",
    });
    await runBranchWithFiles(repo, "shamu/run-B", {
      "src/bar.ts": "// annotated bar\n",
    });
    const m1 = await mergeIntoIntegration(repo, "shamu/integration/s1", "shamu/run-A");
    const m2 = await mergeIntoIntegration(repo, "shamu/integration/s1", "shamu/run-B");

    const records: RunMergeRecord[] = [
      { runId: newRunId(), branch: "shamu/run-A", mergeBase: m1.mergeBase, mergedAt: 1_000 },
      { runId: newRunId(), branch: "shamu/run-B", mergeBase: m2.mergeBase, mergedAt: 2_000 },
    ];
    const result = await diffOverlapCheck(repo, "shamu/integration/s1", 0, records);
    // diff-overlap cannot see semantic coupling — this is intentional.
    // The defense is the rerun agent-ci step; see PLAN § Patch lifecycle §6.
    expect(result.sharedFiles).toEqual([]);
    expect(result.alwaysFlagged).toEqual([]);
    expect(result.requiresReconcile).toBe(false);
  });

  it("package.json touched once — flagged by default alwaysFlagGlobs", async () => {
    await runBranchWithFiles(repo, "shamu/run-A", {
      "package.json": `{\n  "version": "0.0.1"\n}\n`,
    });
    const m1 = await mergeIntoIntegration(repo, "shamu/integration/s1", "shamu/run-A");

    const records: RunMergeRecord[] = [
      { runId: newRunId(), branch: "shamu/run-A", mergeBase: m1.mergeBase, mergedAt: 1_000 },
    ];
    const result = await diffOverlapCheck(repo, "shamu/integration/s1", 0, records);
    expect(result.alwaysFlagged).toContain("package.json");
    expect(result.sharedFiles).toEqual([]);
    expect(result.requiresReconcile).toBe(true);
  });

  it("docs/readme.md touched by two runs — ignored globs exclude it", async () => {
    await runBranchWithFiles(repo, "shamu/run-A", { "docs/readme.md": "v1\n" });
    await runBranchWithFiles(repo, "shamu/run-B", { "docs/readme.md": "v2\n" });
    const m1 = await mergeIntoIntegration(repo, "shamu/integration/s1", "shamu/run-A");
    await runCmd("git", ["checkout", "shamu/integration/s1"], repo);
    const baseResult = await runCmd("git", ["merge-base", "HEAD", "shamu/run-B"], repo);
    const m2Base = baseResult.stdout.trim();
    try {
      await runCmd("git", ["merge", "--no-ff", "--no-edit", "shamu/run-B"], repo);
    } catch {
      await runCmd("git", ["checkout", "--theirs", "docs/readme.md"], repo);
      await runCmd("git", ["add", "docs/readme.md"], repo);
      await runCmd("git", ["commit", "--no-edit"], repo);
    }
    await runCmd("git", ["checkout", "main"], repo);

    const records: RunMergeRecord[] = [
      { runId: newRunId(), branch: "shamu/run-A", mergeBase: m1.mergeBase, mergedAt: 1_000 },
      { runId: newRunId(), branch: "shamu/run-B", mergeBase: m2Base, mergedAt: 2_000 },
    ];
    const result = await diffOverlapCheck(repo, "shamu/integration/s1", 0, records);
    expect(result.sharedFiles).toEqual([]);
    expect(result.alwaysFlagged).toEqual([]);
    expect(result.requiresReconcile).toBe(false);
  });

  it("honors windowStart — earlier merges are excluded", async () => {
    await runBranchWithFiles(repo, "shamu/run-A", { "src/foo.ts": "a()\n" });
    await runBranchWithFiles(repo, "shamu/run-B", { "src/bar.ts": "b()\n" });
    const m1 = await mergeIntoIntegration(repo, "shamu/integration/s1", "shamu/run-A");
    const m2 = await mergeIntoIntegration(repo, "shamu/integration/s1", "shamu/run-B");

    const records: RunMergeRecord[] = [
      { runId: newRunId(), branch: "shamu/run-A", mergeBase: m1.mergeBase, mergedAt: 1_000 }, // before window
      { runId: newRunId(), branch: "shamu/run-B", mergeBase: m2.mergeBase, mergedAt: 5_000 },
    ];
    const result = await diffOverlapCheck(repo, "shamu/integration/s1", 2_500, records);
    // Only r2 in-window; its touched files are src/bar.ts alone → no shared.
    expect(result.sharedFiles).toEqual([]);
    expect(result.alwaysFlagged).toEqual([]);
    expect(result.requiresReconcile).toBe(false);
  });

  it("exposes stable default globs (PLAN line 450)", () => {
    expect(DEFAULT_ALWAYS_FLAG_GLOBS).toContain("package.json");
    expect(DEFAULT_ALWAYS_FLAG_GLOBS).toContain("**/*.test.*");
    expect(DEFAULT_ALWAYS_FLAG_GLOBS).toContain(".github/workflows/*.yml");
    expect(DEFAULT_IGNORED_GLOBS).toContain("**/*.md");
    expect(DEFAULT_IGNORED_GLOBS).toContain(".shamu/**");
  });

  it("rejects invalid repo / integrationBranch / windowStart", async () => {
    await expect(diffOverlapCheck("", "shamu/integration/x", 0, [])).rejects.toThrow(TypeError);
    await expect(diffOverlapCheck("/tmp", "", 0, [])).rejects.toThrow(TypeError);
    await expect(diffOverlapCheck("/tmp", "shamu/integration/x", Number.NaN, [])).rejects.toThrow(
      TypeError,
    );
  });

  it("rejects when the integration branch does not exist", async () => {
    await expect(diffOverlapCheck(repo, "shamu/integration/does-not-exist", 0, [])).rejects.toThrow(
      /rev-parse/,
    );
  });
});
