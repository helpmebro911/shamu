import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type ShamuDatabase } from "@shamu/persistence/db";
import { newRunId, newSwarmId, type RunId, type SwarmId } from "@shamu/shared/ids";
import type { AuthContext } from "../src/auth.ts";
import type { EscalationEmitter, MailboxEscalationRaised } from "../src/escalation.ts";
import { acquireLease, reclaimIfStale } from "../src/leases.ts";

function ctxFor(agent: string, swarmId: SwarmId, runId: RunId): AuthContext {
  return { agent, swarmId, runId };
}

function makeCapturingEmitter(): {
  readonly emitter: EscalationEmitter;
  readonly events: MailboxEscalationRaised[];
} {
  const events: MailboxEscalationRaised[] = [];
  return {
    emitter: {
      emit(ev) {
        events.push(ev);
      },
    },
    events,
  };
}

/** Spin up a dedicated git repo in `path`, with a single initial commit. */
function initGitRepo(path: string): void {
  mkdirSync(path, { recursive: true });
  // Disable GPG signing / hooks for hermeticity; set a local identity so
  // commits don't fail on unconfigured author.
  execFileSync("git", ["init", "--quiet", "-b", "main"], { cwd: path });
  execFileSync("git", ["config", "user.email", "tests@shamu.local"], { cwd: path });
  execFileSync("git", ["config", "user.name", "Shamu Tests"], { cwd: path });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: path });
  writeFileSync(join(path, "README.md"), "seed\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: path });
  execFileSync("git", ["commit", "-m", "seed", "--no-gpg-sign", "--no-verify"], {
    cwd: path,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
  });
}

describe("reclaimIfStale", () => {
  let dir: string;
  let db: ShamuDatabase;
  let swarmId: SwarmId;
  let aliceRun: RunId;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "shamu-reclaim-"));
    db = openDatabase(join(dir, "db.sqlite"));
    swarmId = newSwarmId();
    aliceRun = newRunId();
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("reclaims a stale lease when holder worktree is clean inside the glob", async () => {
    const worktree = join(dir, "wt-clean");
    initGitRepo(worktree);
    mkdirSync(join(worktree, "src"), { recursive: true });
    writeFileSync(join(worktree, "src", "a.ts"), "export const a = 1;\n", "utf8");
    execFileSync("git", ["add", "src/a.ts"], { cwd: worktree });
    execFileSync("git", ["commit", "-m", "add a", "--no-gpg-sign", "--no-verify"], {
      cwd: worktree,
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
    });

    const alice = ctxFor("alice", swarmId, aliceRun);
    const row = acquireLease(db, alice, {
      glob: "src/**",
      ttlMs: 1_000,
      worktreePath: worktree,
      now: 1_000,
    });

    const { emitter, events } = makeCapturingEmitter();
    const result = await reclaimIfStale(db, alice, row.leaseId, {
      now: 5_000, // stale by 3 seconds
      emitter,
    });

    expect(result.reclaimed).toBe(true);
    expect(events).toHaveLength(0);

    // Lease row is gone.
    const raw = db.prepare("SELECT lease_id FROM leases WHERE lease_id = ?").get(row.leaseId) as
      | { lease_id: string }
      | null
      | undefined;
    expect(raw == null).toBe(true);
  });

  it("refuses to reclaim + escalates when holder worktree is dirty inside the glob", async () => {
    const worktree = join(dir, "wt-dirty");
    initGitRepo(worktree);
    mkdirSync(join(worktree, "src"), { recursive: true });
    // Untracked file inside the glob — `git status --porcelain ... -- src/**` sees it.
    writeFileSync(join(worktree, "src", "wip.ts"), "// half-done\n", "utf8");

    const alice = ctxFor("alice", swarmId, aliceRun);
    const row = acquireLease(db, alice, {
      glob: "src/**",
      ttlMs: 1_000,
      worktreePath: worktree,
      now: 1_000,
    });

    const { emitter, events } = makeCapturingEmitter();
    const result = await reclaimIfStale(db, alice, row.leaseId, {
      now: 5_000,
      emitter,
    });

    expect(result.reclaimed).toBe(false);
    if (result.reclaimed === false) {
      expect(result.reason).toBe("dirty_holder");
    }
    expect(events).toHaveLength(1);
    expect(events[0]?.cause).toBe("lease_reclaim_refused_dirty_holder");

    // Lease still present.
    const raw = db.prepare("SELECT lease_id FROM leases WHERE lease_id = ?").get(row.leaseId) as
      | { lease_id: string }
      | undefined;
    expect(raw?.lease_id).toBe(row.leaseId);
  });

  it("refuses + escalates when the holder worktree directory no longer exists", async () => {
    // Acquire with a path that we'll then delete.
    const doomedWorktree = join(dir, "wt-doomed");
    initGitRepo(doomedWorktree);

    const alice = ctxFor("alice", swarmId, aliceRun);
    const row = acquireLease(db, alice, {
      glob: "src/**",
      ttlMs: 1_000,
      worktreePath: doomedWorktree,
      now: 1_000,
    });

    // Remove the worktree entirely.
    rmSync(doomedWorktree, { recursive: true, force: true });

    const { emitter, events } = makeCapturingEmitter();
    const result = await reclaimIfStale(db, alice, row.leaseId, {
      now: 5_000,
      emitter,
    });

    expect(result.reclaimed).toBe(false);
    if (result.reclaimed === false) {
      expect(result.reason).toBe("holder_worktree_missing");
    }
    expect(events).toHaveLength(1);
    expect(events[0]?.cause).toBe("lease_reclaim_refused_holder_missing");

    // Lease still present.
    const raw = db.prepare("SELECT lease_id FROM leases WHERE lease_id = ?").get(row.leaseId) as
      | { lease_id: string }
      | undefined;
    expect(raw?.lease_id).toBe(row.leaseId);
  });

  it("returns lease_not_stale without escalation when lease is still live", async () => {
    const worktree = join(dir, "wt-live");
    initGitRepo(worktree);

    const alice = ctxFor("alice", swarmId, aliceRun);
    const row = acquireLease(db, alice, {
      glob: "src/**",
      ttlMs: 60_000,
      worktreePath: worktree,
      now: 1_000,
    });

    const { emitter, events } = makeCapturingEmitter();
    const result = await reclaimIfStale(db, alice, row.leaseId, {
      now: 5_000, // well before expiry
      emitter,
    });
    expect(result.reclaimed).toBe(false);
    if (result.reclaimed === false) {
      expect(result.reason).toBe("lease_not_stale");
    }
    expect(events).toHaveLength(0);
  });

  it("returns lease_not_found for an unknown lease id", async () => {
    const alice = ctxFor("alice", swarmId, aliceRun);
    const { emitter, events } = makeCapturingEmitter();
    const result = await reclaimIfStale(
      db,
      alice,
      "01JFAKE000000000000000000" as unknown as Parameters<typeof reclaimIfStale>[2],
      { now: 5_000, emitter },
    );
    expect(result.reclaimed).toBe(false);
    if (result.reclaimed === false) {
      expect(result.reason).toBe("lease_not_found");
    }
    expect(events).toHaveLength(0);
  });
});
