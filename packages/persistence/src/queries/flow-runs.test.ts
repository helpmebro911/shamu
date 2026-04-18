import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newWorkflowRunId } from "@shamu/shared/ids";
import { openDatabase, type ShamuDatabase } from "../db.ts";
import {
  getFlowRun,
  insertFlowRun,
  listFlowRunsByStatus,
  updateFlowRunState,
} from "./flow-runs.ts";

describe("flow-runs queries", () => {
  let dir: string;
  let db: ShamuDatabase;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "shamu-flow-runs-"));
    db = openDatabase(join(dir, "db.sqlite"));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips a flow run", () => {
    const id = newWorkflowRunId();
    insertFlowRun(db, {
      flowRunId: id,
      flowId: "plan-execute-review",
      dagVersion: 1,
      status: "running",
      stateJson: JSON.stringify({ hello: "world" }),
      startedAt: 1_700_000_000_000,
    });
    const row = getFlowRun(db, id);
    expect(row).not.toBeNull();
    expect(row?.flowRunId).toBe(id);
    expect(row?.flowId).toBe("plan-execute-review");
    expect(row?.dagVersion).toBe(1);
    expect(row?.status).toBe("running");
    expect(row?.stateJson).toBe(JSON.stringify({ hello: "world" }));
    expect(row?.startedAt).toBe(1_700_000_000_000);
    expect(row?.resumedFrom).toBeNull();
  });

  it("returns null for missing flow runs", () => {
    expect(getFlowRun(db, newWorkflowRunId())).toBeNull();
  });

  it("persists resumed_from when supplied", () => {
    const prior = newWorkflowRunId();
    const current = newWorkflowRunId();
    insertFlowRun(db, {
      flowRunId: current,
      flowId: "f",
      dagVersion: 1,
      status: "running",
      stateJson: "{}",
      resumedFrom: prior,
      startedAt: 1,
    });
    const row = getFlowRun(db, current);
    expect(row?.resumedFrom).toBe(prior);
  });

  it("updates status + state + updatedAt", () => {
    const id = newWorkflowRunId();
    insertFlowRun(db, {
      flowRunId: id,
      flowId: "f",
      dagVersion: 1,
      status: "running",
      stateJson: "{}",
      startedAt: 1,
    });
    updateFlowRunState(db, id, "succeeded", JSON.stringify({ done: true }), 2_000);
    const row = getFlowRun(db, id);
    expect(row?.status).toBe("succeeded");
    expect(row?.stateJson).toBe(JSON.stringify({ done: true }));
    expect(row?.updatedAt).toBe(2_000);
  });

  it("lists flow runs by status ordered by started_at descending", () => {
    const a = newWorkflowRunId();
    const b = newWorkflowRunId();
    const c = newWorkflowRunId();
    insertFlowRun(db, {
      flowRunId: a,
      flowId: "f",
      dagVersion: 1,
      status: "running",
      stateJson: "{}",
      startedAt: 1,
    });
    insertFlowRun(db, {
      flowRunId: b,
      flowId: "f",
      dagVersion: 1,
      status: "running",
      stateJson: "{}",
      startedAt: 3,
    });
    insertFlowRun(db, {
      flowRunId: c,
      flowId: "f",
      dagVersion: 1,
      status: "paused",
      stateJson: "{}",
      startedAt: 2,
    });
    const running = listFlowRunsByStatus(db, "running");
    expect(running).toHaveLength(2);
    expect(running[0]?.flowRunId).toBe(b);
    expect(running[1]?.flowRunId).toBe(a);
    const paused = listFlowRunsByStatus(db, "paused");
    expect(paused).toHaveLength(1);
    expect(paused[0]?.flowRunId).toBe(c);
  });
});
