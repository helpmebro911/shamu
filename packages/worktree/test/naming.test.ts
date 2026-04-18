import { runId as brandRunId, newRunId } from "@shamu/shared/ids";
import { describe, expect, it } from "vitest";
import {
  branchForRun,
  isShamuBranch,
  relativeWorktreePathForRun,
  runIdFromWorktreePath,
  WORKTREES_SUBDIR,
  worktreePathForRun,
} from "../src/naming.ts";

describe("naming", () => {
  const rid = brandRunId("01K0ABCDEFGHJKMNPQRSTVWXYZ");

  describe("branchForRun", () => {
    it("prefixes run id with shamu/", () => {
      expect(branchForRun(rid)).toBe("shamu/01K0ABCDEFGHJKMNPQRSTVWXYZ");
    });
  });

  describe("relativeWorktreePathForRun", () => {
    it("joins under .shamu/worktrees", () => {
      expect(relativeWorktreePathForRun(rid)).toBe(
        `${WORKTREES_SUBDIR}/01K0ABCDEFGHJKMNPQRSTVWXYZ`,
      );
    });
  });

  describe("worktreePathForRun", () => {
    it("returns absolute path anchored at repoRoot", () => {
      const p = worktreePathForRun("/tmp/repo", rid);
      expect(p).toBe("/tmp/repo/.shamu/worktrees/01K0ABCDEFGHJKMNPQRSTVWXYZ");
    });

    it("rejects empty repoRoot", () => {
      expect(() => worktreePathForRun("", rid)).toThrow(TypeError);
    });
  });

  describe("runIdFromWorktreePath", () => {
    it("round-trips the absolute form produced by worktreePathForRun", () => {
      const p = worktreePathForRun("/tmp/some-repo", rid);
      expect(runIdFromWorktreePath(p)).toBe(rid);
    });

    it("returns null for a foreign path", () => {
      expect(runIdFromWorktreePath("/tmp/plain-dir")).toBeNull();
    });

    it("returns null for a path that resembles the prefix but nests a subdir", () => {
      expect(runIdFromWorktreePath("/tmp/repo/.shamu/worktrees/foo/bar")).toBeNull();
    });

    it("returns null for empty input", () => {
      expect(runIdFromWorktreePath("")).toBeNull();
    });

    it("tolerates a trailing slash", () => {
      const p = `${worktreePathForRun("/tmp/repo", rid)}/`;
      expect(runIdFromWorktreePath(p)).toBe(rid);
    });

    it("returns null when the run-id slot is empty", () => {
      expect(runIdFromWorktreePath("/tmp/repo/.shamu/worktrees/")).toBeNull();
    });
  });

  describe("isShamuBranch", () => {
    it("accepts shamu/<rid>", () => {
      expect(isShamuBranch(branchForRun(newRunId()))).toBe(true);
    });

    it("rejects other branches", () => {
      expect(isShamuBranch("main")).toBe(false);
      expect(isShamuBranch("shamu/")).toBe(false);
      expect(isShamuBranch("feature/shamu/x")).toBe(false);
    });
  });
});
