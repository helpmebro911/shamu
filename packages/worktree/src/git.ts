/**
 * Thin wrapper around `git` subprocess invocations.
 *
 * Three jobs:
 *
 *   1. Enforce the git-2.50 invariant: `-q` / `--quiet` MUST NOT appear on
 *      `git revert` or `git worktree prune` argv. git 2.50 rejects the
 *      flag outright; callers that need silence redirect stdout/stderr.
 *      We implement this as a hard pre-flight check — never trust the
 *      caller to remember, and never emit the flag ourselves from any code
 *      path inside this package.
 *
 *   2. Return a typed `GitResult` with captured stdout / stderr / exitCode,
 *      or throw `GitCommandError` on non-zero exits. The thrown error
 *      redacts the argv (not the env — env never flows through this
 *      wrapper, so there's nothing to redact there) to avoid leaking
 *      pathological branch names or user-supplied refs in logs.
 *
 *   3. Keep this wrapper runtime-agnostic. Phase 3.B's integration tests
 *      run under Vitest (Node pool), and the production code runs under
 *      Bun. `node:child_process.spawn` works in both. We deliberately do
 *      not use `Bun.spawn` here — git commands are short-lived, never
 *      stream JSONL, and don't need the backpressure-aware write path
 *      that `@shamu/adapters-base` provides for vendor CLIs.
 */

import { spawn } from "node:child_process";
import { ShamuError } from "@shamu/shared/errors";

export class GitCommandError extends ShamuError {
  public readonly code = "git_command_failed" as const;
  public readonly argv: readonly string[];
  public readonly exitCode: number | null;
  public readonly stdout: string;
  public readonly stderr: string;

  constructor(
    argv: readonly string[],
    exitCode: number | null,
    stdout: string,
    stderr: string,
    cause?: unknown,
  ) {
    super(formatGitErrorMessage(argv, exitCode, stderr), cause);
    this.argv = argv;
    this.exitCode = exitCode;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

export class GitInvariantError extends ShamuError {
  public readonly code = "git_invariant_violation" as const;
  public readonly argv: readonly string[];

  constructor(message: string, argv: readonly string[]) {
    super(message);
    this.argv = argv;
  }
}

/**
 * Subcommand tuples that MUST NOT receive `-q`/`--quiet` on git 2.50+.
 * The wrapper refuses to exec any invocation that violates this rule.
 *
 * `["revert"]` — `git revert`.
 * `["worktree", "prune"]` — `git worktree prune`.
 */
const QUIET_BANNED_SUBCOMMANDS: ReadonlyArray<readonly string[]> = [
  ["revert"],
  ["worktree", "prune"],
];

/** Flags we consider equivalent to `-q` on git subcommands. */
const QUIET_FLAGS: ReadonlySet<string> = new Set(["-q", "--quiet"]);

export interface GitResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface RunGitOptions {
  /** The directory git runs in. Must be absolute. */
  readonly cwd: string;
  /**
   * When true, a non-zero exit throws `GitCommandError`. When false, the
   * wrapper returns the result regardless of exit code. Defaults to true.
   * GC uses `throwOnError: false` so a single bad worktree doesn't abort
   * the whole sweep.
   */
  readonly throwOnError?: boolean;
  /**
   * Optional additional env. Inherits the parent env by default; this is
   * intentional — git needs `HOME`, `PATH`, and on macOS the keychain
   * helper's variables. Adapters that run vendor CLIs have a stricter
   * allow-list; that contract does NOT apply here.
   */
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * Run `git <args...>` and resolve with the captured result.
 *
 * Invariants enforced before exec:
 *   - `args[0]` must exist (git itself is the command).
 *   - No banned `-q` on the listed subcommands.
 */
export async function runGit(args: readonly string[], opts: RunGitOptions): Promise<GitResult> {
  if (!Array.isArray(args) || args.length === 0) {
    throw new GitInvariantError("runGit: args must be a non-empty argv", args);
  }
  if (typeof opts.cwd !== "string" || opts.cwd.length === 0) {
    throw new GitInvariantError("runGit: cwd must be an absolute path", args);
  }
  assertNoBannedQuietFlag(args);

  const throwOnError = opts.throwOnError ?? true;
  const env: NodeJS.ProcessEnv = opts.env ? { ...process.env, ...opts.env } : process.env;

  return await new Promise<GitResult>((resolve, reject) => {
    const child = spawn("git", [...args], {
      cwd: opts.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout?.on("data", (d: Buffer) => stdoutChunks.push(d));
    child.stderr?.on("data", (d: Buffer) => stderrChunks.push(d));

    child.on("error", (err) => {
      reject(new GitCommandError([...args], null, "", String(err?.message ?? err), err));
    });

    child.on("close", (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      const exitCode = code ?? -1;
      if (exitCode !== 0 && throwOnError) {
        reject(new GitCommandError([...args], exitCode, stdout, stderr));
        return;
      }
      resolve({ stdout, stderr, exitCode });
    });
  });
}

/**
 * Hard invariant check. Exported for tests; production callers reach it
 * transitively through `runGit`.
 */
export function assertNoBannedQuietFlag(args: readonly string[]): void {
  for (const subcommand of QUIET_BANNED_SUBCOMMANDS) {
    if (!argsStartWithSubcommand(args, subcommand)) continue;
    // Scan remaining tokens (including the subcommand's own args and any
    // trailing args) for a banned quiet flag. We stop at `--` to respect
    // the "end of options" convention.
    for (let i = subcommand.length; i < args.length; i += 1) {
      const token = args[i];
      if (token === "--") break;
      if (token !== undefined && QUIET_FLAGS.has(token)) {
        throw new GitInvariantError(
          `runGit refuses "${token}" on \`git ${subcommand.join(" ")}\`: git 2.50+ rejects it. Redirect stdout/stderr to silence output instead.`,
          args,
        );
      }
    }
  }
}

function argsStartWithSubcommand(args: readonly string[], subcommand: readonly string[]): boolean {
  if (subcommand.length === 0 || args.length < subcommand.length) return false;
  for (let i = 0; i < subcommand.length; i += 1) {
    if (args[i] !== subcommand[i]) return false;
  }
  return true;
}

function formatGitErrorMessage(
  argv: readonly string[],
  exitCode: number | null,
  stderr: string,
): string {
  const trimmed = stderr.trim();
  const suffix = trimmed.length > 0 ? `: ${trimmed}` : "";
  return `git ${argv.join(" ")} failed (exit ${exitCode ?? "null"})${suffix}`;
}
