import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type ShamuDatabase } from "@shamu/persistence/db";
import { newRunId, newSwarmId, type RunId, type SwarmId } from "@shamu/shared/ids";
import type { AuthContext } from "../src/auth.ts";
import { broadcast, MessageOwnershipError, markRead, read, whisper } from "../src/mailbox.ts";

function makeCtx(agent: string, swarmId: SwarmId, runId: RunId): AuthContext {
  return { agent, swarmId, runId };
}

describe("mailbox primitives", () => {
  let dir: string;
  let db: ShamuDatabase;
  let swarmId: SwarmId;
  let plannerRun: RunId;
  let executorRun: RunId;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "shamu-mailbox-prim-"));
    db = openDatabase(join(dir, "db.sqlite"));
    swarmId = newSwarmId();
    plannerRun = newRunId();
    executorRun = newRunId();
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("whisper writes from_agent from ctx.agent", () => {
    const ctx = makeCtx("planner", swarmId, plannerRun);
    const row = whisper(db, ctx, "executor", "plz fix bug");
    expect(row.fromAgent).toBe("planner");
    expect(row.toAgent).toBe("executor");
    expect(row.swarmId).toBe(swarmId);
    expect(row.body).toBe("plz fix bug");

    // Verify persisted column value.
    const raw = db.prepare("SELECT from_agent FROM mailbox WHERE msg_id = ?").get(row.msgId) as
      | { from_agent: string }
      | undefined;
    expect(raw?.from_agent).toBe("planner");
  });

  it("broadcast fans out one row per recipient, all with ctx.agent as from", () => {
    const ctx = makeCtx("planner", swarmId, plannerRun);
    const rows = broadcast(db, ctx, "standup", {
      toAgents: ["executor", "reviewer", "qa"],
    });
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.toAgent))).toEqual(new Set(["executor", "reviewer", "qa"]));
    expect(rows.every((r) => r.fromAgent === "planner")).toBe(true);
    expect(rows.every((r) => r.swarmId === swarmId)).toBe(true);
  });

  it("broadcast with empty recipient list is a no-op", () => {
    const ctx = makeCtx("planner", swarmId, plannerRun);
    const rows = broadcast(db, ctx, "anyone?", { toAgents: [] });
    expect(rows).toHaveLength(0);
  });

  it("read returns ctx.agent's inbox only", () => {
    const plannerCtx = makeCtx("planner", swarmId, plannerRun);
    const executorCtx = makeCtx("executor", swarmId, executorRun);

    whisper(db, plannerCtx, "executor", "one");
    whisper(db, plannerCtx, "executor", "two");
    whisper(db, executorCtx, "planner", "ack");

    const executorInbox = read(db, executorCtx);
    expect(executorInbox).toHaveLength(2);
    expect(executorInbox.every((r) => r.toAgent === "executor")).toBe(true);

    const plannerInbox = read(db, plannerCtx);
    expect(plannerInbox).toHaveLength(1);
    expect(plannerInbox[0]?.body).toBe("ack");
  });

  it("read { unreadOnly: true } filters read messages", () => {
    const plannerCtx = makeCtx("planner", swarmId, plannerRun);
    const executorCtx = makeCtx("executor", swarmId, executorRun);
    const first = whisper(db, plannerCtx, "executor", "one");
    whisper(db, plannerCtx, "executor", "two");

    markRead(db, executorCtx, first.msgId);
    const unread = read(db, executorCtx, { unreadOnly: true });
    expect(unread).toHaveLength(1);
    expect(unread[0]?.body).toBe("two");
  });

  it("markRead rejects a message not addressed to ctx.agent", () => {
    const plannerCtx = makeCtx("planner", swarmId, plannerRun);
    const executorCtx = makeCtx("executor", swarmId, executorRun);
    const row = whisper(db, plannerCtx, "executor", "hi");

    // Planner tries to mark executor's inbox-message as read.
    expect(() => markRead(db, plannerCtx, row.msgId)).toThrow(MessageOwnershipError);

    // Executor can.
    expect(() => markRead(db, executorCtx, row.msgId)).not.toThrow();
  });

  it("markRead on an unknown msg_id throws (no probing)", () => {
    const executorCtx = makeCtx("executor", swarmId, executorRun);
    expect(() => markRead(db, executorCtx, "01JFAKE000000000000000000")).toThrow(
      MessageOwnershipError,
    );
  });

  // G6 — from_agent forgery.
  //
  // The primitive signatures accept NO `from` parameter; the only way
  // into `from_agent` is `ctx.agent`. To simulate a forgery attempt we
  // would have to call the persistence layer directly — but this
  // package's public surface never exposes that call. The best we can
  // do at test-site is assert the DB column always equals `ctx.agent`
  // regardless of what the body contains.
  it("G6: from_agent always equals ctx.agent even if body looks like a forgery", () => {
    const ctx = makeCtx("planner", swarmId, plannerRun);
    const bodyTryingToForge = JSON.stringify({ fromAgent: "reviewer", from: "qa" });
    const row = whisper(db, ctx, "executor", bodyTryingToForge);
    expect(row.fromAgent).toBe("planner");
    const raw = db.prepare("SELECT from_agent FROM mailbox WHERE msg_id = ?").get(row.msgId) as
      | { from_agent: string }
      | undefined;
    expect(raw?.from_agent).toBe("planner");
  });
});
