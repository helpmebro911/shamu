/**
 * Pre-commit guard.
 *
 * PLAN.md § "Patch lifecycle": pre-commit rejects a commit whose author
 * does not hold a live lease covering every staged path. This is defense
 * in depth — path-scope is primarily enforced at tool-dispatch time
 * (G4) inside the adapter; the git hook catches escapes.
 *
 * Design:
 *   - {@link checkStagedPaths} is pure: takes staged paths + live leases
 *     + the committing agent, returns which paths are uncovered. No
 *     side effects, no git exec, no DB. Trivially unit-testable.
 *   - {@link runPreCommitGuard} is the wiring helper: shells
 *     `git diff --cached --name-only`, reads live leases from the DB
 *     filtered to `agent`, calls {@link checkStagedPaths}, and returns
 *     the exit-code + message the hook script should use.
 */

import { execFile } from "node:child_process";
import type { ShamuDatabase } from "@shamu/persistence/db";
import { type LeaseRow, listActive as persistListActive } from "@shamu/persistence/queries/leases";
import { globMatchesPath } from "./globs.ts";
import type { PreCommitDecision } from "./types.ts";

/**
 * Pure check: does the committing agent hold lease coverage for every
 * staged path?
 *
 * `leases` should be the set of **live** leases known to belong to
 * `agent` (the caller filters by agent + expiry before calling). We
 * keep the filter out of this function so the function body stays a
 * readable predicate.
 */
export function checkStagedPaths(input: {
  readonly stagedPaths: readonly string[];
  readonly leases: readonly LeaseRow[];
  readonly agent: string;
}): PreCommitDecision {
  const { stagedPaths, leases, agent } = input;
  const ownedLeases = leases.filter((l) => l.agent === agent);
  const blocked: string[] = [];

  for (const path of stagedPaths) {
    const covered = ownedLeases.some((l) => globMatchesPath(l.glob, path));
    if (!covered) blocked.push(path);
  }

  return {
    allowed: blocked.length === 0,
    blocked,
  };
}

// --- Wiring helper -----------------------------------------------------------

interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
}

type ExecFn = (cmd: string, args: readonly string[], cwd: string) => Promise<ExecResult>;

const defaultExec: ExecFn = (cmd, args, cwd) =>
  new Promise((resolve, reject) => {
    execFile(cmd, [...args], { cwd, encoding: "utf8" }, (err, stdout, stderr) => {
      if (err !== null) {
        reject(err);
        return;
      }
      resolve({ stdout, stderr });
    });
  });

/** Options for {@link runPreCommitGuard}. */
export interface PreCommitGuardOptions {
  readonly worktreePath: string;
  readonly agent: string;
  readonly db: ShamuDatabase;
  readonly now?: number;
  readonly exec?: ExecFn;
}

export interface PreCommitGuardResult {
  readonly exitCode: number;
  readonly message: string;
  readonly decision: PreCommitDecision;
}

/**
 * Full pre-commit flow.
 *
 * 1. Shell `git diff --cached --name-only` in the worktree to get staged paths.
 * 2. Query live leases in the DB filtered to `agent`.
 * 3. Run {@link checkStagedPaths}.
 * 4. Return `{ exitCode: 0, "OK" }` if allowed, `{ exitCode: 1, "blocked:
 *    <paths>" }` otherwise.
 *
 * On a shell failure (`git` not found, wrong cwd, etc.) we return exit
 * code 2 with the error message — the hook script should treat anything
 * non-zero as a block.
 */
export async function runPreCommitGuard(
  opts: PreCommitGuardOptions,
): Promise<PreCommitGuardResult> {
  const exec = opts.exec ?? defaultExec;
  const now = opts.now ?? Date.now();

  let stagedPaths: readonly string[];
  try {
    const result = await exec("git", ["diff", "--cached", "--name-only"], opts.worktreePath);
    stagedPaths = result.stdout
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  } catch (cause) {
    return {
      exitCode: 2,
      message: `pre-commit: failed to list staged paths: ${String(cause)}`,
      decision: { allowed: false, blocked: [] },
    };
  }

  if (stagedPaths.length === 0) {
    return {
      exitCode: 0,
      message: "pre-commit: nothing staged",
      decision: { allowed: true, blocked: [] },
    };
  }

  const liveLeases = persistListActive(opts.db, now);
  const decision = checkStagedPaths({
    stagedPaths,
    leases: liveLeases,
    agent: opts.agent,
  });

  if (decision.allowed) {
    return {
      exitCode: 0,
      message: `pre-commit: ${stagedPaths.length} staged path(s) covered by live leases`,
      decision,
    };
  }

  return {
    exitCode: 1,
    message: `pre-commit: ${decision.blocked.length} staged path(s) not covered by any live lease held by "${opts.agent}":\n  ${decision.blocked.join("\n  ")}`,
    decision,
  };
}
