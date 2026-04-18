import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validatePathInWorktree } from "../src/path-scope.ts";

let worktree: string;
let outside: string;

beforeAll(() => {
  worktree = realpathSync(mkdtempSync(join(tmpdir(), "shamu-worktree-")));
  outside = realpathSync(mkdtempSync(join(tmpdir(), "shamu-outside-")));
  // Seed some existing structure inside the worktree.
  mkdirSync(join(worktree, "src"), { recursive: true });
  writeFileSync(join(worktree, "src", "a.ts"), "export {};");
  writeFileSync(join(outside, "secret.txt"), "secret");
});

afterAll(() => {
  rmSync(worktree, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

function mustOk(path: string): string {
  const r = validatePathInWorktree(worktree, path);
  if (!r.ok)
    throw new Error(`expected accept for ${path}; got ${r.error.reason} (${r.error.message})`);
  return r.value;
}

function mustFail(path: string, reason: string): void {
  const r = validatePathInWorktree(worktree, path);
  if (r.ok) throw new Error(`expected reject for ${path}; got accept: ${r.value}`);
  expect(r.error.reason).toBe(reason);
}

describe("validatePathInWorktree — acceptance", () => {
  it("accepts relative paths inside the worktree", () => {
    const out = mustOk("src/a.ts");
    expect(out).toBe(join(worktree, "src", "a.ts"));
  });

  it("accepts absolute paths that resolve inside the worktree", () => {
    const out = mustOk(join(worktree, "src", "a.ts"));
    expect(out).toBe(join(worktree, "src", "a.ts"));
  });

  it("accepts paths to non-existent files inside the worktree", () => {
    const out = mustOk("src/new-file.ts");
    expect(out).toBe(join(worktree, "src", "new-file.ts"));
  });

  it("accepts paths whose parent directory does not yet exist", () => {
    const out = mustOk("src/new/deep/nested/file.ts");
    expect(out).toBe(join(worktree, "src", "new", "deep", "nested", "file.ts"));
  });

  it("accepts the worktree root itself by default", () => {
    const out = mustOk(worktree);
    expect(out).toBe(worktree);
  });

  it("rejects the worktree root when acceptWorktreeRoot=false", () => {
    const r = validatePathInWorktree(worktree, worktree, { acceptWorktreeRoot: false });
    if (r.ok) throw new Error("expected reject with acceptWorktreeRoot=false");
    expect(r.error.reason).toBe("not_under_worktree");
  });
});

describe("validatePathInWorktree — rejection", () => {
  it("rejects absolute paths outside the worktree", () => {
    mustFail("/etc/passwd", "absolute_outside_worktree");
    mustFail(join(outside, "secret.txt"), "absolute_outside_worktree");
  });

  it("rejects .. escapes", () => {
    mustFail("../../etc/passwd", "parent_traversal_escapes_worktree");
    mustFail("src/../../etc/passwd", "parent_traversal_escapes_worktree");
  });

  it("accepts harmless .. that stays inside the worktree", () => {
    const out = mustOk("src/../src/a.ts");
    expect(out).toBe(join(worktree, "src", "a.ts"));
  });

  it("rejects a symlink whose target is outside the worktree", () => {
    const linkPath = join(worktree, "escape-link");
    symlinkSync(outside, linkPath);
    try {
      mustFail("escape-link/secret.txt", "symlink_escapes_worktree");
      mustFail(join(worktree, "escape-link", "secret.txt"), "symlink_escapes_worktree");
    } finally {
      rmSync(linkPath, { force: true });
    }
  });

  it("rejects a non-absolute worktree root outright", () => {
    const r = validatePathInWorktree("relative/root", "foo.txt");
    if (r.ok) throw new Error("relative worktree root must be rejected");
    expect(r.error.reason).toBe("worktree_root_invalid");
  });

  it("rejects an empty candidate", () => {
    mustFail("", "not_under_worktree");
  });
});

describe("validatePathInWorktree — symlink root", () => {
  it("canonicalizes the worktree root via realpath", () => {
    // Build a symlink that points to `worktree`; validate a candidate
    // expressed through the symlink and verify it accepts.
    const aliasRoot = mkdtempSync(join(tmpdir(), "shamu-alias-"));
    const alias = join(aliasRoot, "wt");
    symlinkSync(worktree, alias);
    try {
      const r = validatePathInWorktree(alias, "src/a.ts");
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value).toBe(resolve(join(worktree, "src", "a.ts")));
      }
    } finally {
      rmSync(aliasRoot, { recursive: true, force: true });
    }
  });
});
