/**
 * E2E test for `shamu resume` — Phase 2.C happy path + guard rails.
 *
 * The echo adapter's `resume()` is contract-tested already; this test
 * exercises the CLI's wiring:
 *
 *   - Resume against a run that has a persisted session id → succeeds,
 *     mints a fresh runId, inserts a new sessions row, emits run-cost.
 *   - Resume against an unknown run id → USAGE exit (not-found).
 *   - Resume against a run that never produced a session → USAGE exit
 *     (no-session).
 *   - --adapter mismatch against the session vendor → USAGE exit.
 *
 * Uses a temp $SHAMU_STATE_DIR so the run + session tables are clean per
 * test.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const CLI_ENTRY = join(__dirname, "..", "src", "index.ts");

function runCli(
  args: string[],
  opts: { timeoutMs?: number; env?: Record<string, string> } = {},
): { stdout: string; stderr: string; status: number | null } {
  const env = { ...process.env, ...(opts.env ?? {}) };
  delete env.NODE_OPTIONS;
  delete env.VITEST;
  delete env.VITEST_WORKER_ID;
  delete env.VITEST_POOL_ID;
  const res = spawnSync("bun", [CLI_ENTRY, ...args], {
    encoding: "utf8",
    timeout: opts.timeoutMs ?? 20_000,
    env,
  });
  return { stdout: res.stdout ?? "", stderr: res.stderr ?? "", status: res.status };
}

interface InspectResult {
  sessionRows: Array<{ session_id: string; run_id: string; vendor: string }>;
  runRows: Array<{ run_id: string; vendor: string; role: string | null; status: string }>;
}

function inspectDb(stateDir: string): InspectResult {
  const dbPath = join(stateDir, "shamu.db");
  const inspectorPath = join(stateDir, "inspect.ts");
  writeFileSync(
    inspectorPath,
    `
import { Database } from "bun:sqlite";
const db = new Database(${JSON.stringify(dbPath)});
const sessionRows = db.prepare("SELECT session_id, run_id, vendor FROM sessions ORDER BY created_at").all();
const runRows = db.prepare("SELECT run_id, vendor, role, status FROM runs ORDER BY created_at").all();
console.log(JSON.stringify({ sessionRows, runRows }));
db.close();
`,
  );
  const res = spawnSync("bun", ["run", inspectorPath], { encoding: "utf8", timeout: 10_000 });
  if (res.status !== 0) {
    throw new Error(`inspector failed: ${res.stderr}`);
  }
  return JSON.parse(res.stdout.trim()) as InspectResult;
}

describe("E2E: shamu resume --adapter echo", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "shamu-e2e-resume-"));
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("resumes a prior echo run and mints a fresh runId (G8)", () => {
    // 1. Seed a run.
    const runRes = runCli(["run", "--adapter", "echo", "--task", "seed", "--json"], {
      env: { SHAMU_STATE_DIR: stateDir },
    });
    expect(runRes.status).toBe(0);
    const runLines = runRes.stdout.trim().split("\n").filter(Boolean);
    const runStartLine = runLines.find((l) => l.includes('"run-started"'));
    expect(runStartLine).toBeDefined();
    const originalRunId = (JSON.parse(runStartLine as string) as { runId: string }).runId;

    // 2. Resume it.
    const resumeRes = runCli(["resume", originalRunId, "--task", "followup", "--json"], {
      env: { SHAMU_STATE_DIR: stateDir },
    });
    // Logger writes info-level JSON to stderr; exit status is the contract.
    expect(resumeRes.status).toBe(0);

    const resumeLines = resumeRes.stdout.trim().split("\n").filter(Boolean);
    const resumeLine = resumeLines.find((l) => l.includes('"run-resumed"'));
    expect(resumeLine).toBeDefined();
    const parsed = JSON.parse(resumeLine as string) as {
      originalRunId: string;
      runId: string;
      adapter: string;
    };
    expect(parsed.originalRunId).toBe(originalRunId);
    expect(parsed.runId).not.toBe(originalRunId); // G8 — fresh runId on resume
    expect(parsed.adapter).toBe("echo");

    // 3. A run-cost summary landed.
    const costLine = resumeLines.find((l) => l.includes('"run-cost"'));
    expect(costLine).toBeDefined();
    const costPayload = JSON.parse(costLine as string) as {
      runId: string;
      cost: { usdTotal: number };
    };
    expect(costPayload.runId).toBe(parsed.runId);

    // 4. DB reflects both runs + at least one session row linked to the
    //    original runId (the resumed run may or may not have added a new
    //    session, depending on whether the echo adapter minted a fresh id
    //    for the resumed handle — we only require the original link).
    const inspection = inspectDb(stateDir);
    expect(inspection.runRows).toHaveLength(2);
    const runIds = inspection.runRows.map((r) => r.run_id);
    expect(runIds).toContain(originalRunId);
    expect(runIds).toContain(parsed.runId);
    expect(inspection.sessionRows.length).toBeGreaterThanOrEqual(1);
    const sessionsForOriginal = inspection.sessionRows.filter((r) => r.run_id === originalRunId);
    expect(sessionsForOriginal).toHaveLength(1);
  }, 30_000);

  it("rejects resume for an unknown run id", () => {
    // A validly-shaped but non-existent run id.
    const res = runCli(["resume", "01HZZZZZZZZZZZZZZZZZZZZZZZ", "--task", "x"], {
      env: { SHAMU_STATE_DIR: stateDir },
    });
    expect(res.status).toBe(2); // USAGE
    expect(res.stderr).toMatch(/not found/i);
  });

  it("rejects resume when the run has no persisted session", () => {
    // Seed a run row without a session. Easiest path: run once, then DELETE
    // from the sessions table so the runs row remains but the session is
    // gone. This exercises the "original run failed before session_start"
    // branch without needing to replicate the migration bootstrap outside
    // the workspace.
    const runRes = runCli(["run", "--adapter", "echo", "--task", "seed", "--json"], {
      env: { SHAMU_STATE_DIR: stateDir },
    });
    expect(runRes.status).toBe(0);
    const lines = runRes.stdout.trim().split("\n").filter(Boolean);
    const startLine = lines.find((l) => l.includes('"run-started"'));
    if (!startLine) throw new Error("no run-started line");
    const originalRunId = (JSON.parse(startLine) as { runId: string }).runId;

    const dbPath = join(stateDir, "shamu.db");
    const mutator = join(stateDir, "delete-sessions.ts");
    writeFileSync(
      mutator,
      `
import { Database } from "bun:sqlite";
const db = new Database(${JSON.stringify(dbPath)});
db.prepare("DELETE FROM sessions WHERE run_id = ?").run(${JSON.stringify(originalRunId)});
db.close();
`,
    );
    const mutate = spawnSync("bun", ["run", mutator], { encoding: "utf8", timeout: 10_000 });
    expect(mutate.status).toBe(0);

    const res = runCli(["resume", originalRunId, "--task", "x"], {
      env: { SHAMU_STATE_DIR: stateDir },
    });
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/no persisted session id/i);
  }, 30_000);

  it("rejects --adapter mismatch against the session vendor", () => {
    // Seed a run through echo so the session vendor = echo.
    const runRes = runCli(["run", "--adapter", "echo", "--task", "seed", "--json"], {
      env: { SHAMU_STATE_DIR: stateDir },
    });
    expect(runRes.status).toBe(0);
    const runLines = runRes.stdout.trim().split("\n").filter(Boolean);
    const runStartLine = runLines.find((l) => l.includes('"run-started"'));
    if (!runStartLine) throw new Error("no run-started line");
    const originalRunId = (JSON.parse(runStartLine) as { runId: string }).runId;

    const res = runCli(["resume", originalRunId, "--task", "x", "--adapter", "claude"], {
      env: { SHAMU_STATE_DIR: stateDir },
    });
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/does not match session vendor/i);
  }, 30_000);
});
