import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AgentCIRunState } from "../src/index.ts";
import {
  buildReviewerExcerpt,
  estimateTokens,
  parseRunState,
  toDomainEvent,
} from "../src/index.ts";

const FIXTURES = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "fixtures");

function loadRunState(name: string): AgentCIRunState {
  const raw = fs.readFileSync(path.join(FIXTURES, name), "utf-8");
  return JSON.parse(raw);
}

function stepLogReader(map: Record<string, string>) {
  return (absPath: string): string | null => {
    const base = path.basename(absPath);
    return map[base] ?? null;
  };
}

describe("parseRunState — green fixture", () => {
  const state = loadRunState("green-run-state.json");
  const summary = parseRunState(state, { readStepLog: () => null });

  it("derives status=green even though top-level state.status='running' on disk", () => {
    // The Phase 0.D invariant: never trust top-level state.status.
    expect(state.status).toBe("running");
    expect(summary.status).toBe("green");
  });

  it("reports one workflow, one job, all completed", () => {
    const wf0 = summary.workflows[0];
    if (!wf0) throw new Error("expected one workflow");
    expect(summary.workflows).toHaveLength(1);
    expect(wf0.status).toBe("green");
    expect(wf0.jobs).toHaveLength(1);
    const job0 = wf0.jobs[0];
    if (!job0) throw new Error("expected one job");
    expect(job0.status).toBe("green");
    expect(job0.failedStep).toBeNull();
  });

  it("has no failed steps", () => {
    expect(summary.failedSteps).toEqual([]);
  });

  it("projects to PatchReady domain event", () => {
    const ev = toDomainEvent(summary);
    expect(ev.kind).toBe("PatchReady");
  });

  it("excerpt for a green run is a short header with no job blocks", () => {
    const excerpt = buildReviewerExcerpt(summary);
    expect(excerpt).toContain("GREEN");
    expect(excerpt).not.toContain("failed at");
    expect(excerpt.split("\n").length).toBeLessThan(5);
  });
});

describe("parseRunState — red (test failure) fixture", () => {
  const state = loadRunState("red-test-run-state.json");
  const stepLog = fs.readFileSync(path.join(FIXTURES, "red-test-step-Test.log"), "utf-8");
  const summary = parseRunState(state, {
    readStepLog: stepLogReader({ "Test.log": stepLog }),
  });

  it("derives status=red via persisted workflow status", () => {
    const wf = state.workflows[0];
    if (!wf) throw new Error("expected workflow");
    expect(wf.status).toBe("failed");
    expect(summary.status).toBe("red");
  });

  it("identifies the failed step", () => {
    const wf = summary.workflows[0];
    if (!wf) throw new Error("expected workflow");
    const job = wf.jobs[0];
    if (!job) throw new Error("expected job");
    expect(job.failedStep).toBe("Test");
    expect(job.failureKind).toBe("test");
  });

  it("parses TAP subtests and drops suite-level rollups", () => {
    const wf = summary.workflows[0];
    if (!wf) throw new Error("expected workflow");
    const job = wf.jobs[0];
    if (!job) throw new Error("expected job");
    expect(job.failingTests.length).toBeGreaterThanOrEqual(2);
    const names = job.failingTests.map((t) => t.name);
    expect(names).toContain("greets with a trailing period (intentional failure)");
    expect(names).toContain("add handles negatives");
  });

  it("extracts location + expected/actual from the YAML block", () => {
    const wf = summary.workflows[0];
    if (!wf) throw new Error("expected workflow");
    const job = wf.jobs[0];
    if (!job) throw new Error("expected job");
    const greetFailure = job.failingTests.find((t) => t.name.startsWith("greets with"));
    if (!greetFailure) throw new Error("expected greet failure");
    expect(greetFailure.location).toContain("index.test.ts");
    expect(greetFailure.expected).toBe("Hello, Shamu.");
    expect(greetFailure.actual).toBe("Hello, Shamu!");
  });

  it("emits a CIRed domain event with a reviewer excerpt", () => {
    const ev = toDomainEvent(summary);
    expect(ev.kind).toBe("CIRed");
    if (ev.kind !== "CIRed") throw new Error("unreachable");
    expect(ev.reviewerExcerpt).toContain("RED");
    expect(ev.reviewerExcerpt).toContain("Test");
    expect(ev.reviewerExcerpt).toContain("greets with a trailing period");
  });

  it("reviewer excerpt stays under token budget", () => {
    const ev = toDomainEvent(summary);
    if (ev.kind !== "CIRed") throw new Error("unreachable");
    expect(estimateTokens(ev.reviewerExcerpt)).toBeLessThanOrEqual(2000);
  });

  it("reviewer excerpt has zero ANSI escape sequences", () => {
    const ev = toDomainEvent(summary);
    if (ev.kind !== "CIRed") throw new Error("unreachable");
    // Build the CSI introducer at runtime so Biome's regex control-character
    // rule doesn't trip on the literal escape. String.includes is sufficient.
    const csi = `${String.fromCharCode(0x1b)}[`;
    expect(ev.reviewerExcerpt.includes(csi)).toBe(false);
  });
});

