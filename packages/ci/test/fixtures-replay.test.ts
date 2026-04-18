/**
 * The byte-identical contract.
 *
 * For each of the 3 committed fixtures, we:
 *   1. Parse the run-state.json + step log.
 *   2. Build the reviewer excerpt.
 *   3. Project to a domain event.
 *   4. Assert the (summary, excerpt, event) triple matches the committed
 *      snapshot in `__snapshots__/fixtures-replay.test.ts.snap`.
 *   5. Run the pipeline a second time against the same inputs and assert the
 *      outputs are byte-identical to the first run.
 *
 * If this test starts failing it means either:
 *   (a) the parser / excerpt semantics changed (intentionally — update the
 *       snapshot + note in the commit body), or
 *   (b) non-determinism slipped in (reject; reviewer excerpt is a committed
 *       contract — 5.B reads it verbatim).
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AgentCIRunState, CIDomainEvent, CIRunSummary } from "../src/index.ts";
import { buildReviewerExcerpt, parseRunState, toDomainEvent } from "../src/index.ts";

const FIXTURES = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "fixtures");

interface ReplayInputs {
  runState: string;
  stepLogs: Record<string, string>;
}

interface ReplayOutput {
  summary: CIRunSummary;
  excerpt: string;
  event: CIDomainEvent;
}

const CASES: Array<{ name: string; inputs: ReplayInputs }> = [
  {
    name: "green",
    inputs: {
      runState: "green-run-state.json",
      stepLogs: {},
    },
  },
  {
    name: "red-lint",
    inputs: {
      runState: "red-lint-run-state.json",
      stepLogs: { "Lint.log": "red-lint-step-Lint.log" },
    },
  },
  {
    name: "red-test",
    inputs: {
      runState: "red-test-run-state.json",
      stepLogs: { "Test.log": "red-test-step-Test.log" },
    },
  },
];

function runPipeline(inputs: ReplayInputs): ReplayOutput {
  const runStateRaw = fs.readFileSync(path.join(FIXTURES, inputs.runState), "utf-8");
  const state = JSON.parse(runStateRaw) as AgentCIRunState;
  const logMap: Record<string, string> = {};
  for (const [logKey, fixturePath] of Object.entries(inputs.stepLogs)) {
    logMap[logKey] = fs.readFileSync(path.join(FIXTURES, fixturePath), "utf-8");
  }
  const summary = parseRunState(state, {
    readStepLog: (p) => logMap[path.basename(p)] ?? null,
  });
  const excerpt = buildReviewerExcerpt(summary);
  const event = toDomainEvent(summary);
  return { summary, excerpt, event };
}

describe("fixtures replay — snapshot contract", () => {
  for (const c of CASES) {
    it(`${c.name}: excerpt + event match committed snapshot`, () => {
      const out = runPipeline(c.inputs);
      expect({
        status: out.summary.status,
        runId: out.summary.runId,
        totalSteps: out.summary.totalSteps,
        failedSteps: out.summary.failedSteps,
        excerpt: out.excerpt,
        eventKind: out.event.kind,
      }).toMatchSnapshot();
    });
  }
});

describe("fixtures replay — determinism (two consecutive runs byte-identical)", () => {
  for (const c of CASES) {
    it(`${c.name}: two pipeline runs produce byte-identical outputs`, () => {
      const a = runPipeline(c.inputs);
      const b = runPipeline(c.inputs);
      expect(JSON.stringify(a.summary)).toBe(JSON.stringify(b.summary));
      expect(a.excerpt).toBe(b.excerpt);
      expect(JSON.stringify(a.event)).toBe(JSON.stringify(b.event));
    });
  }
});
