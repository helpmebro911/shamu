/**
 * End-to-end smoke test for Phase 1.E.
 *
 * Spawns `shamu run --adapter echo --task "smoke"` as a subprocess using a
 * temp `$SHAMU_STATE_DIR`, then:
 *   - asserts exit code 0 and that the run emitted session_start +
 *     assistant_message + turn_end rows into the SQLite DB.
 *   - runs `shamu status` and asserts the run id appears.
 *   - runs `shamu logs <run-id> --json` and validates every line against
 *     `@shamu/shared/events`.
 * Cleanup removes the temp dir.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAgentEvent } from "@shamu/shared/events";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const CLI_ENTRY = join(__dirname, "..", "src", "index.ts");

let stateDir: string;

function runCli(
  args: string[],
  opts: { timeoutMs?: number; env?: Record<string, string> } = {},
): { stdout: string; stderr: string; status: number | null } {
  const env = { ...process.env, ...(opts.env ?? {}) };
  // Strip vitest-injected NODE_OPTIONS so the child is unperturbed.
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

beforeAll(() => {
  stateDir = mkdtempSync(join(tmpdir(), "shamu-e2e-"));
});

afterAll(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

describe("E2E: shamu run --adapter echo", () => {
  it("round-trips a scripted session through SQLite + CLI", () => {
    // 1. Run the CLI.
    const runRes = runCli(["run", "--adapter", "echo", "--task", "smoke", "--json"], {
      env: { SHAMU_STATE_DIR: stateDir },
    });
    expect(runRes.status).toBe(0);

    // 2. Parse stdout NDJSON; harvest the runId from the `run-started` event.
    const lines = runRes.stdout.trim().split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(3);
    const startLine = lines.find((l) => l.includes('"run-started"'));
    expect(startLine).toBeDefined();
    const startEvt = JSON.parse(startLine as string) as Record<string, unknown>;
    const runId = startEvt.runId;
    expect(typeof runId).toBe("string");

    // 3. Inspect the SQLite DB. `bun:sqlite` is only loadable under Bun,
    //    but vitest runs under Node here — so spawn a tiny bun subprocess
    //    that reads via `bun:sqlite` and prints the counts as JSON.
    const dbPath = join(stateDir, "shamu.db");
    const inspectorPath = join(stateDir, "inspect.ts");
    writeFileSync(
      inspectorPath,
      `
import { Database } from "bun:sqlite";
const db = new Database(${JSON.stringify(dbPath)});
const kinds = (db.prepare("SELECT kind FROM events WHERE run_id = ?").all(${JSON.stringify(runId)}) as Array<{ kind: string }>).map((r) => r.kind);
const rawCount = (db.prepare("SELECT COUNT(*) AS c FROM raw_events WHERE run_id = ?").get(${JSON.stringify(runId)}) as { c: number }).c;
const runRow = db.prepare("SELECT status, vendor FROM runs WHERE run_id = ?").get(${JSON.stringify(runId)});
console.log(JSON.stringify({ kinds, rawCount, runRow }));
db.close();
`,
    );
    const inspectRes = spawnSync("bun", ["run", inspectorPath], {
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(inspectRes.status).toBe(0);
    const inspection = JSON.parse(inspectRes.stdout.trim()) as {
      kinds: string[];
      rawCount: number;
      runRow: { status: string; vendor: string } | null;
    };
    expect(inspection.kinds).toContain("session_start");
    expect(inspection.kinds).toContain("assistant_message");
    expect(inspection.kinds).toContain("turn_end");
    expect(inspection.rawCount).toBeGreaterThan(0);
    expect(inspection.rawCount).toBe(inspection.kinds.length);
    expect(inspection.runRow).toBeTruthy();
    expect(inspection.runRow?.status).toBe("completed");
    expect(inspection.runRow?.vendor).toBe("echo");

    // 4. `shamu status` lists the run.
    const statusRes = runCli(["status"], { env: { SHAMU_STATE_DIR: stateDir } });
    expect(statusRes.status).toBe(0);
    expect(statusRes.stdout).toContain(runId as string);

    // 5. `shamu logs <run-id> --json` — every line validates against the
    //    shared AgentEvent schema.
    const logsRes = runCli(["logs", runId as string, "--json"], {
      env: { SHAMU_STATE_DIR: stateDir },
    });
    expect(logsRes.status).toBe(0);
    const logLines = logsRes.stdout.trim().split("\n").filter(Boolean);
    expect(logLines.length).toBeGreaterThan(3);
    for (const line of logLines) {
      const parsed = JSON.parse(line);
      // Throws if the schema rejects the payload.
      expect(() => parseAgentEvent(parsed)).not.toThrow();
    }
  });
});
