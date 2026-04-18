/**
 * Tests for `shamu flow run`. We drive the CLI as a subprocess with the
 * tiny-flow fixture so the full spawn/parse/validate/execute/persist
 * path is exercised.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const CLI_ENTRY = join(__dirname, "..", "src", "index.ts");
const TINY_FLOW = join(__dirname, "fixtures", "tiny-flow.ts");

interface RunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number | null;
}

function runCli(
  args: string[],
  opts: { timeoutMs?: number; env?: Record<string, string> } = {},
): RunResult {
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

describe("shamu flow run", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "shamu-flow-run-"));
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("runs the tiny-flow happy path and exits 0 with a succeeded flow_runs row", () => {
    const r = runCli(["flow", "run", TINY_FLOW, "--task", "smoke"], {
      env: { SHAMU_STATE_DIR: stateDir },
    });
    expect(r.status).toBe(0);
    expect(r.stdout.toLowerCase()).toContain("succeeded");

    // Verify DB row via a bun:sqlite subprocess (vitest runs under Node
    // so we can't import bun:sqlite directly here).
    const dbPath = join(stateDir, "shamu.db");
    const row = inspectDb(stateDir, dbPath);
    expect(row.count).toBe(1);
    expect(row.status).toBe("succeeded");
    expect(row.flowId).toBe("tiny-flow");
  });

  it("emits well-formed NDJSON under --json with the expected event kinds in order", () => {
    const r = runCli(["flow", "run", TINY_FLOW, "--task", "smoke", "--json"], {
      env: { SHAMU_STATE_DIR: stateDir },
    });
    expect(r.status).toBe(0);

    const lines = r.stdout.trim().split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(3);

    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    // Filter to flow-bus events (the final line is the flow-run-summary).
    const busLines = parsed.filter(
      (p) => typeof p.kind === "string" && p.kind !== "flow-run-summary",
    );
    const kinds = busLines.map((p) => p.kind);
    // Expect flow_started first, flow_completed last, and node_started +
    // node_completed for both nodes in between.
    expect(kinds[0]).toBe("flow_started");
    expect(kinds.at(-1)).toBe("flow_completed");
    expect(kinds).toContain("node_started");
    expect(kinds).toContain("node_completed");
    // Every bus line carries { ts, flowRunId, payload } per the 4.C JSON
    // schema.
    for (const line of busLines) {
      expect(typeof line.ts).toBe("number");
      expect(typeof line.flowRunId).toBe("string");
      expect(typeof line.payload).toBe("object");
    }

    const summary = parsed.find((p) => p.kind === "flow-run-summary");
    expect(summary).toBeDefined();
    expect(summary?.status).toBe("succeeded");
  });

  it("flags a missing flowDefinition export with an actionable error", () => {
    // A module that has registerRunners but no flowDefinition.
    const broken = writeBrokenModule(
      stateDir,
      "no-def.ts",
      `
      export function registerRunners() {}
    `,
    );
    const r = runCli(["flow", "run", broken, "--task", "smoke"], {
      env: { SHAMU_STATE_DIR: stateDir },
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr.toLowerCase()).toContain("flow module");
    expect(r.stderr).toContain("flowDefinition");
  });

  it("flags a missing registerRunners export with an actionable error", () => {
    const broken = writeBrokenModule(
      stateDir,
      "no-runners.ts",
      `
      export const flowDefinition = {
        id: "x", version: 1, entry: "a",
        nodes: [{ kind: "agent_step", id: "a", role: "r", runner: "r", inputs: {}, dependsOn: [] }],
      };
    `,
    );
    const r = runCli(["flow", "run", broken, "--task", "smoke"], {
      env: { SHAMU_STATE_DIR: stateDir },
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr.toLowerCase()).toContain("flow module");
    expect(r.stderr).toContain("registerRunners");
  });

  it("--resume rehydrates state_json and short-circuits cached outputs", () => {
    // Run once with a cache probe targeting the 'end' node. After the
    // happy-path run, tiny-flow will have appended 'end\n' to the probe
    // file. A --resume pass against the same flow-run-id with the same
    // inputs should hit the content-hash cache and NOT re-invoke the
    // runner (no second 'end' line should appear).
    const probeFile = join(stateDir, "cache-probe.log");
    writeFileSync(probeFile, "");

    const first = runCli(["flow", "run", TINY_FLOW, "--task", "smoke", "--json"], {
      env: {
        SHAMU_STATE_DIR: stateDir,
        SHAMU_TINY_FLOW_CACHE_PROBE: "end",
        SHAMU_TINY_FLOW_CACHE_PROBE_FILE: probeFile,
      },
    });
    expect(first.status).toBe(0);
    const startedLine = first.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((p) => p.kind === "flow_started");
    expect(startedLine).toBeDefined();
    const flowRunId = startedLine?.flowRunId as string;
    expect(typeof flowRunId).toBe("string");

    const runsBeforeResume = readFileSync(probeFile, "utf8")
      .split("\n")
      .filter((l) => l === "end").length;
    expect(runsBeforeResume).toBeGreaterThanOrEqual(1);

    const second = runCli(
      ["flow", "run", TINY_FLOW, "--task", "smoke", "--resume", flowRunId, "--json"],
      {
        env: {
          SHAMU_STATE_DIR: stateDir,
          SHAMU_TINY_FLOW_CACHE_PROBE: "end",
          SHAMU_TINY_FLOW_CACHE_PROBE_FILE: probeFile,
        },
      },
    );
    expect(second.status).toBe(0);
    // Node was cached → NodeCompleted with cached=true. The probe file
    // should show only the first-run invocation (no new 'end' line).
    const runsAfterResume = readFileSync(probeFile, "utf8")
      .split("\n")
      .filter((l) => l === "end").length;
    expect(runsAfterResume).toBe(runsBeforeResume);

    const cachedCompleted = second.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((p) => p.kind === "node_completed");
    const cachedFlags = cachedCompleted.map((c) => {
      const payload = c.payload as Record<string, unknown>;
      return payload.cached === true;
    });
    expect(cachedFlags.some((f) => f)).toBe(true);
  });

  it("maps a runner failure to RUN_FAILED (exit 10)", () => {
    const r = runCli(["flow", "run", TINY_FLOW, "--task", "smoke"], {
      env: {
        SHAMU_STATE_DIR: stateDir,
        SHAMU_TINY_FLOW_FAIL_AT: "end",
      },
    });
    expect(r.status).toBe(10);
  });
});

/** Write a broken flow module into `dir` and return the absolute path. */
function writeBrokenModule(dir: string, name: string, contents: string): string {
  const path = join(dir, name);
  writeFileSync(path, contents, "utf8");
  return path;
}

