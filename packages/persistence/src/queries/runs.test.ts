import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newRunId, newSwarmId } from "@shamu/shared/ids";
import { openDatabase, type ShamuDatabase } from "../db.ts";
import { getRun, insertRun, listRuns, updateRunStatus } from "./runs.ts";

describe("runs queries", () => {
  let dir: string;
  let db: ShamuDatabase;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "shamu-runs-"));
    db = openDatabase(join(dir, "db.sqlite"));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips a run", () => {
    const runId = newRunId();
    const swarmId = newSwarmId();
    insertRun(db, {
      runId,
      swarmId,
      role: "executor",
      vendor: "claude",
      status: "pending",
      createdAt: 1_700_000_000_000,
    });
    const row = getRun(db, runId);
    expect(row).not.toBeNull();
    expect(row?.status).toBe("pending");
    expect(row?.swarmId).toBe(swarmId);
    expect(row?.vendor).toBe("claude");
  });

  it("returns null for missing runs", () => {
    expect(getRun(db, newRunId())).toBeNull();
  });

  it("updates status and updatedAt", () => {
    const runId = newRunId();
    insertRun(db, { runId, status: "pending", createdAt: 1000 });
    updateRunStatus(db, runId, "running", 2000);
    const row = getRun(db, runId);
    expect(row?.status).toBe("running");
    expect(row?.updatedAt).toBe(2000);
  });

  it("lists runs by status", () => {
    insertRun(db, { runId: newRunId(), status: "pending", createdAt: 1 });
    insertRun(db, { runId: newRunId(), status: "running", createdAt: 2 });
    insertRun(db, { runId: newRunId(), status: "running", createdAt: 3 });
    expect(listRuns(db)).toHaveLength(3);
    expect(listRuns(db, "running")).toHaveLength(2);
    expect(listRuns(db, "completed")).toHaveLength(0);
  });
});
