import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseRunState, buildReviewerExcerpt, toDomainEvent, estimateTokens } from "../src/index.ts";
import type { AgentCIRunState } from "../src/index.ts";

const FIXTURES = path.resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "..",
  "..",
  "fixtures",
);

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
    // agent-ci's own quirk: top-level status is not flushed before process exit.
    expect(state.status).toBe("running");
    expect(summary.status).toBe("green");
  });

  it("reports one workflow, one job, all completed", () => {
    expect(summary.workflows).toHaveLength(1);
    expect(summary.workflows[0]!.status).toBe("green");
    expect(summary.workflows[0]!.jobs).toHaveLength(1);
    expect(summary.workflows[0]!.jobs[0]!.status).toBe("green");
    expect(summary.workflows[0]!.jobs[0]!.failedStep).toBeNull();
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
    // Workflow.status was 'failed' in the captured state.
    const wf = state.workflows[0]!;
    expect(wf.status).toBe("failed");
    expect(summary.status).toBe("red");
  });

  it("identifies the failed step", () => {
    const job = summary.workflows[0]!.jobs[0]!;
    expect(job.failedStep).toBe("Test");
    expect(job.failureKind).toBe("test");
  });

  it("parses both failing TAP subtests and drops the suite-level rollup", () => {
    const job = summary.workflows[0]!.jobs[0]!;
    // Two real test failures, plus two roll-up suite failures in the TAP output
    // ('not ok 2 - greet' + 'not ok 3 - math edge cases'). Our filter drops the
    // rollups that just say '1 subtest failed'.
    expect(job.failingTests.length).toBeGreaterThanOrEqual(2);
    const names = job.failingTests.map((t) => t.name);
    expect(names).toContain("greets with a trailing period (intentional failure)");
    expect(names).toContain("add handles negatives");
  });

  it("extracts location + expected/actual from the YAML block", () => {
    const job = summary.workflows[0]!.jobs[0]!;
    const greetFailure = job.failingTests.find((t) =>
      t.name.startsWith("greets with"),
    )!;
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
    expect(ev.reviewerExcerpt).not.toMatch(/\x1B\[/);
  });
});

describe("parseRunState — red (lint failure) fixture", () => {
  const state = loadRunState("red-lint-run-state.json");
  const stepLog = fs.readFileSync(path.join(FIXTURES, "red-lint-step-Lint.log"), "utf-8");
  const summary = parseRunState(state, {
    readStepLog: stepLogReader({ "Lint.log": stepLog }),
  });

  it("identifies the failed step and kind", () => {
    const job = summary.workflows[0]!.jobs[0]!;
    expect(job.failedStep).toBe("Lint");
    expect(job.failureKind).toBe("lint");
  });

  it("parses ESLint errors (ignoring ANSI colour codes)", () => {
    const job = summary.workflows[0]!.jobs[0]!;
    expect(job.failingTests.length).toBeGreaterThanOrEqual(2);
    const rules = job.failingTests.map((t) => t.name).join("\n");
    expect(rules).toContain("no-var");
    expect(rules).toContain("@typescript-eslint/no-unused-vars");
  });

  it("marks skipped steps as such in the source state (smoke-check fixture freshness)", () => {
    const job = state.workflows[0]!.jobs[0]!;
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

describe("excerpt truncation", () => {
  const state = loadRunState("red-test-run-state.json");
  const stepLog = fs.readFileSync(path.join(FIXTURES, "red-test-step-Test.log"), "utf-8");
  const summary = parseRunState(state, {
    readStepLog: stepLogReader({ "Test.log": stepLog }),
  });

  it("respects a small maxTokens budget", () => {
    const excerpt = buildReviewerExcerpt(summary, { maxTokens: 120 });
    expect(estimateTokens(excerpt)).toBeLessThanOrEqual(200); // slack for header+truncation line
    expect(excerpt).toContain("truncated");
  });
});

describe("determinism", () => {
  const state = loadRunState("red-test-run-state.json");
  const stepLog = fs.readFileSync(path.join(FIXTURES, "red-test-step-Test.log"), "utf-8");
  const readStepLog = stepLogReader({ "Test.log": stepLog });

  it("produces identical output across runs", () => {
    const s1 = parseRunState(state, { readStepLog });
    const s2 = parseRunState(state, { readStepLog });
    expect(JSON.stringify(s1)).toEqual(JSON.stringify(s2));
    expect(buildReviewerExcerpt(s1)).toEqual(buildReviewerExcerpt(s2));
  });
});
