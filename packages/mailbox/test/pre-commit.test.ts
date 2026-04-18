import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type ShamuDatabase } from "@shamu/persistence/db";
import type { LeaseRow } from "@shamu/persistence/queries/leases";
import {
  leaseId as brandLeaseId,
  newRunId,
  newSwarmId,
  type RunId,
  type SwarmId,
} from "@shamu/shared/ids";
import type { AuthContext } from "../src/auth.ts";
import { acquireLease } from "../src/leases.ts";
import { checkStagedPaths, runPreCommitGuard } from "../src/pre-commit.ts";

function ctxFor(agent: string, swarmId: SwarmId, runId: RunId): AuthContext {
  return { agent, swarmId, runId };
}

function makeLease(agent: string, glob: string, overrides: Partial<LeaseRow> = {}): LeaseRow {
  return {
    leaseId: brandLeaseId(`lease-${agent}-${glob}`),
    swarmId: newSwarmId(),
    agent,
    holderRunId: newRunId(),
    holderWorktreePath: "/tmp/wt",
    glob,
    acquiredAt: 1_000,
    expiresAt: 60_000,
    ...overrides,
  };
}

describe("checkStagedPaths", () => {
  it("allows when every path is covered by an owned lease", () => {
    const leases = [makeLease("alice", "src/alice/**"), makeLease("alice", "docs/**")];
    const decision = checkStagedPaths({
      stagedPaths: ["src/alice/foo.ts", "docs/readme.md"],
      leases,
      agent: "alice",
    });
    expect(decision.allowed).toBe(true);
    expect(decision.blocked).toHaveLength(0);
  });

  it("blocks paths not covered by any owned lease", () => {
    const leases = [makeLease("alice", "src/alice/**")];
    const decision = checkStagedPaths({
      stagedPaths: ["src/alice/foo.ts", "src/bob/bar.ts"],
      leases,
      agent: "alice",
    });
    expect(decision.allowed).toBe(false);
    expect(decision.blocked).toEqual(["src/bob/bar.ts"]);
  });

  it("ignores leases held by another agent", () => {
    const leases = [
      makeLease("alice", "src/**"), // alice's lease
    ];
    const decision = checkStagedPaths({
      stagedPaths: ["src/foo.ts"],
      leases,
      agent: "bob", // bob trying to commit under alice's lease
    });
    expect(decision.allowed).toBe(false);
    expect(decision.blocked).toEqual(["src/foo.ts"]);
  });

  it("nothing staged = trivially allowed", () => {
    const decision = checkStagedPaths({
      stagedPaths: [],
      leases: [],
      agent: "alice",
    });
    expect(decision.allowed).toBe(true);
  });

  it("none-owned, everything blocked", () => {
    const decision = checkStagedPaths({
      stagedPaths: ["a.ts", "b.ts", "c.ts"],
      leases: [],
      agent: "alice",
    });
    expect(decision.allowed).toBe(false);
    expect(decision.blocked).toEqual(["a.ts", "b.ts", "c.ts"]);
  });
});

describe("runPreCommitGuard (with stubbed git)", () => {
  let dir: string;
  let db: ShamuDatabase;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "shamu-precommit-"));
    db = openDatabase(join(dir, "db.sqlite"));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("exit 0 when nothing staged", async () => {
    const result = await runPreCommitGuard({
      worktreePath: "/tmp/wt",
      agent: "alice",
      db,
      exec: async () => ({ stdout: "", stderr: "" }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.decision.allowed).toBe(true);
  });

  it("exit 0 when every staged path is covered", async () => {
    const swarmId = newSwarmId();
    const run = newRunId();
    const alice = ctxFor("alice", swarmId, run);
    acquireLease(db, alice, {
      glob: "src/**",
      ttlMs: 60_000,
      worktreePath: "/tmp/wt",
      now: 1_000,
    });

    const result = await runPreCommitGuard({
      worktreePath: "/tmp/wt",
      agent: "alice",
      db,
      now: 2_000,
      exec: async () => ({ stdout: "src/a.ts\nsrc/b.ts\n", stderr: "" }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.decision.allowed).toBe(true);
  });

  it("exit 1 when any staged path is not covered", async () => {
    const swarmId = newSwarmId();
    const run = newRunId();
    const alice = ctxFor("alice", swarmId, run);
    acquireLease(db, alice, {
      glob: "src/**",
      ttlMs: 60_000,
      worktreePath: "/tmp/wt",
      now: 1_000,
    });

    const result = await runPreCommitGuard({
      worktreePath: "/tmp/wt",
      agent: "alice",
      db,
      now: 2_000,
      exec: async () => ({ stdout: "src/a.ts\ntest/b.ts\n", stderr: "" }),
    });
    expect(result.exitCode).toBe(1);
    expect(result.decision.allowed).toBe(false);
    expect(result.decision.blocked).toEqual(["test/b.ts"]);
    expect(result.message).toContain("test/b.ts");
  });

  it("exit 2 when git exec fails", async () => {
    const result = await runPreCommitGuard({
      worktreePath: "/tmp/wt",
      agent: "alice",
      db,
      exec: async () => {
        throw new Error("git not found");
      },
    });
    expect(result.exitCode).toBe(2);
    expect(result.decision.allowed).toBe(false);
  });
});
