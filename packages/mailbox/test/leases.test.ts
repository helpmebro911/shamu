import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type ShamuDatabase } from "@shamu/persistence/db";
import { newRunId, newSwarmId, type RunId, type SwarmId } from "@shamu/shared/ids";
import type { AuthContext } from "../src/auth.ts";
import {
  acquireLease,
  LeaseConflictError,
  LeaseOwnershipError,
  listActive,
  releaseLease,
} from "../src/leases.ts";

function ctxFor(agent: string, swarmId: SwarmId, runId: RunId): AuthContext {
  return { agent, swarmId, runId };
}

describe("lease primitives", () => {
  let dir: string;
  let db: ShamuDatabase;
  let swarmId: SwarmId;
  let aliceRun: RunId;
  let bobRun: RunId;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "shamu-leases-prim-"));
    db = openDatabase(join(dir, "db.sqlite"));
    swarmId = newSwarmId();
    aliceRun = newRunId();
    bobRun = newRunId();
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("acquire + release happy path", () => {
    const alice = ctxFor("alice", swarmId, aliceRun);
    const row = acquireLease(db, alice, {
      glob: "src/alice/**",
      ttlMs: 60_000,
      worktreePath: "/tmp/wt-alice",
      now: 1_000,
    });
    expect(row.agent).toBe("alice");
    expect(row.holderRunId).toBe(aliceRun);
    expect(row.holderWorktreePath).toBe("/tmp/wt-alice");
    expect(row.glob).toBe("src/alice/**");
    expect(row.expiresAt).toBe(61_000);

    const live = listActive(db, alice, 2_000);
    expect(live).toHaveLength(1);
    expect(live[0]?.leaseId).toBe(row.leaseId);

    releaseLease(db, alice, row.leaseId);
    expect(listActive(db, alice, 2_000)).toHaveLength(0);
  });

  it("two runs racing on the same glob — one loses", () => {
    const alice = ctxFor("alice", swarmId, aliceRun);
    const bob = ctxFor("bob", swarmId, bobRun);

    acquireLease(db, alice, {
      glob: "src/shared/**",
      ttlMs: 60_000,
      worktreePath: "/tmp/wt-alice",
      now: 1_000,
    });

    expect(() =>
      acquireLease(db, bob, {
        glob: "src/shared/**",
        ttlMs: 60_000,
        worktreePath: "/tmp/wt-bob",
        now: 1_500,
      }),
    ).toThrow(LeaseConflictError);
  });

  it("overlapping (not identical) globs conflict", () => {
    const alice = ctxFor("alice", swarmId, aliceRun);
    const bob = ctxFor("bob", swarmId, bobRun);

    acquireLease(db, alice, {
      glob: "src/**",
      ttlMs: 60_000,
      worktreePath: "/tmp/wt-alice",
      now: 1_000,
    });

    expect(() =>
      acquireLease(db, bob, {
        glob: "src/components/**",
        ttlMs: 60_000,
        worktreePath: "/tmp/wt-bob",
        now: 1_500,
      }),
    ).toThrow(LeaseConflictError);
  });

  it("disjoint globs both succeed", () => {
    const alice = ctxFor("alice", swarmId, aliceRun);
    const bob = ctxFor("bob", swarmId, bobRun);

    acquireLease(db, alice, {
      glob: "src/alice/**",
      ttlMs: 60_000,
      worktreePath: "/tmp/wt-alice",
      now: 1_000,
    });
    acquireLease(db, bob, {
      glob: "src/bob/**",
      ttlMs: 60_000,
      worktreePath: "/tmp/wt-bob",
      now: 1_000,
    });

    expect(listActive(db, alice, 2_000)).toHaveLength(2);
  });

  it("releaseLease refuses to release another run's lease", () => {
    const alice = ctxFor("alice", swarmId, aliceRun);
    const bob = ctxFor("bob", swarmId, bobRun);

    const row = acquireLease(db, alice, {
      glob: "src/alice/**",
      ttlMs: 60_000,
      worktreePath: "/tmp/wt-alice",
      now: 1_000,
    });

    expect(() => releaseLease(db, bob, row.leaseId)).toThrow(LeaseOwnershipError);
    // Still present.
    expect(listActive(db, alice, 2_000)).toHaveLength(1);
  });

  it("releaseLease on unknown leaseId is a no-op", () => {
    const alice = ctxFor("alice", swarmId, aliceRun);
    expect(() =>
      releaseLease(
        db,
        alice,
        "01JFAKE000000000000000000" as unknown as Parameters<typeof releaseLease>[2],
      ),
    ).not.toThrow();
  });

  it("listActive scopes to ctx.swarmId", () => {
    const otherSwarm = newSwarmId();
    const alice = ctxFor("alice", swarmId, aliceRun);
    const stranger = ctxFor("stranger", otherSwarm, bobRun);

    acquireLease(db, alice, {
      glob: "src/a/**",
      ttlMs: 60_000,
      worktreePath: "/tmp/wt",
      now: 1_000,
    });
    acquireLease(db, stranger, {
      glob: "src/z/**",
      ttlMs: 60_000,
      worktreePath: "/tmp/wt",
      now: 1_000,
    });

    expect(listActive(db, alice, 2_000)).toHaveLength(1);
    expect(listActive(db, stranger, 2_000)).toHaveLength(1);
  });

  it("expired leases do not block new acquires on the same glob", () => {
    const alice = ctxFor("alice", swarmId, aliceRun);
    const bob = ctxFor("bob", swarmId, bobRun);

    acquireLease(db, alice, {
      glob: "src/**",
      ttlMs: 1_000,
      worktreePath: "/tmp/wt-alice",
      now: 1_000,
    });

    // now = 5_000: alice's lease is long-expired (expires at 2_000).
    const row = acquireLease(db, bob, {
      glob: "src/**",
      ttlMs: 60_000,
      worktreePath: "/tmp/wt-bob",
      now: 5_000,
    });
    expect(row.agent).toBe("bob");
  });
});
