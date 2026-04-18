/**
 * CI gate driver: spawn `@redwoodjs/agent-ci` via `Bun.spawn`, discover the
 * run directory it created, parse the result, and project a domain event.
 *
 * Invariants (Phase 0.D spike, PLAN § 10):
 *
 *   - `GITHUB_REPO` must be set before spawn; we read the worktree's `origin`
 *     remote and parse it. A caller-supplied value in `opts.env.GITHUB_REPO`
 *     (explicit) wins over the inferred value.
 *
 *   - The child process inherits a minimal env allow-list: `PATH`, `HOME`,
 *     `LANG`, `USER`, `GITHUB_REPO`, plus any `AGENT_CI_*` and `GITHUB_TOKEN`
 *     entries the caller explicitly forwards via `opts.env`. No blanket
 *     `process.env` inheritance.
 *
 *   - agent-ci does NOT emit the run directory anywhere machine-readable, so
 *     we discover it by diffing `<workDir>/runs/` before and after the spawn.
 *
 *   - Aggregate run status comes from workflow + job statuses via
 *     `parseRunState`. Never trust the top-level `state.status`.
 *
 *   - Interrupt path: call agent-ci's own abort command first (if the binary
 *     supports it on this release; currently we SIGTERM the child), then reap
 *     any orphaned `agent-ci-<n>` Docker containers. Docker reaping is a
 *     best-effort safety net; skip silently if Docker isn't installed.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { toDomainEvent } from "./excerpt.ts";
import { parseRunDir } from "./parse-run-state.ts";
import type { CIDomainEvent, CIRunSummary, ReviewerExcerptOptions } from "./types.ts";

export interface RunGateOptions {
  /** Worktree root. agent-ci is spawned with this cwd. */
  cwd: string;
  /**
   * `owner/repo`. If omitted, we call `git remote get-url origin` inside
   * `cwd` and parse. A caller-supplied `env.GITHUB_REPO` trumps this.
   */
  githubRepo?: string;
  /** Path to the agent-ci bin. Default: `npx @redwoodjs/agent-ci`. */
  bin?: string;
  workflow?: string;
  all?: boolean;
  pauseOnFailure?: boolean;
  extraArgs?: string[];
  /** Caller-forwarded env entries. Subject to the allow-list. */
  env?: Record<string, string | undefined>;
  /** Reviewer excerpt tuning. */
  excerpt?: ReviewerExcerptOptions;
  /**
   * agent-ci's work directory where `runs/<runId>/` lands. Defaults to
   * `$TMPDIR/agent-ci/agent-ci`.
   */
  workingDir?: string;
  /** Fail the returned promise on non-zero exit. Default: false. */
  rejectOnNonZeroExit?: boolean;
  /**
   * AbortSignal for caller-driven interrupts. When aborted we call the
   * interrupt path (see invariants).
   */
  signal?: AbortSignal;
  /**
   * Hook for the Docker-container reaper. Injected for tests; default
   * implementation shells out to `docker ps` + `docker rm`. Set to `null` to
   * disable reaping entirely.
   */
  dockerReaper?: DockerReaper | null;
  /** Logger sink (defaults to `console.warn` on Docker-reaper errors only). */
  logger?: GateLogger;
}

export interface GateResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** null if we couldn't locate the run directory. */
  runDir: string | null;
  summary: CIRunSummary | null;
  domainEvent: CIDomainEvent | null;
}

export interface GateLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
}

export type DockerReaper = () => Promise<void>;

// --- Pure helpers (unit-tested directly) ------------------------------------

/**
 * Parse a git remote URL into `owner/repo`.
 *
 * Accepts:
 *   - `https://github.com/owner/repo(.git)?`
 *   - `git@github.com:owner/repo(.git)?`
 *   - `ssh://git@github.com/owner/repo(.git)?`
 *
 * Returns `null` for unrecognised shapes. Intentionally narrow: GitHub is the
 * only host agent-ci cares about; non-GitHub remotes are user error here.
 */
export function parseOriginToGithubRepo(url: string): string | null {
  const trimmed = url.trim();
  if (trimmed.length === 0) return null;
  const m = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(trimmed);
  if (!m) return null;
  const owner = m[1];
  const repo = m[2];
  if (!owner || !repo) return null;
  return `${owner}/${repo}`;
}

/** Default env keys that flow through the allow-list. */
export const DEFAULT_ENV_ALLOWLIST = ["PATH", "HOME", "LANG", "USER"] as const;

