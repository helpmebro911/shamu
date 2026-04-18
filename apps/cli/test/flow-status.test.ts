/**
 * Tests for `shamu flow status`. Seeds a flow_runs row via a bun
 * subprocess (vitest can't load bun:sqlite directly), then invokes the
 * CLI and asserts on human + --json output.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const CLI_ENTRY = join(__dirname, "..", "src", "index.ts");

interface RunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number | null;
}

function runCli(args: string[], env: Record<string, string>): RunResult {
  const childEnv = { ...process.env, ...env };
  delete childEnv.NODE_OPTIONS;
  delete childEnv.VITEST;
  delete childEnv.VITEST_WORKER_ID;
  delete childEnv.VITEST_POOL_ID;
  const res = spawnSync("bun", [CLI_ENTRY, ...args], {
    encoding: "utf8",
    timeout: 15_000,
    env: childEnv,
  });
  return { stdout: res.stdout ?? "", stderr: res.stderr ?? "", status: res.status };
}

/** Seed a flow_runs row with a canned state. Uses a bun script. */
function seedFlowRun(
  stateDir: string,
  params: {
    readonly flowRunId: string;
    readonly flowId: string;
    readonly dagVersion: number;
    readonly status: string;
    readonly stateJson: string;
  },
): void {
  const dbPath = join(stateDir, "shamu.db");
  const script = `
import { openDatabase } from "${join(__dirname, "..", "..", "..", "packages", "persistence", "src", "db.ts")}";
import { insertFlowRun } from "${join(__dirname, "..", "..", "..", "packages", "persistence", "src", "queries", "flow-runs.ts")}";
import { workflowRunId } from "${join(__dirname, "..", "..", "..", "packages", "shared", "src", "ids.ts")}";
const db = openDatabase(${JSON.stringify(dbPath)});
insertFlowRun(db, {
  flowRunId: workflowRunId(${JSON.stringify(params.flowRunId)}),
  flowId: ${JSON.stringify(params.flowId)},
  dagVersion: ${params.dagVersion},
  status: ${JSON.stringify(params.status)},
  stateJson: ${JSON.stringify(params.stateJson)},
  resumedFrom: null,
  startedAt: 1700000000000,
});
db.close();
  `;
  const seeder = join(stateDir, "seed.ts");
  writeFileSync(seeder, script);
  const res = spawnSync("bun", [seeder], { encoding: "utf8", timeout: 10_000 });
  if ((res.status ?? -1) !== 0) {
    throw new Error(`seedFlowRun failed: ${res.stderr}`);
  }
}

describe("shamu flow status", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "shamu-flow-status-"));
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  const SEED_ID = "01K0TESTSTATUS0000000000";
  const SEED_STATE_JSON = JSON.stringify({
    flowRunId: SEED_ID,
    flowId: "tiny-flow",
    version: 1,
    entry: "start",
    nodeStatus: { start: "succeeded", end: "succeeded" },
    nodeOutputs: {},
    pendingGate: null,
    startedAt: 1700000000000,
    updatedAt: 1700000001000,
    totalCostUsd: 0.42,
    costSamples: [
      { usd: 0.2, confidence: "estimate", source: "tiny-flow" },
      { usd: 0.22, confidence: "estimate", source: "tiny-flow" },
    ],
  });

  it("emits a human-readable summary when the row exists", () => {
    seedFlowRun(stateDir, {
      flowRunId: SEED_ID,
      flowId: "tiny-flow",
      dagVersion: 1,
      status: "succeeded",
      stateJson: SEED_STATE_JSON,
    });
    const r = runCli(["flow", "status", SEED_ID], { SHAMU_STATE_DIR: stateDir });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(SEED_ID);
    expect(r.stdout).toContain("succeeded");
    expect(r.stdout).toContain("start");
    expect(r.stdout).toContain("end");
    expect(r.stdout).toContain("totalCostUsd=0.42");
  });

  it("emits a full JSON payload under --json", () => {
    seedFlowRun(stateDir, {
      flowRunId: SEED_ID,
      flowId: "tiny-flow",
      dagVersion: 1,
      status: "succeeded",
      stateJson: SEED_STATE_JSON,
    });
    const r = runCli(["flow", "status", SEED_ID, "--json"], { SHAMU_STATE_DIR: stateDir });
    expect(r.status).toBe(0);
    const lines = r.stdout.trim().split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const payload = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(payload.kind).toBe("flow-status");
    expect(payload.flowRunId).toBe(SEED_ID);
    expect(payload.status).toBe("succeeded");
    const state = payload.state as Record<string, unknown>;
    expect(state.totalCostUsd).toBe(0.42);
    const nodeStatus = state.nodeStatus as Record<string, string>;
    expect(nodeStatus.start).toBe("succeeded");
  });

  it("exits USAGE (2) when the id is unknown", () => {
    const r = runCli(["flow", "status", "01K0UNKNOWNFLOWRUN000000"], {
      SHAMU_STATE_DIR: stateDir,
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("not found");
  });

  it("under --json emits a structured not-found error when id is unknown", () => {
    const r = runCli(["flow", "status", "01K0UNKNOWNFLOWRUN000000", "--json"], {
      SHAMU_STATE_DIR: stateDir,
    });
    expect(r.status).toBe(2);
    const payload = JSON.parse(r.stdout.trim().split("\n")[0] as string) as Record<string, unknown>;
    expect(payload.category).toBe("not-found");
  });
});
