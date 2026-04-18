import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newRunId, newSessionId } from "@shamu/shared/ids";
import { openDatabase, type ShamuDatabase } from "../db.ts";
import { insertRun } from "./runs.ts";
import {
  getSessionById,
  getSessionByRunId,
  insertSession,
  listSessionsForRun,
} from "./sessions.ts";

describe("sessions queries", () => {
  let dir: string;
  let db: ShamuDatabase;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "shamu-sessions-"));
    db = openDatabase(join(dir, "db.sqlite"));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips a session row", () => {
    const runId = newRunId();
    insertRun(db, { runId, vendor: "claude", status: "running", createdAt: 1_000 });
    const sessionId = newSessionId();
    insertSession(db, { sessionId, runId, vendor: "claude", createdAt: 2_000 });

    const fetched = getSessionByRunId(db, runId);
    expect(fetched).not.toBeNull();
    expect(fetched?.sessionId).toBe(sessionId);
    expect(fetched?.runId).toBe(runId);
    expect(fetched?.vendor).toBe("claude");
    expect(fetched?.createdAt).toBe(2_000);
  });

  it("returns null when the run has no session yet", () => {
    const runId = newRunId();
    insertRun(db, { runId, status: "running", createdAt: 1 });
    expect(getSessionByRunId(db, runId)).toBeNull();
  });

  it("getSessionById returns null for missing ids", () => {
    expect(getSessionById(db, newSessionId())).toBeNull();
  });

  it("getSessionByRunId returns the latest session (ORDER BY created_at DESC)", () => {
    const runId = newRunId();
    insertRun(db, { runId, vendor: "codex", status: "running", createdAt: 1 });

    const first = newSessionId();
    const second = newSessionId();
    const third = newSessionId();
    // Insert out-of-order to prove the query orders by created_at, not rowid.
    insertSession(db, { sessionId: second, runId, vendor: "codex", createdAt: 2_000 });
    insertSession(db, { sessionId: first, runId, vendor: "codex", createdAt: 1_000 });
    insertSession(db, { sessionId: third, runId, vendor: "codex", createdAt: 3_000 });

    expect(getSessionByRunId(db, runId)?.sessionId).toBe(third);
  });

  it("listSessionsForRun returns chronological order", () => {
    const runId = newRunId();
    insertRun(db, { runId, vendor: "claude", status: "running", createdAt: 1 });

    const a = newSessionId();
    const b = newSessionId();
    const c = newSessionId();
    insertSession(db, { sessionId: b, runId, vendor: "claude", createdAt: 200 });
    insertSession(db, { sessionId: a, runId, vendor: "claude", createdAt: 100 });
    insertSession(db, { sessionId: c, runId, vendor: "claude", createdAt: 300 });

    const rows = listSessionsForRun(db, runId);
    expect(rows.map((r) => r.sessionId)).toEqual([a, b, c]);
  });

  it("INSERT OR IGNORE lets the same session id recur without erroring", () => {
    const runId = newRunId();
    insertRun(db, { runId, vendor: "claude", status: "running", createdAt: 1 });
    const sessionId = newSessionId();

    insertSession(db, { sessionId, runId, vendor: "claude", createdAt: 10 });
    // Second insert with same session_id must be a no-op (resume can re-
    // announce the same vendor id under a new run).
    insertSession(db, { sessionId, runId, vendor: "claude", createdAt: 20 });

    expect(listSessionsForRun(db, runId)).toHaveLength(1);
    // The original timestamp is preserved because the second insert is
    // ignored rather than overwriting.
    expect(getSessionById(db, sessionId)?.createdAt).toBe(10);
  });

  it("enforces the foreign key to runs(run_id)", () => {
    // FK enforcement is only active when `PRAGMA foreign_keys=ON`. The
    // canonical `openDatabase` turns it on (see db.ts); insertSession against
    // a run id that doesn't exist should raise.
    const orphanRun = newRunId();
    expect(() => {
      insertSession(db, {
        sessionId: newSessionId(),
        runId: orphanRun,
        vendor: "claude",
        createdAt: 1,
      });
    }).toThrow();
  });
});