/**
 * Build a minimal env for the agent-ci subprocess.
 *
 * Rules:
 *   1. Start from `process.env` but keep only the `DEFAULT_ENV_ALLOWLIST` keys.
 *   2. Merge `forwarded` (caller-supplied) ON TOP. Caller values always win
 *      when set; `undefined` values in `forwarded` delete any allow-listed
 *      defaults (explicit unset).
 *   3. Keep any `AGENT_CI_*` and `GITHUB_TOKEN` entries that the caller chose
 *      to forward explicitly via `forwarded`.
 *   4. `GITHUB_REPO` must already be present in `forwarded` (the gate driver
 *      computes and injects it). We assert non-empty.
 *   5. `AI_AGENT=1` is set unconditionally — it disables agent-ci's animated
 *      renderer, which is what agent-mode callers want.
 */
export function buildAllowlistedEnv(
  processEnv: Readonly<Record<string, string | undefined>>,
  forwarded: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of DEFAULT_ENV_ALLOWLIST) {
    const v = processEnv[key];
    if (typeof v === "string") out[key] = v;
  }
  for (const [key, value] of Object.entries(forwarded)) {
    if (value === undefined) {
      delete out[key];
      continue;
    }
    out[key] = value;
  }
  if (!out.GITHUB_REPO || out.GITHUB_REPO.length === 0) {
    throw new GateBootError(
      "GITHUB_REPO must be set in the forwarded env before calling buildAllowlistedEnv",
    );
  }
  out.AI_AGENT = "1";
  return out;
}

/**
 * Given the set of run-dir names present BEFORE spawn and AFTER spawn,
 * identify the single new run directory. If zero or more than one appeared,
 * return the highest-sorted new name (timestamp suffix wins) or null.
 */
export function diffRunDirs(before: ReadonlySet<string>, after: Iterable<string>): string | null {
  const created: string[] = [];
  for (const name of after) {
    if (!before.has(name) && name.startsWith("run-")) created.push(name);
  }
  if (created.length === 0) return null;
  created.sort();
  return created[created.length - 1] ?? null;
}

/** Errors surfaced by the gate driver. */
export class GateBootError extends Error {
  public readonly code = "gate_boot_failed" as const;
}

// --- Discovery --------------------------------------------------------------

/**
 * Resolve `owner/repo` for agent-ci. Order of precedence:
 *   1. Caller-supplied `opts.env.GITHUB_REPO` (explicit).
 *   2. Caller-supplied `opts.githubRepo`.
 *   3. `git remote get-url origin` in `opts.cwd`, parsed.
 *
 * Returns null if none of these yield a value — the caller should treat that
 * as a boot error.
 */
export async function resolveGithubRepo(opts: RunGateOptions): Promise<string | null> {
  const explicit = opts.env?.GITHUB_REPO;
  if (typeof explicit === "string" && explicit.length > 0) return explicit;
  if (opts.githubRepo && opts.githubRepo.length > 0) return opts.githubRepo;
  const url = await readGitOriginUrl(opts.cwd);
  if (url === null) return null;
  return parseOriginToGithubRepo(url);
}