describe("parseRunState — red (lint failure) fixture", () => {
  const state = loadRunState("red-lint-run-state.json");
  const stepLog = fs.readFileSync(path.join(FIXTURES, "red-lint-step-Lint.log"), "utf-8");
  const summary = parseRunState(state, {
    readStepLog: stepLogReader({ "Lint.log": stepLog }),
  });

  it("identifies the failed step and kind", () => {
    const wf = summary.workflows[0];
    if (!wf) throw new Error("expected workflow");
    const job = wf.jobs[0];
    if (!job) throw new Error("expected job");
    expect(job.failedStep).toBe("Lint");
    expect(job.failureKind).toBe("lint");
  });

  it("parses ESLint errors (ignoring ANSI colour codes)", () => {
    const wf = summary.workflows[0];
    if (!wf) throw new Error("expected workflow");
    const job = wf.jobs[0];
    if (!job) throw new Error("expected job");
    expect(job.failingTests.length).toBeGreaterThanOrEqual(2);
    const rules = job.failingTests.map((t) => t.name).join("\n");
    expect(rules).toContain("no-var");
    expect(rules).toContain("@typescript-eslint/no-unused-vars");
  });

  it("source state contains skipped steps (fixture freshness check)", () => {
    const wf = state.workflows[0];
    if (!wf) throw new Error("expected workflow");
    const job = wf.jobs[0];
    if (!job) throw new Error("expected job");
    const skipped = job.steps.filter((s) => s.status === "skipped");
    expect(skipped.length).toBeGreaterThan(0);
  });

  it("emits CIRed + excerpt mentions both rules", () => {
    const ev = toDomainEvent(summary);
    if (ev.kind !== "CIRed") throw new Error("unreachable");
    expect(ev.reviewerExcerpt).toContain("no-var");
    expect(ev.reviewerExcerpt).toContain("no-unused-vars");
  });
});

describe("parseRunState — structural invariants", () => {
  it("returns status=unknown when given zero workflows", () => {
    const state: AgentCIRunState = {
      runId: "run-empty",
      status: "running",
      startedAt: "2026-04-17T00:00:00Z",
      workflows: [],
    };
    const summary = parseRunState(state);
    expect(summary.status).toBe("unknown");
    expect(summary.workflows).toEqual([]);
    expect(summary.failedSteps).toEqual([]);
    expect(summary.totalSteps).toBe(0);
  });

  it("job status maps paused to red", () => {
    const state: AgentCIRunState = {
      runId: "run-paused",
      status: "running",
      startedAt: "2026-04-17T00:00:00Z",
      workflows: [
        {
          id: "ci.yml",
          path: "/tmp/ci.yml",
          status: "running",
          jobs: [
            {
              id: "check",
              runnerId: "agent-ci-1",
              status: "paused",
              steps: [{ name: "Test", index: 1, status: "failed" }],
              lastOutputLines: ["boom"],
              pausedAtStep: "Test",
            },
          ],
        },
      ],
    };
    const summary = parseRunState(state);
    expect(summary.status).toBe("red");
    const wf = summary.workflows[0];
    if (!wf) throw new Error("expected workflow");
    const job = wf.jobs[0];
    if (!job) throw new Error("expected job");
    expect(job.status).toBe("red");
    expect(job.failedStep).toBe("Test");
  });
});
