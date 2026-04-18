/**
 * Unit tests for the git wrapper's invariant guards.
 *
 * The most important property is that we NEVER pass `-q` to `git revert`
 * or `git worktree prune` — git 2.50 rejects the flag, so every invocation
 * from this package must be clean of it. We test this as a pre-flight
 * argv check (`assertNoBannedQuietFlag`) rather than by actually running
 * git, so the test is deterministic and runs with no subprocess latency.
 *
 * We also verify `runGit` rejects malformed invocations (empty argv, empty
 * cwd) before reaching the subprocess layer.
 */

import { describe, expect, it } from "vitest";
import { assertNoBannedQuietFlag, GitInvariantError, runGit } from "../src/git.ts";

describe("assertNoBannedQuietFlag", () => {
  it("passes on non-banned subcommands", () => {
    expect(() => assertNoBannedQuietFlag(["status", "-q"])).not.toThrow();
    expect(() => assertNoBannedQuietFlag(["worktree", "list", "--porcelain"])).not.toThrow();
    expect(() => assertNoBannedQuietFlag(["branch", "-D", "shamu/foo"])).not.toThrow();
  });

  it("rejects -q on `git revert`", () => {
    expect(() => assertNoBannedQuietFlag(["revert", "-q", "HEAD"])).toThrow(GitInvariantError);
    expect(() => assertNoBannedQuietFlag(["revert", "HEAD", "-q"])).toThrow(GitInvariantError);
  });

  it("rejects --quiet on `git revert`", () => {
    expect(() => assertNoBannedQuietFlag(["revert", "--quiet", "HEAD"])).toThrow(GitInvariantError);
  });

  it("rejects -q on `git worktree prune`", () => {
    expect(() => assertNoBannedQuietFlag(["worktree", "prune", "-q"])).toThrow(GitInvariantError);
    expect(() => assertNoBannedQuietFlag(["worktree", "prune", "--quiet"])).toThrow(
      GitInvariantError,
    );
  });

  it("allows -q on neighboring worktree subcommands (add, list, remove)", () => {
    expect(() => assertNoBannedQuietFlag(["worktree", "add", "-q", "path", "base"])).not.toThrow();
    expect(() => assertNoBannedQuietFlag(["worktree", "list", "-q"])).not.toThrow();
    expect(() => assertNoBannedQuietFlag(["worktree", "remove", "-q", "path"])).not.toThrow();
  });

  it("does not rummage past a `--` end-of-options marker", () => {
    // A literal filename called "-q" after `--` isn't a flag; the wrapper
    // must not false-positive on it.
    expect(() =>
      assertNoBannedQuietFlag(["revert", "HEAD", "--", "-q-a-file-named-dash-q"]),
    ).not.toThrow();
  });
});

describe("runGit guard rails", () => {
  it("throws GitInvariantError on empty argv", async () => {
    await expect(runGit([], { cwd: "/tmp" })).rejects.toBeInstanceOf(GitInvariantError);
  });

  it("throws GitInvariantError on empty cwd", async () => {
    await expect(runGit(["status"], { cwd: "" })).rejects.toBeInstanceOf(GitInvariantError);
  });

  it("throws GitInvariantError when the -q rule would be violated, BEFORE spawning git", async () => {
    // If this passed through to an actual spawn, we'd get a GitCommandError
    // instead; the GitInvariantError type is the assertion that we caught
    // it pre-flight.
    await expect(runGit(["revert", "-q", "HEAD"], { cwd: "/tmp" })).rejects.toBeInstanceOf(
      GitInvariantError,
    );
    await expect(runGit(["worktree", "prune", "-q"], { cwd: "/tmp" })).rejects.toBeInstanceOf(
      GitInvariantError,
    );
  });
});