async function readGitOriginUrl(cwd: string): Promise<string | null> {
  if (typeof Bun !== "undefined" && typeof Bun.spawn === "function") {
    try {
      const proc = Bun.spawn({
        cmd: ["git", "remote", "get-url", "origin"],
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdoutText = await new Response(proc.stdout as ReadableStream).text();
      const code = await proc.exited;
      if (code !== 0) return null;
      const trimmed = stdoutText.trim();
      return trimmed.length > 0 ? trimmed : null;
    } catch {
      return null;
    }
  }
  // Non-Bun runtime (Vitest worker) — do a blocking fallback via node:child_process.
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync("git", ["remote", "get-url", "origin"], { cwd, encoding: "utf8" });
  if (r.status !== 0) return null;
  const trimmed = r.stdout.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Default working directory (matches spike + scripts/agent-ci.ts default). */
export function defaultWorkingDir(): string {
  return path.join(os.tmpdir(), "agent-ci", "agent-ci");
}

function listRunDirNames(workingDir: string): Set<string> {
  const runsDir = path.join(workingDir, "runs");
  if (!fs.existsSync(runsDir)) return new Set();
  return new Set(fs.readdirSync(runsDir).filter((n) => n.startsWith("run-")));
}

function buildArgs(opts: RunGateOptions): string[] {
  const args: string[] = ["run"];
  if (opts.workflow) args.push("--workflow", opts.workflow);
  if (opts.all ?? !opts.workflow) args.push("--all");
  args.push("--quiet");
  if (opts.pauseOnFailure) args.push("--pause-on-failure");
  if (opts.extraArgs) args.push(...opts.extraArgs);
  return args;
}

function resolveCommand(bin: string | undefined, args: string[]): string[] {
  if (!bin) return ["npx", "@redwoodjs/agent-ci", ...args];
  return [bin, ...args];
}

// --- Docker reaper ---------------------------------------------------------

/**
 * Default Docker reaper: lists containers whose names start with `agent-ci-`
 * and force-removes them. If the `docker` CLI is missing, silently returns
 * (agent-ci can run without Docker on some setups).
 */
export const defaultDockerReaper: DockerReaper = async () => {
  if (typeof Bun === "undefined" || typeof Bun.spawn !== "function") return;
  let names: string[];
  try {
    const list = Bun.spawn({
      cmd: ["docker", "ps", "-a", "--filter", "name=^/agent-ci-", "--format", "{{.Names}}"],
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await list.exited;
    if (code !== 0) return;
    const text = await new Response(list.stdout as ReadableStream).text();
    names = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  } catch {
    return;
  }
  if (names.length === 0) return;
  try {
    const rm = Bun.spawn({
      cmd: ["docker", "rm", "-f", ...names],
      stdout: "pipe",
      stderr: "pipe",
    });
    await rm.exited;
  } catch {
    // Best-effort — a container going away between ps and rm is fine.
  }
};

// --- Driver -----------------------------------------------------------------

/**
 * Spawn agent-ci, discover the run dir, parse + project, and return the
 * gate result.
 */
export async function runGate(opts: RunGateOptions): Promise<GateResult> {
  if (typeof Bun === "undefined" || typeof Bun.spawn !== "function") {
    throw new GateBootError(
      "runGate requires Bun at runtime; tests should stub the gate or skip under Vitest",
    );
  }

  const repo = await resolveGithubRepo(opts);
  if (!repo) {
    throw new GateBootError(
      `Could not resolve GITHUB_REPO from opts.env / opts.githubRepo / git remote (cwd=${opts.cwd})`,
    );
  }

  const forwarded: Record<string, string | undefined> = {
    ...(opts.env ?? {}),
    GITHUB_REPO: repo,
  };
  const env = buildAllowlistedEnv(process.env as Record<string, string | undefined>, forwarded);

  const workingDir = opts.workingDir ?? defaultWorkingDir();
  const runsDirBefore = listRunDirNames(workingDir);

  const args = buildArgs(opts);
  const cmd = resolveCommand(opts.bin, args);

  const logger: GateLogger = opts.logger ?? {
    warn: (m) => console.warn(`[shamu/ci] ${m}`),
  };

  const proc = Bun.spawn({
    cmd,
    cwd: opts.cwd,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const abortHandler = async (): Promise<void> => {
    // Interrupt path: SIGTERM the child first (agent-ci installs its own
    // SIGTERM handler that performs the graceful abort on recent releases).
    try {
      proc.kill("SIGTERM");
    } catch {
      // Already dead; nothing to do.
    }
    if (opts.dockerReaper === null) return;
    const reaper = opts.dockerReaper ?? defaultDockerReaper;
    try {
      await reaper();
    } catch (cause) {
      logger.warn("docker reaper raised; continuing shutdown", {
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  };

  let abortListener: (() => void) | null = null;
  if (opts.signal) {
    abortListener = () => {
      void abortHandler();
    };
    opts.signal.addEventListener("abort", abortListener);
    if (opts.signal.aborted) abortListener();
  }

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
    proc.exited,
  ]);

  if (opts.signal && abortListener) {
    opts.signal.removeEventListener("abort", abortListener);
  }

  if (opts.rejectOnNonZeroExit && exitCode !== 0) {
    throw new GateBootError(`agent-ci exited ${exitCode}\n${stderr}`);
  }

  const runDirName = diffRunDirs(runsDirBefore, listRunDirNames(workingDir));
  const runDir = runDirName ? path.join(workingDir, "runs", runDirName) : null;

  let summary: CIRunSummary | null = null;
  let domainEvent: CIDomainEvent | null = null;
  if (runDir) {
    try {
      summary = parseRunDir(runDir);
      domainEvent = toDomainEvent(summary, opts.excerpt);
    } catch (cause) {
      logger.warn("parseRunDir failed; caller can inspect stdout/stderr", {
        runDir,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  return { exitCode, stdout, stderr, runDir, summary, domainEvent };
}
