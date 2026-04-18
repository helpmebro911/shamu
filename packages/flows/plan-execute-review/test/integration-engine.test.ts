/**
 * End-to-end integration: run the `flowDefinition` through the real
 * `FlowEngine` with our four runners wired against fake adapters. Confirms
 * the DAG + runner set compose correctly and that the cost roll-up surfaces
 * the executor's exact-cost samples verbatim.
 */

import { EventBus } from "@shamu/core-flow/bus";
import { FlowEngine } from "@shamu/core-flow/engine";
import type { FlowCompleted, FlowEvent } from "@shamu/core-flow/events";
import { RunnerRegistry } from "@shamu/core-flow/runners";
import { newWorkflowRunId } from "@shamu/shared/ids";
import { describe, expect, test } from "vitest";
import { flowDefinition } from "../src/flow.ts";
import type { AdapterOverride } from "../src/runners.ts";
import { registerRunners } from "../src/runners.ts";
import type {
  ExecutorOutput,
  PlannerOutput,
  ReviewerModelOutput,
  ReviewerVerdict,
} from "../src/schemas.ts";
import { FAKE_CLAUDE_CAPS, FAKE_CODEX_CAPS, FakeAdapter, fencedJson } from "./_fake-adapter.ts";

const PLAN: PlannerOutput = {
  goal: "edit the readme",
  steps: [{ id: "s1", description: "add heading", filesTouched: ["README.md"] }],
  assumptions: [],
};

const EXEC: ExecutorOutput = {
  summary: "added heading",
  diffStats: { added: 1, removed: 0, files: ["README.md"] },
  notes: "",
};

const APPROVE: ReviewerModelOutput = {
  verdict: "approve",
  feedback: "lgtm",
  concerns: [],
};

describe("flow engine integration", () => {
  test("runs end-to-end with fake adapters, reports succeeded + cost roll-up", async () => {
    const planner = new FakeAdapter({
      vendor: "codex",
      capabilities: FAKE_CODEX_CAPS,
      scriptFor: () => ({ finalAssistantText: fencedJson(PLAN) }),
    });
    const executor = new FakeAdapter({
      vendor: "claude",
      capabilities: FAKE_CLAUDE_CAPS,
      scriptFor: () => ({
        finalAssistantText: fencedJson(EXEC),
        costSamples: [
          { usd: 0.25, confidence: "exact", source: "vendor" },
          { usd: 0.1, confidence: "exact", source: "vendor" },
        ],
      }),
    });
    const reviewer = new FakeAdapter({
      vendor: "codex",
      capabilities: FAKE_CODEX_CAPS,
      scriptFor: () => ({ finalAssistantText: fencedJson(APPROVE) }),
    });

    const registry = new RunnerRegistry();
    const override: AdapterOverride = {
      plannerAdapter: () => planner,
      executorAdapter: () => executor,
      reviewerAdapter: () => reviewer,
    };
    registerRunners(registry, {
      workspaceCwd: "/tmp/shamu-integration",
      __adapterOverride: override,
    });

    const bus = new EventBus<FlowEvent>();
    const events: FlowEvent[] = [];
    bus.subscribe((ev) => {
      events.push(ev);
    });

    const engine = new FlowEngine({ registry, bus });
    const state = await engine.run(flowDefinition, {
      flowRunId: newWorkflowRunId(),
      initialInputs: {
        task: "add a heading",
        repoContext: "tiny repo",
      },
    });

    const completed = events.find((e): e is FlowCompleted => e.kind === "flow_completed");
    expect(completed).toBeDefined();
    expect(completed?.status).toBe("succeeded");
    // Only the executor produced non-null cost samples (0.25 + 0.10).
    expect(completed?.totalCostUsd).toBeCloseTo(0.35, 5);
    // The flow has exact + unknown samples (planner + reviewer produce
    // subscription samples); the roll-up collapses to "exact" because the
    // roll-up ignores unknown+null samples per engine.ts's
    // rollupConfidence.
    expect(completed?.costConfidence).toBe("exact");

    // Final review output should be an approve with iterationsUsed=1.
    const reviewOutput = state.nodeOutputs.review;
    expect(reviewOutput).toBeDefined();
    expect(reviewOutput?.output.ok).toBe(true);
    const verdict = reviewOutput?.output.value as ReviewerVerdict;
    expect(verdict.verdict).toBe("approve");
    expect(verdict.iterationsUsed).toBe(1);

    // Four node completions (plan / execute / review / loop), at least.
    const completedNodes = events.filter((e) => e.kind === "node_completed");
    expect(completedNodes.length).toBeGreaterThanOrEqual(4);
  });
});