/** Read the single flow_runs row the test just wrote via a bun subprocess. */
interface FlowRowProbe {
  readonly count: number;
  readonly status: string;
  readonly flowId: string;
}

function inspectDb(stateDir: string, dbPath: string): FlowRowProbe {
  const script = `
import { Database } from "bun:sqlite";
const db = new Database(${JSON.stringify(dbPath)});
const countRow = db.prepare("SELECT COUNT(*) AS c FROM flow_runs").get();
const row = db.prepare("SELECT flow_id, status FROM flow_runs ORDER BY started_at DESC LIMIT 1").get();
process.stdout.write(JSON.stringify({
  count: (countRow as { c: number }).c,
  flowId: (row as { flow_id?: string } | null)?.flow_id ?? "",
  status: (row as { status?: string } | null)?.status ?? "",
}));
  `;
  const inspector = join(stateDir, "inspect-flow.ts");
  writeFileSync(inspector, script);
  if (!existsSync(dbPath)) {
    return { count: 0, status: "", flowId: "" };
  }
  const res = spawnSync("bun", [inspector], { encoding: "utf8", timeout: 10_000 });
  if ((res.status ?? -1) !== 0) {
    throw new Error(`inspectDb failed: ${res.stderr}`);
  }
  return JSON.parse(res.stdout) as FlowRowProbe;
}
