import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CIRunSummary, ReviewerExcerptOptions } from "./types.ts";
import { parseRunDir } from "./parse-run-state.ts";
import { toDomainEvent } from "./excerpt.ts";
import type { CIDomainEvent } from "./types.ts";

/**
 * Spawn `agent-ci run` and return the structured result.
 *
 * Design notes:
 *
 *   - We always pass `--quiet` (agent-mode). This short-circuits the animated
 *     renderer and produces parseable stderr transitions.
 *   - We deliberately omit `--pause-on-failure` for the gate path; the caller
 *     can pass `pauseOnFailure: true` when they want an interactive pause.
 *   - `GITHUB_REPO` must be set (either in env or via `opts.env`) because
 *     agent-ci refuses to boot without one.
 *   - We locate the run directory by watching `<workDir>/runs/` for the
 *     latest `run-*` directory created after process start. agent-ci does not
 *     print the run directory anywhere machine-readable, so this is our
 *     only stable hook.
 */
export interface RunAgentCIOptions {
  cwd: string;
  githubRepo: string;
  /** Path to the agent-ci bin. Default: `npx @redwoodjs/agent-ci`. */
  bin?: string;
  workflow?: string;
  all?: boolean;
  pauseOnFailure?: boolean;
  extraArgs?: string[];
  env?: NodeJS.ProcessEnv;
  /** Reviewer excerpt tuning. */
  excerpt?: ReviewerExcerptOptions;
  /**
   * agent-ci's working directory where `runs/<runId>/` will land. Defaults to
   * `$TMPDIR/agent-ci/agent-ci`. Overrideable via AGENT_CI_WORK_DIR.
   */
  workingDir?: string;
  /** Fail the returned promise on non-zero exit. Default: false. */
  rejectOnNonZeroExit?: boolean;
  /** Capture stdout/stderr? Default: true. */
  capture?: boolean;
}

export interface RunAgentCIResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** null if we couldn't locate the run directory. */
  runDir: string | null;
  summary: CIRunSummary | null;
  domainEvent: CIDomainEvent | null;
}

export async function runAgentCI(opts: RunAgentCIOptions): Promise<RunAgentCIResult> {
  const args = buildArgs(opts);
  const workingDir = opts.workingDir ?? defaultWorkingDir();
  const runsDirBefore = listRunDirs(workingDir);

  const env = {
    ...process.env,
    ...opts.env,
    GITHUB_REPO: opts.githubRepo,
    AI_AGENT: "1",
  };

  const { command, spawnArgs } = resolveCommand(opts.bin, args);
  const child = spawn(command, spawnArgs, {
    cwd: opts.cwd,
    env,
    stdio: opts.capture === false ? "inherit" : ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  if (opts.capture !== false) {
    child.stdout?.on("data", (b) => (stdout += b.toString("utf-8")));
    child.stderr?.on("data", (b) => (stderr += b.toString("utf-8")));
  }

  const exitCode: number = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? -1));
  });

  if (opts.rejectOnNonZeroExit && exitCode !== 0) {
    throw new Error(`agent-ci exited ${exitCode}\n${stderr}`);
  }

  const runDir = findNewestRunDir(workingDir, runsDirBefore);
  let summary: CIRunSummary | null = null;
  let domainEvent: CIDomainEvent | null = null;
  if (runDir) {
    try {
      summary = parseRunDir(runDir);
      domainEvent = toDomainEvent(summary, opts.excerpt);
    } catch {
      // leave summary null — caller can inspect stdout/stderr
    }
  }

  return { exitCode, stdout, stderr, runDir, summary, domainEvent };
}

function buildArgs(opts: RunAgentCIOptions): string[] {
  const args = ["run"];
  if (opts.workflow) args.push("--workflow", opts.workflow);
  if (opts.all ?? !opts.workflow) args.push("--all");
  args.push("--quiet");
  if (opts.pauseOnFailure) args.push("--pause-on-failure");
  if (opts.extraArgs) args.push(...opts.extraArgs);
  return args;
}

function resolveCommand(bin: string | undefined, args: string[]): { command: string; spawnArgs: string[] } {
  if (!bin) {
    return { command: "npx", spawnArgs: ["@redwoodjs/agent-ci", ...args] };
  }
  return { command: bin, spawnArgs: args };
}

function defaultWorkingDir(): string {
  return path.join(os.tmpdir(), "agent-ci", "agent-ci");
}

function listRunDirs(workingDir: string): Set<string> {
  const runsDir = path.join(workingDir, "runs");
  if (!fs.existsSync(runsDir)) return new Set();
  return new Set(fs.readdirSync(runsDir).filter((n) => n.startsWith("run-")));
}

function findNewestRunDir(workingDir: string, existing: Set<string>): string | null {
  const runsDir = path.join(workingDir, "runs");
  if (!fs.existsSync(runsDir)) return null;
  const candidates = fs
    .readdirSync(runsDir)
    .filter((n) => n.startsWith("run-") && !existing.has(n));
  if (candidates.length === 0) return null;
  // Highest timestamp suffix (run-<ms>) wins.
  candidates.sort();
  const picked = candidates[candidates.length - 1];
  if (!picked) return null;
  return path.join(runsDir, picked);
}
