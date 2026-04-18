/**
 * `installPreCommitHook` — install the lease-aware pre-commit hook.
 *
 * Phase 3.B plants the skeleton; Phase 3.C (`@shamu/mailbox`) replaces
 * the checker script path with the real leases binary. The skeleton is
 * deliberately minimal:
 *
 *   #!/usr/bin/env bash
 *   exec "<leaseCheckerScript>" "$@"
 *
 * …executed with the hook's stdin forwarded. That hands off the
 * commit-allow / commit-block decision to whatever Phase 3.C ships, with
 * zero hook-rewrite churn when the checker's argv shape changes.
 *
 * Worktree-local vs repo-shared hooks
 * -----------------------------------
 * Git's default behavior is to share hooks across all worktrees via
 * `GIT_COMMON_DIR/hooks/`. Placing a pre-commit there would affect the
 * primary and every secondary — not what Shamu wants for per-run
 * isolation.
 *
 * Per-worktree admin-dir hooks (`GIT_DIR/hooks/` for a secondary
 * worktree) are NOT consulted by git 2.50; we verified empirically that
 * hooks planted there are silently ignored.
 *
 * The only reliable per-worktree hook mechanism git supports is
 * `core.hooksPath`. Setting it on the worktree (with
 * `extensions.worktreeConfig = true` on the shared repo so the setting
 * is scoped to this worktree only) redirects that worktree's hook
 * lookups to the specified directory. We install to
 * `GIT_DIR/shamu-hooks/` and point `core.hooksPath` at it — leaving the
 * shared `GIT_COMMON_DIR/hooks/` untouched.
 *
 * On the primary worktree (where `GIT_DIR == GIT_COMMON_DIR`), the same
 * mechanism applies, but because the primary isn't typically a Shamu
 * sandbox, callers rarely install there. We support it symmetrically so
 * tests don't need a special case.
 *
 * File mode is unconditionally `0o755`. We overwrite any existing hook
 * (no merging) because Shamu owns the hook semantics for runs it created.
 */

import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import { ShamuError } from "@shamu/shared/errors";
import { runGit } from "./git.ts";
import type { HookOptions, InstalledHook } from "./types.ts";

export class HookInstallError extends ShamuError {
  public readonly code = "hook_install_failed" as const;
}

const HOOK_MODE = 0o755;

/** Subdirectory name under GIT_DIR where Shamu installs its per-worktree hooks. */
const SHAMU_HOOKS_SUBDIR = "shamu-hooks";

export async function installPreCommitHook(
  worktreePath: string,
  opts: HookOptions,
): Promise<InstalledHook> {
  if (typeof worktreePath !== "string" || worktreePath.length === 0) {
    throw new HookInstallError("installPreCommitHook: worktreePath must be a non-empty string");
  }
  if (typeof opts.leaseCheckerScript !== "string" || opts.leaseCheckerScript.length === 0) {
    throw new HookInstallError("installPreCommitHook: leaseCheckerScript must be a non-empty path");
  }

  const gitDir = await resolveGitDir(worktreePath);
  const hooksDir = pathResolve(gitDir, SHAMU_HOOKS_SUBDIR);
  const hookPath = pathResolve(hooksDir, "pre-commit");

  if (!existsSync(hooksDir)) {
    mkdirSync(hooksDir, { recursive: true });
  }

  const script = renderHookScript(opts.leaseCheckerScript);
  writeFileSync(hookPath, script, { encoding: "utf8" });
  chmodSync(hookPath, HOOK_MODE);

  // Enable per-worktree config + point this worktree's core.hooksPath at
  // our private dir. `extensions.worktreeConfig` must be on the shared
  // config; `core.hooksPath` is set with `--worktree` so it doesn't leak
  // to siblings. Both are idempotent — rerunning installPreCommitHook
  // just reaffirms the same values.
  await runGit(["config", "extensions.worktreeConfig", "true"], { cwd: worktreePath });
  await runGit(["config", "--worktree", "core.hooksPath", hooksDir], { cwd: worktreePath });

  return { path: hookPath, mode: HOOK_MODE };
}

/**
 * Resolve the worktree's `GIT_DIR` — the admin directory that houses
 * per-worktree state. For a secondary worktree this is
 * `<common>/.git/worktrees/<name>/`; for the primary it is `<repo>/.git/`.
 * We use `git rev-parse --git-dir` which is stable across every git
 * version we care about.
 */
async function resolveGitDir(worktreePath: string): Promise<string> {
  let gitDir: string;
  try {
    const res = await runGit(["rev-parse", "--git-dir"], { cwd: worktreePath });
    gitDir = res.stdout.trim();
  } catch (err) {
    throw new HookInstallError(
      `failed to resolve GIT_DIR via git in ${worktreePath}: ${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }

  if (gitDir.length === 0) {
    throw new HookInstallError(`git rev-parse --git-dir returned empty output in ${worktreePath}`);
  }

  // For the primary, git typically returns the relative `.git`; for a
  // secondary it returns an absolute admin-dir path. Normalize against
  // the worktree cwd.
  return pathResolve(worktreePath, gitDir);
}

/**
 * Render the pre-commit hook script. Exported for tests so they can
 * compare byte-for-byte.
 *
 * We shell-quote the checker path by wrapping in double quotes and
 * escaping `"` and `\` — enough for any path that can exist on a POSIX
 * filesystem. The hook forwards argv (`$@`) unchanged; Phase 3.C's
 * checker receives whatever git passes to `pre-commit`, which is nothing
 * today but may grow (see `githooks(5)`).
 */
export function renderHookScript(leaseCheckerScript: string): string {
  const escaped = leaseCheckerScript.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const lines = [
    "#!/usr/bin/env bash",
    "# Installed by @shamu/worktree.installPreCommitHook",
    "# Phase 3.B: execs the lease-checker supplied by Phase 3.C's @shamu/mailbox.",
    "# Do not edit by hand — reinstall via installPreCommitHook().",
    "set -eu",
    `exec "${escaped}" "$@"`,
    "",
  ];
  return lines.join("\n");
}

// Re-export so callers who only want the hook wiring don't need to
// separately import the options type.
export type { HookOptions, InstalledHook };
