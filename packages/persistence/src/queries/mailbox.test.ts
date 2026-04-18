import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newSwarmId } from "@shamu/shared/ids";
import { openDatabase, type ShamuDatabase } from "../db.ts";
import { insertMessage, listInbox, markRead } from "./mailbox.ts";

describe("mailbox queries", () => {
  let dir: string;
  let db: ShamuDatabase;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "shamu-mailbox-"));
    db = openDatabase(join(dir, "db.sqlite"));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("inserts and lists messages to an agent", () => {
    const swarmId = newSwarmId();
    insertMessage(db, {
      swarmId,
      fromAgent: "planner",
      toAgent: "executor",
      body: "plz fix bug",
      deliveredAt: 1000,
    });
    insertMessage(db, {
      swarmId,
      fromAgent: "reviewer",
      toAgent: "executor",
      body: "nit",
      deliveredAt: 2000,
    });
    const rows = listInbox(db, "executor");
    expect(rows).toHaveLength(2);
    // Newest first
    expect(rows[0]?.fromAgent).toBe("reviewer");
    expect(rows[1]?.fromAgent).toBe("planner");
  });

  it("markRead + unreadOnly filter", () => {
    const swarmId = newSwarmId();
    const a = insertMessage(db, {
      swarmId,
      fromAgent: "planner",
      toAgent: "executor",
      body: "one",
      deliveredAt: 1,
    });
    insertMessage(db, {
      swarmId,
      fromAgent: "reviewer",
      toAgent: "executor",
      body: "two",
      deliveredAt: 2,
    });
    markRead(db, a.msgId, 100);

    const unread = listInbox(db, "executor", { unreadOnly: true });
    expect(unread).toHaveLength(1);
    expect(unread[0]?.body).toBe("two");

    const all = listInbox(db, "executor");
    expect(all).toHaveLength(2);
  });

  it("returns empty inbox for unknown agent", () => {
    expect(listInbox(db, "nobody")).toHaveLength(0);
  });
});
