/**
 * `validatePathInWorktree` — path-scope gate.
 *
 * Per PLAN.md § Security (G4): the adapter's permission handler MUST reject
 * every filesystem tool-call path that (a) resolves outside the run's git
 * worktree, (b) uses `..` to escape, or (c) follows a symlink out. This gate
 * runs BEFORE the tool executes; the pre-commit hook is defense in depth,
 * not the primary control.
 *
 * Edge cases the implementation has to get right:
 *
 * 1. **Missing intermediate dirs.** A write to `.../worktree/new/dir/file.ts`
 *    must succeed even if `new/` doesn't exist yet — the tool is allowed to
 *    create parents inside the worktree. We realpath the deepest *existing*
 *    ancestor, then append the unresolved suffix, and check the result.
 * 2. **Symlinks.** A symlink whose target resolves outside the worktree
 *    (even if the link itself lives inside) is rejected. We `realpath` the
 *    deepest existing ancestor, which transparently resolves symlinks.
 * 3. **Worktree root itself is a symlink.** If the *root* is a symlink we
 *    resolve it once at call time; both the candidate and the root are
 *    compared in their resolved form, so they match correctly.
 * 4. **Case sensitivity.** Not normalized. On case-insensitive filesystems
 *    (macOS HFS+, default APFS) `foo` and `FOO` are the same path, and
 *    realpath returns the canonical casing; we trust that. We do not
 *    downcase manually, because on case-sensitive Linux that would produce
 *    false accepts.
 * 5. **Trailing slashes + `./`.** Normalized away by `node:path.resolve`.
 * 6. **Windows drive letters / UNC paths.** Not in scope — PLAN declares
 *    macOS + Linux first-class. If a Windows port happens, `path.win32` will
 *    need an auditable branch here.
 */

import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { err, ok, type Result } from "@shamu/shared/result";
import { PathScopeError } from "./errors.ts";

export type { PathScopeError };

/**
 * Returned on success — the absolute, symlink-resolved path of the candidate.
 * Callers should use this path (not the caller-supplied one) when dispatching
 * to the filesystem, so the FS op and the validation see the same bytes.
 */
export type AbsPath = string & { readonly __brand: "AbsPath" };

export interface ValidatePathInWorktreeOptions {
  /**
   * Treat the worktree root itself as a valid destination (return `AbsPath`
   * for an exact-match candidate). Default: true. Most callers want this —
   * a tool that `Read`s the worktree root directory is fine.
   */
  readonly acceptWorktreeRoot?: boolean;
}

/**
 * Resolve the deepest existing ancestor of `abs` so we can `realpath` it.
 *
 * Walks up until `existsSync` returns true, then realpaths that segment,
 * then tacks the unresolved suffix back on. The suffix uses `/` because
 * we've already normalized via `node:path.resolve`, which emits the host
 * separator; on Linux/macOS that's `/`. On Windows (not supported) this
 * would need to swap.
 */
function realpathOfDeepestExistingAncestor(abs: string): string {
  let cursor = abs;
  const parts: string[] = [];
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) {
      // Reached the filesystem root with no existing ancestor. Should never
      // happen on a sane host (the root always exists), but guard anyway.
      return abs;
    }
    parts.unshift(cursor.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
    cursor = parent;
  }
  const resolvedBase = realpathSync(cursor);
  if (parts.length === 0) return resolvedBase;
  return `${resolvedBase}${sep}${parts.join(sep)}`;
}

/**
 * Return true iff `candidate` is identical to `root` or lives under it.
 * Compares after both have been symlink-resolved.
 */
function isUnder(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  const rootWithSep = root.endsWith(sep) ? root : `${root}${sep}`;
  return candidate.startsWith(rootWithSep);
}

/**
 * Validate `candidate` against `worktreeRoot`. Returns an `AbsPath` on
 * success and a `PathScopeError` describing the specific violation on
 * failure.
 *
 * `worktreeRoot` SHOULD be absolute. If it isn't, we reject with
 * `worktree_root_invalid` — requiring callers to be explicit about the root
 * prevents a whole class of bugs where a relative worktree happens to
 * resolve past the intended ancestor.
 */
export function validatePathInWorktree(
  worktreeRoot: string,
  candidate: string,
  opts: ValidatePathInWorktreeOptions = {},
): Result<AbsPath, PathScopeError> {
  if (typeof worktreeRoot !== "string" || !isAbsolute(worktreeRoot)) {
    return err(new PathScopeError("worktree_root_invalid", candidate, worktreeRoot));
  }
  if (typeof candidate !== "string" || candidate.length === 0) {
    return err(new PathScopeError("not_under_worktree", candidate, worktreeRoot));
  }

  // Resolve the root via realpath so we compare like-for-like with candidate.
  let resolvedRoot: string;
  try {
    resolvedRoot = existsSync(worktreeRoot) ? realpathSync(worktreeRoot) : resolve(worktreeRoot);
  } catch (cause) {
    return err(new PathScopeError("worktree_root_invalid", candidate, worktreeRoot, cause));
  }

  // Resolve the candidate relative to the worktree unless it's already
  // absolute. `path.resolve` normalizes `..` and `.` segments — so
  // "/root/../etc" becomes "/etc", at which point the isUnder check will
  // reject. But we also want to distinguish the three specific violation
  // reasons so the error message is useful, so we pre-classify.

  const hadAbsoluteInput = isAbsolute(candidate);
  const preResolved = hadAbsoluteInput ? resolve(candidate) : resolve(resolvedRoot, candidate);

  // Classify the failure reason BEFORE symlink resolution so "absolute
  // outside worktree" and "`..` escape" are distinguishable in the error.
  if (hadAbsoluteInput && !isUnder(resolvedRoot, preResolved)) {
    return err(new PathScopeError("absolute_outside_worktree", candidate, resolvedRoot));
  }
  if (!hadAbsoluteInput && !isUnder(resolvedRoot, preResolved)) {
    return err(new PathScopeError("parent_traversal_escapes_worktree", candidate, resolvedRoot));
  }

  // Now resolve symlinks for any existing portion of the path. If the
  // deepest-existing-ancestor resolves outside the root, it's a symlink
  // escape. We do this AFTER the lexical check so symlink-free attacks
  // show the right reason.
  let finalPath: string;
  try {
    finalPath = realpathOfDeepestExistingAncestor(preResolved);
  } catch (cause) {
    return err(new PathScopeError("not_under_worktree", candidate, resolvedRoot, cause));
  }

  if (!isUnder(resolvedRoot, finalPath)) {
    return err(new PathScopeError("symlink_escapes_worktree", candidate, resolvedRoot));
  }

  if (finalPath === resolvedRoot && opts.acceptWorktreeRoot === false) {
    return err(new PathScopeError("not_under_worktree", candidate, resolvedRoot));
  }

  return ok(finalPath as AbsPath);
}
