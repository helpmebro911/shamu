/**
 * Two workers coordinating via mailbox — composition-level E2E.
 *
 * Closes the Phase 3-deferred exit "two real workers in parallel
 * worktrees coordinate via the mailbox end-to-end." Uses
 * `@shamu/adapter-echo` (not a real vendor CLI) so the test is
 * hermetic; the mailbox + leases + worktrees are all real.
 *
 * Flow:
 *   1. Scratch git repo + SQLite DB (via `@shamu/persistence`).
 *   2. `createWorktree` for two runs (A and B).
 *   3. Each run spawns an `EchoAdapter` handle pinned to its worktree
 *      path (via `SpawnOpts.cwd`) — proves the adapter accepts an
 *      orchestrator-minted runId and can be driven in parallel.
 *   4. Each worker acquires a lease on a disjoint glob via
 *      `@shamu/mailbox`.
 *   5. Each worker writes a file in its worktree, commits on its
 *      `shamu/<run-id>` branch (the pre-commit hook is not installed
 *      in this test — the `@shamu/worktree` hook install path is a
 *      separate primitive with its own tests).
 *   6. Each worker whispers a "done" message; the other worker reads
 *      the message via `read()`.
 *   7. Releases both leases.
 *   8. Merges both run branches into a shamu/integration/<swarm>
 *      branch — clean merge (different files → git three-way merges
 *      without conflict).
 *   9. Asserts: mailbox rows exist with the correct from_agent; both
 *      run branches are merged; both files exist on integration.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { EchoAdapter } from "@shamu/adapter-echo";
import type { AgentHandle } from "@shamu/adapters-base";
import {
  type AuthContext,
  acquireLease,
  read as readMailbox,
  releaseLease,
  whisper,
} from "@shamu/mailbox";
import { openDatabase, type ShamuDatabase } from "@shamu/persistence";
import { newRunId, newSwarmId } from "@shamu/shared/ids";
import { createWorktree, destroyWorktree, type WorktreeHandle } from "@shamu/worktree";
import { createSpikeRepo, runCmd, type TempRepo, writeAt } from "./support.ts";

describe("two workers coordinate via mailbox (E2E)", () => {
  let repo: TempRepo;
  let db: ShamuDatabase;
  let dbDir: string;

  beforeEach(async () => {
    repo = await createSpikeRepo("shamu-two-workers-");
    // Keep the DB in its own dir so `createSpikeRepo`'s cleanup
    // doesn't race against the DB close.
    dbDir = `${repo.path}.db`;
    await runCmd("mkdir", ["-p", dbDir], "/");
    db = openDatabase(join(dbDir, "db.sqlite"));
  });

  afterEach(() => {
    db.close();
    rmSync(dbDir, { recursive: true, force: true });
    repo.cleanup();
  });

  it("two echo-adapter workers in parallel worktrees commit + talk + merge", async () => {
    const swarmId = newSwarmId();
    const runIdA = newRunId();
    const runIdB = newRunId();

    // --- Worktree lifecycle -------------------------------------------------
    const wtA = await createWorktree({
      repoRoot: repo.path,
      runId: runIdA,
      baseBranch: "main",
    });
    const wtB = await createWorktree({
      repoRoot: repo.path,
      runId: runIdB,
      baseBranch: "main",
    });
    expect(existsSync(wtA.path)).toBe(true);
    expect(existsSync(wtB.path)).toBe(true);

    // --- Spawn echo adapters pinned to each worktree ------------------------
    const adapter = new EchoAdapter();
    const handleA = await adapter.spawn({ runId: runIdA, cwd: wtA.path });
    const handleB = await adapter.spawn({ runId: runIdB, cwd: wtB.path });
    expect(handleA.runId).toBe(runIdA);
    expect(handleB.runId).toBe(runIdB);

    // Drive each handle through one turn so we've observed real
    // orchestrator → adapter event flow before the coordination step.
    await handleA.send({ text: "A: hello" });
    await handleB.send({ text: "B: hello" });
    // Drain the first turn to completion on both so subsequent shutdown
    // doesn't race against a pending turn_end.
    await drainOneTurn(handleA);
    await drainOneTurn(handleB);

    // --- Mailbox: leases on disjoint globs ----------------------------------
    const ctxA: AuthContext = { agent: "worker-a", swarmId, runId: runIdA };
    const ctxB: AuthContext = { agent: "worker-b", swarmId, runId: runIdB };

    const leaseA = acquireLease(db, ctxA, {
      glob: "src/foo.ts",
      ttlMs: 60_000,
      worktreePath: wtA.path,
    });
    const leaseB = acquireLease(db, ctxB, {
      glob: "src/bar.ts",
      ttlMs: 60_000,
      worktreePath: wtB.path,
    });
    expect(leaseA.agent).toBe("worker-a");
    expect(leaseB.agent).toBe("worker-b");

    // --- Each worker writes within its leased glob and commits -------------
    writeAt(wtA.path, "src/foo.ts", "// worker-a wrote this\n");
    writeAt(wtB.path, "src/bar.ts", "// worker-b wrote this\n");
    await runCmd("git", ["add", "src/foo.ts"], wtA.path);
    await runCmd("git", ["commit", "-m", "A writes foo"], wtA.path);
    await runCmd("git", ["add", "src/bar.ts"], wtB.path);
    await runCmd("git", ["commit", "-m", "B writes bar"], wtB.path);

    // --- Mailbox: A whispers to B; B whispers to A -------------------------
    const aMsgToB = whisper(db, ctxA, "worker-b", "foo is ready");
    const bMsgToA = whisper(db, ctxB, "worker-a", "bar is ready");

    expect(aMsgToB.fromAgent).toBe("worker-a");
    expect(aMsgToB.toAgent).toBe("worker-b");
    expect(bMsgToA.fromAgent).toBe("worker-b");
    expect(bMsgToA.toAgent).toBe("worker-a");

    const aInbox = readMailbox(db, ctxA, { unreadOnly: true });
    const bInbox = readMailbox(db, ctxB, { unreadOnly: true });
    expect(aInbox.map((m) => m.body)).toContain("bar is ready");
    expect(bInbox.map((m) => m.body)).toContain("foo is ready");

    // --- Release leases (clean hand-off) -----------------------------------
    releaseLease(db, ctxA, leaseA.leaseId);
    releaseLease(db, ctxB, leaseB.leaseId);

    // --- Integration merge: both run branches merge cleanly ----------------
    await runCmd("git", ["branch", "shamu/integration/e2e"], repo.path);
    await runCmd("git", ["checkout", "shamu/integration/e2e"], repo.path);
    await runCmd("git", ["merge", "--no-ff", "--no-edit", `shamu/${runIdA}`], repo.path);
    await runCmd("git", ["merge", "--no-ff", "--no-edit", `shamu/${runIdB}`], repo.path);

    // Both files should be present on the integration branch.
    expect(existsSync(join(repo.path, "src/foo.ts"))).toBe(true);
    expect(existsSync(join(repo.path, "src/bar.ts"))).toBe(true);
    await runCmd("git", ["checkout", "main"], repo.path);

    // --- Teardown ----------------------------------------------------------
    await handleA.shutdown("done");
    await handleB.shutdown("done");
    await cleanupWorktrees([wtA, wtB]);
  });
});

/**
 * Drain events from an AgentHandle until one `turn_end` has been
 * observed. Echo adapters always close the turn on a `send()`, so
 * this resolves promptly (milliseconds).
 */
async function drainOneTurn(handle: AgentHandle): Promise<void> {
  for await (const ev of handle.events) {
    if (ev.kind === "turn_end") return;
  }
}

async function cleanupWorktrees(handles: readonly WorktreeHandle[]): Promise<void> {
  for (const h of handles) {
    try {
      await destroyWorktree(h, { force: true });
    } catch {
      rmSync(h.path, { recursive: true, force: true });
    }
  }
}
