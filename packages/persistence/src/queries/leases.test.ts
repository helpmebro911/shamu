import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newLeaseId, newRunId, newSwarmId } from "@shamu/shared/ids";
import { openDatabase, type ShamuDatabase } from "../db.ts";
import { acquireLease, listActive, listStale, markStale, releaseLease } from "./leases.ts";

describe("leases queries", () => {
  let dir: string;
  let db: ShamuDatabase;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "shamu-leases-"));
    db = openDatabase(join(dir, "db.sqlite"));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function baseInput(overrides: Partial<Parameters<typeof acquireLease>[1]> = {}) {
    return {
      leaseId: newLeaseId(),
      swarmId: newSwarmId(),
      agent: "executor",
      holderRunId: newRunId(),
      holderWorktreePath: "/tmp/wt",
      glob: "src/**",
      acquiredAt: 1000,
      expiresAt: 2000,
      ...overrides,
    };
  }

  it("acquires and releases a lease", () => {
    const input = baseInput();
    acquireLease(db, input);
    expect(listActive(db, 1500)).toHaveLength(1);
    releaseLease(db, input.leaseId);
    expect(listActive(db, 1500)).toHaveLength(0);
  });

  it("separates active vs stale by now", () => {
    acquireLease(db, baseInput({ expiresAt: 1500 })); // stale by now=2000
    acquireLease(db, baseInput({ expiresAt: 3000 })); // active
    expect(listActive(db, 2000)).toHaveLength(1);
    expect(listStale(db, 2000)).toHaveLength(1);
  });

  it("markStale clamps expires_at", () => {
    const input = baseInput({ expiresAt: 5000 });
    acquireLease(db, input);
    expect(listActive(db, 2000)).toHaveLength(1);
    markStale(db, input.leaseId, 2000);
    expect(listActive(db, 2000)).toHaveLength(0);
    expect(listStale(db, 2000)).toHaveLength(1);
  });

  it("preserves holder_worktree_path for reclaim checks", () => {
    const input = baseInput({ holderWorktreePath: "/tmp/worktrees/r1" });
    acquireLease(db, input);
    const [row] = listActive(db, 1500);
    expect(row?.holderWorktreePath).toBe("/tmp/worktrees/r1");
  });
});
