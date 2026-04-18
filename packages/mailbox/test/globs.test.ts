import { describe, expect, it } from "bun:test";
import { globMatchesPath, globsOverlap } from "../src/globs.ts";

describe("globsOverlap", () => {
  it("identical globs overlap", () => {
    expect(globsOverlap("src/**", "src/**")).toBe(true);
  });

  it("disjoint literal trees do not overlap", () => {
    expect(globsOverlap("src/**", "test/**")).toBe(false);
    expect(globsOverlap("a/b/c", "a/b/d")).toBe(false);
  });

  it("prefix under globstar overlaps subtree glob", () => {
    expect(globsOverlap("src/**", "src/components/**")).toBe(true);
    expect(globsOverlap("src/components/**", "src/**")).toBe(true);
  });

  it("single-segment `*` matches a concrete segment", () => {
    expect(globsOverlap("src/*.ts", "src/foo.ts")).toBe(true);
    expect(globsOverlap("src/*.ts", "test/foo.ts")).toBe(false);
  });

  it("patterned segments with incompatible literals do not overlap", () => {
    // `*.ts` vs `*.tsx` — no concrete filename ends in both suffixes.
    expect(globsOverlap("src/*.ts", "src/*.tsx")).toBe(false);
    // Different literal prefixes, both wildcard suffix — disjoint.
    expect(globsOverlap("src/foo*.ts", "src/bar*.ts")).toBe(false);
    // Same suffix wildcard-family — overlap (`foo.ts` matches both).
    expect(globsOverlap("src/*.ts", "src/foo.ts")).toBe(true);
  });

  it("globstar anywhere matches", () => {
    expect(globsOverlap("**", "a/b/c/d")).toBe(true);
    expect(globsOverlap("a/**/z", "a/b/c/z")).toBe(true);
    expect(globsOverlap("a/**/z", "a/b/c/y")).toBe(false);
  });

  it("zero-match globstar handles shorter-other case", () => {
    expect(globsOverlap("a/**/b", "a/b")).toBe(true);
  });
});

describe("globMatchesPath", () => {
  it("`**` matches any subtree", () => {
    expect(globMatchesPath("src/**", "src/foo.ts")).toBe(true);
    expect(globMatchesPath("src/**", "src/a/b/c.ts")).toBe(true);
    expect(globMatchesPath("src/**", "src")).toBe(true);
    expect(globMatchesPath("src/**", "test/foo.ts")).toBe(false);
  });

  it("per-segment `*` matches exactly one segment", () => {
    expect(globMatchesPath("src/*.ts", "src/foo.ts")).toBe(true);
    expect(globMatchesPath("src/*.ts", "src/a/foo.ts")).toBe(false);
  });

  it("literal paths match literally", () => {
    expect(globMatchesPath("a/b/c.ts", "a/b/c.ts")).toBe(true);
    expect(globMatchesPath("a/b/c.ts", "a/b/d.ts")).toBe(false);
  });
});
