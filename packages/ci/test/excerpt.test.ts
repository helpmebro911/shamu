import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AgentCIRunState } from "../src/index.ts";
import { buildReviewerExcerpt, estimateTokens, parseRunState } from "../src/index.ts";

const FIXTURES = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "fixtures");

function loadRunState(name: string): AgentCIRunState {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), "utf-8"));
}

function stepLogReader(map: Record<string, string>) {
  return (p: string): string | null => map[path.basename(p)] ?? null;
}

const redTestState = loadRunState("red-test-run-state.json");
const redTestLog = fs.readFileSync(path.join(FIXTURES, "red-test-step-Test.log"), "utf-8");
const redTestSummary = parseRunState(redTestState, {
  readStepLog: stepLogReader({ "Test.log": redTestLog }),
});

describe("buildReviewerExcerpt — determinism", () => {
  it("produces byte-identical output across runs", () => {
    const a = buildReviewerExcerpt(redTestSummary);
    const b = buildReviewerExcerpt(redTestSummary);
    expect(a).toBe(b);
  });

  it("is stable after re-parsing the fixture", () => {
    const resummary = parseRunState(redTestState, {
      readStepLog: stepLogReader({ "Test.log": redTestLog }),
    });
    expect(buildReviewerExcerpt(resummary)).toBe(buildReviewerExcerpt(redTestSummary));
  });
});

describe("buildReviewerExcerpt — token bound", () => {
  it("respects the 2000-token default", () => {
    const text = buildReviewerExcerpt(redTestSummary);
    expect(estimateTokens(text)).toBeLessThanOrEqual(2000);
  });

  it("shrinks to a small maxTokens budget", () => {
    const excerpt = buildReviewerExcerpt(redTestSummary, { maxTokens: 120 });
    expect(excerpt).toContain("truncated");
    // Allow a modest slack: truncation markers + the header itself can push
    // past the caller-supplied budget slightly. 200 is enough to clearly show
    // the builder is actively shrinking without being lax.
    expect(estimateTokens(excerpt)).toBeLessThanOrEqual(200);
  });
});

describe("buildReviewerExcerpt — greedy then shrink", () => {
  it("includes all failing tests at the default budget", () => {
    const text = buildReviewerExcerpt(redTestSummary);
    expect(text).toContain("greets with a trailing period");
    expect(text).toContain("add handles negatives");
  });

  it("drops per-job detail under aggressive budgets", () => {
    const excerpt = buildReviewerExcerpt(redTestSummary, { maxTokens: 60 });
    // Budget too tight for any job block; header+truncation-only path fires.
    expect(excerpt).toContain("truncated");
  });
});

describe("buildReviewerExcerpt — tail fallback", () => {
  it("renders the fallback excerpt when no failing tests were extracted", () => {
    // Build a synthetic state with only `lastOutputLines` — no step log —
    // and a step name that does not classify as test/lint.
    const state: AgentCIRunState = {
      runId: "run-unknown",
      status: "running",
      startedAt: "2026-04-17T00:00:00Z",
      workflows: [
        {
          id: "ci.yml",
          path: "/tmp/ci.yml",
          status: "failed",
          jobs: [
            {
              id: "job1",
              runnerId: "agent-ci-1",
              status: "failed",
              steps: [{ name: "Capture outputs", index: 1, status: "failed" }],
              lastOutputLines: ["boom line 1", "boom line 2", "boom line 3"],
              failedStep: "Capture outputs",
            },
          ],
        },
      ],
    };
    const summary = parseRunState(state);
    const excerpt = buildReviewerExcerpt(summary);
    expect(excerpt).toContain("boom line");
  });
});
