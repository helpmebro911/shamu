/**
 * Unit tests for the pure pieces of `gate.ts`.
 *
 * The actual spawn path (`runGate`) is not exercised here — that would
 * require a live agent-ci binary + Docker. A live-only test gated on
 * `SHAMU_CI_LIVE` lives further down and is skipped by default, mirroring
 * the `SHAMU_FLOW_LIVE` pattern in `packages/flows/plan-execute-review`.
 */

import { describe, expect, it, vi } from "vitest";
import {
  buildAllowlistedEnv,
  DEFAULT_ENV_ALLOWLIST,
  diffRunDirs,
  GateBootError,
  parseOriginToGithubRepo,
  runGate,
} from "../src/index.ts";

describe("parseOriginToGithubRepo", () => {
  it("parses https URLs with and without .git suffix", () => {
    expect(parseOriginToGithubRepo("https://github.com/watzon/shamu.git")).toBe("watzon/shamu");
    expect(parseOriginToGithubRepo("https://github.com/watzon/shamu")).toBe("watzon/shamu");
  });

  it("parses SSH shorthand", () => {
    expect(parseOriginToGithubRepo("git@github.com:watzon/shamu.git")).toBe("watzon/shamu");
    expect(parseOriginToGithubRepo("git@github.com:watzon/shamu")).toBe("watzon/shamu");
  });

  it("parses ssh:// URLs", () => {
    expect(parseOriginToGithubRepo("ssh://git@github.com/watzon/shamu.git")).toBe("watzon/shamu");
  });

  it("returns null for non-GitHub URLs", () => {
    expect(parseOriginToGithubRepo("https://gitlab.com/foo/bar.git")).toBeNull();
    expect(parseOriginToGithubRepo("")).toBeNull();
    expect(parseOriginToGithubRepo("not a url")).toBeNull();
  });

  it("trims whitespace from the input", () => {
    expect(parseOriginToGithubRepo("  https://github.com/a/b.git  \n")).toBe("a/b");
  });
});

describe("buildAllowlistedEnv", () => {
  it("keeps only allow-listed keys from processEnv", () => {
    const source: Record<string, string | undefined> = {
      PATH: "/usr/bin",
      HOME: "/home/u",
      LANG: "en_US.UTF-8",
      USER: "alice",
      SECRET_TOKEN: "should-be-dropped",
      ANTHROPIC_API_KEY: "also-dropped",
    };
    const out = buildAllowlistedEnv(source, { GITHUB_REPO: "watzon/shamu" });
    expect(out.PATH).toBe("/usr/bin");
    expect(out.HOME).toBe("/home/u");
    expect(out.LANG).toBe("en_US.UTF-8");
    expect(out.USER).toBe("alice");
    expect(out.SECRET_TOKEN).toBeUndefined();
    expect(out.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("forwards explicit caller-supplied keys including AGENT_CI_* and GITHUB_TOKEN", () => {
    const out = buildAllowlistedEnv(
      {},
      {
        GITHUB_REPO: "watzon/shamu",
        GITHUB_TOKEN: "ghp_forwarded",
        AGENT_CI_WORK_DIR: "/tmp/work",
      },
    );
    expect(out.GITHUB_TOKEN).toBe("ghp_forwarded");
    expect(out.AGENT_CI_WORK_DIR).toBe("/tmp/work");
  });

  it("sets AI_AGENT=1 unconditionally", () => {
    const out = buildAllowlistedEnv({}, { GITHUB_REPO: "a/b" });
    expect(out.AI_AGENT).toBe("1");
  });

  it("throws if GITHUB_REPO is missing or empty", () => {
    expect(() => buildAllowlistedEnv({}, {})).toThrow(GateBootError);
    expect(() => buildAllowlistedEnv({}, { GITHUB_REPO: "" })).toThrow(GateBootError);
  });

  it("undefined in forwarded deletes an allow-listed default", () => {
    const out = buildAllowlistedEnv(
      { PATH: "/usr/bin", LANG: "C" },
      { GITHUB_REPO: "a/b", LANG: undefined },
    );
    expect(out.PATH).toBe("/usr/bin");
    expect(out.LANG).toBeUndefined();
  });

  it("caller-supplied value wins over allow-listed default", () => {
    const out = buildAllowlistedEnv(
      { PATH: "/usr/bin" },
      { GITHUB_REPO: "a/b", PATH: "/caller/path" },
    );
    expect(out.PATH).toBe("/caller/path");
  });

  it("default allow-list covers exactly the expected keys", () => {
    expect(DEFAULT_ENV_ALLOWLIST).toEqual(["PATH", "HOME", "LANG", "USER"]);
  });
});

describe("diffRunDirs", () => {
  it("identifies a single new run directory", () => {
    const before = new Set(["run-1", "run-2"]);
    const after = new Set(["run-1", "run-2", "run-3"]);
    expect(diffRunDirs(before, after)).toBe("run-3");
  });

  it("returns the highest-sorted name when multiple new dirs appear", () => {
    const before = new Set<string>();
    const after = new Set(["run-100", "run-200", "run-150"]);
    // Lexical sort over `run-<timestamp>` — higher timestamp suffix wins.
    expect(diffRunDirs(before, after)).toBe("run-200");
  });

  it("returns null when nothing new appeared", () => {
    const before = new Set(["run-1"]);
    const after = new Set(["run-1"]);
    expect(diffRunDirs(before, after)).toBeNull();
  });

  it("ignores non run- entries", () => {
    const before = new Set<string>();
    const after = new Set(["tmp-foo", "run-42", "other"]);
    expect(diffRunDirs(before, after)).toBe("run-42");
  });

  it("handles iterable inputs (e.g. Array-backed after)", () => {
    expect(diffRunDirs(new Set(), ["run-7", "run-3"])).toBe("run-7");
  });
});

const LIVE = process.env.SHAMU_CI_LIVE === "1";

describe.skipIf(!LIVE)("runGate — live (SHAMU_CI_LIVE=1)", () => {
  it("spawns agent-ci against this repo and returns a parsed summary", async () => {
    const result = await runGate({
      cwd: process.cwd(),
      excerpt: { maxTokens: 500 },
    });
    expect(result.exitCode).toBeTypeOf("number");
    if (result.summary) {
      expect(["green", "red", "unknown"]).toContain(result.summary.status);
    }
  }, 120_000);
});

describe("runGate — smoke", () => {
  it("throws GateBootError when no GITHUB_REPO is discoverable", async () => {
    // Force the resolver to see no env + no git origin by pointing cwd at /
    // and clearing env. The error fires before any Bun.spawn.
    const prev = process.env.GITHUB_REPO;
    delete process.env.GITHUB_REPO;
    try {
      // We stub Bun.spawn only if present; this test runs under Vitest where
      // Bun is undefined, and runGate throws at the top of the function.
      await expect(
        runGate({
          cwd: "/",
          env: { GITHUB_REPO: undefined },
        }),
      ).rejects.toBeInstanceOf(GateBootError);
    } finally {
      if (prev !== undefined) process.env.GITHUB_REPO = prev;
    }
  });
});

// Silence vi import warning when LIVE mode is off.
void vi;
