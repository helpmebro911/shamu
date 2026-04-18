/**
 * Integration tests: spawn the CLI as a subprocess and assert on its stdout,
 * stderr, and exit code. Kept fast — a handful of commands, no heavy checks.
 */

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CLI_ENTRY = join(__dirname, "..", "src", "index.ts");

function runCli(
  args: string[],
  options: { timeoutMs?: number; cwd?: string } = {},
): { stdout: string; stderr: string; status: number | null } {
  // Strip vitest-injected NODE_OPTIONS (esbuild inline-source-map hooks etc.)
  // from the child env — they can perturb consola's stdout detection.
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.VITEST;
  delete env.VITEST_WORKER_ID;
  delete env.VITEST_POOL_ID;
  const res = spawnSync("bun", [CLI_ENTRY, ...args], {
    encoding: "utf8",
    timeout: options.timeoutMs ?? 15_000,
    env,
    ...(options.cwd ? { cwd: options.cwd } : {}),
  });
  return { stdout: res.stdout ?? "", stderr: res.stderr ?? "", status: res.status };
}

describe("shamu CLI (subprocess)", () => {
  it("--help exits 0 and lists subcommands", () => {
    const r = runCli(["--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("shamu");
    expect(r.stdout).toContain("doctor");
    expect(r.stdout).toContain("run");
  });

  it("unknown command exits USAGE (2)", () => {
    const r = runCli(["nope"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("Unknown command");
  });

  it("doctor --json emits newline-delimited JSON events", () => {
    const r = runCli(["doctor", "--json"]);
    expect([0, 20]).toContain(r.status); // any check may fail locally; shape is what matters
    const lines = r.stdout.trim().split("\n");
    expect(lines.length).toBeGreaterThan(3);
    for (const line of lines) {
      const obj = JSON.parse(line) as Record<string, unknown>;
      expect(typeof obj.kind).toBe("string");
    }
    const summary = JSON.parse(lines[lines.length - 1] as string) as Record<string, unknown>;
    expect(summary.kind).toBe("doctor-summary");
  });

  it("status prints an empty-runs payload and exits 0", () => {
    const r = runCli(["status"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("no active runs");
  });

  it("status --json emits a status payload with empty runs", () => {
    const r = runCli(["status", "--json"]);
    expect(r.status).toBe(0);
    const lines = r.stdout.trim().split("\n");
    const obj = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(obj.kind).toBe("status");
    expect(obj.runs).toEqual([]);
  });

  it("kill with no supervisor wiring exits INTERNAL (20) and includes a phase message", () => {
    const r = runCli(["kill", "phantom-run"]);
    expect(r.status).toBe(20);
    expect(r.stderr.toLowerCase()).toMatch(/phase 3/);
  });

  it("run without --task exits with USAGE (missing required)", () => {
    const r = runCli(["run"]);
    expect(r.status).toBe(2);
  });

  it("run --task 'x' --dry-run exits 0 and prints validated payload", () => {
    const r = runCli(["run", "--adapter", "echo", "--task", "ship", "--dry-run"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("run validated");
  });

  it("run --task 'x' --dry-run --json emits a run-validated JSON event", () => {
    const r = runCli(["run", "--adapter", "echo", "--task", "ship", "--dry-run", "--json"]);
    expect(r.status).toBe(0);
    const obj = JSON.parse(r.stdout.trim().split("\n")[0] as string) as Record<string, unknown>;
    expect(obj.kind).toBe("run-validated");
    expect(obj.task).toBe("ship");
  });

  it("run without --adapter exits USAGE (2) and suggests --adapter echo", () => {
    const r = runCli(["run", "--task", "ship"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--adapter");
    expect(r.stderr).toContain("echo");
  });

  it("run --adapter unknown exits USAGE (2)", () => {
    const r = runCli(["run", "--adapter", "no-such-adapter", "--task", "ship"]);
    expect(r.status).toBe(2);
    expect(r.stderr.toLowerCase()).toContain("unknown adapter");
  });

  it("flow run without --task exits with USAGE", () => {
    const r = runCli(["flow", "run", "plan-execute-review"]);
    expect(r.status).toBe(2);
  });

  it("linear tunnel is not wired yet (INTERNAL with phase 6 notice)", () => {
    const r = runCli(["linear", "tunnel"]);
    expect(r.status).toBe(20);
    expect(r.stderr.toLowerCase()).toMatch(/phase 6/);
  });
});
