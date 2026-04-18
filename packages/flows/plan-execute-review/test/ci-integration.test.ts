/**
 * Phase 5.B end-to-end-style integration: drive the reviewer runner against
 * scripted fake adapters + a scripted CI override. Asserts the cross-cutting
 * behavior that a red-CI cannot leak into an `approved` flow.
 *
 * These tests exercise the reviewer runner (which is the iteration
 * controller) and the loop predicate as a pair. The full DAG is covered by
 * `integration-engine.test.ts` (which wires the real FlowEngine).
 */

import type { GateResult } from "@shamu/ci";
import type { RunnerContext } from "@shamu/core-flow/runners";
import { RunnerRegistry } from "@shamu/core-flow/runners";
import type { NodeId, NodeOutput } from "@shamu/core-flow/types";
import { newWorkflowRunId } from "@shamu/shared/ids";
import { describe, expect, test } from "vitest";
import { flowDefinition } from "../src/flow.ts";
import type { AdapterOverride, CIRunOverride } from "../src/runners.ts";
import { registerRunners } from "../src/runners.ts";
import type {
  CINodeOutput,
  ExecutorOutput,
  PlannerOutput,
  ReviewerModelOutput,
  ReviewerVerdict,
} from "../src/schemas.ts";
import type { FakeAdapterScript } from "./_fake-adapter.ts";
import { FAKE_CLAUDE_CAPS, FAKE_CODEX_CAPS, FakeAdapter, fencedJson } from "./_fake-adapter.ts";

const PLAN: PlannerOutput = {
  goal: "edit readme",
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
  feedback: "looks good",
  concerns: [],
};

function okOutput(value: unknown): NodeOutput {
  return {
    ok: true,
    value,
    costUsd: null,
    costConfidence: "unknown",
    costSource: "test",
  };
}

function buildCtx(params: {
  readonly nodeKey: "plan" | "execute" | "ci" | "review" | "loop";
  readonly priorOutputs?: Record<string, NodeOutput>;
  readonly initial?: Record<string, unknown>;
}): RunnerContext {
  const node = flowDefinition.nodes.find((n) => n.id === params.nodeKey);
  if (!node) throw new Error(`missing node: ${params.nodeKey}`);
  return {
    flowRunId: newWorkflowRunId(),
    node,
    inputs: { initial: params.initial ?? {}, deps: {}, node: {} },
    priorOutputs: (params.priorOutputs ?? {}) as Record<NodeId, NodeOutput>,
    signal: new AbortController().signal,
  };
}

function redGate(runId: string, excerpt: string): GateResult {
  const summary: GateResult["summary"] = {
    runId,
    status: "red",
    durationMs: 0,
    workflows: [],
    totalSteps: 0,
    failedSteps: [],
  };
  return {
    exitCode: 1,
    stdout: "",
    stderr: "",
    runDir: `/tmp/fake-ci/${runId}`,
    summary,
    domainEvent: { kind: "CIRed", runId, summary, reviewerExcerpt: excerpt },
  };
}

function ciRedOutput(runId: string, excerpt: string): NodeOutput {
  const value: CINodeOutput = {
    kind: "CIRed",
    runId,
    summary: {
      runId,
      status: "red",
      durationMs: 0,
      workflows: [],
      totalSteps: 0,
      failedSteps: [],
    },
    reviewerExcerpt: excerpt,
  };
  return okOutput(value);
}

interface WireInput {
  readonly reviewerScripts: readonly FakeAdapterScript[];
  readonly executorScripts?: readonly FakeAdapterScript[];
  readonly ciRun: CIRunOverride;
  readonly maxIterations?: number;
}

interface WireResult {
  readonly registry: RunnerRegistry;
  readonly executorAdapter: FakeAdapter;
  readonly reviewerAdapter: FakeAdapter;
}

function wire(input: WireInput): WireResult {
  const plannerAdapter = new FakeAdapter({
    vendor: "codex",
    capabilities: FAKE_CODEX_CAPS,
    scriptFor: () => ({ finalAssistantText: fencedJson(PLAN) }),
  });
  const executorAdapter = new FakeAdapter({
    vendor: "claude",
    capabilities: FAKE_CLAUDE_CAPS,
    scriptFor: (idx) => {
      const script = input.executorScripts?.[idx] ?? { finalAssistantText: fencedJson(EXEC) };
      return script;
    },
  });
  const reviewerAdapter = new FakeAdapter({
    vendor: "codex",
    capabilities: FAKE_CODEX_CAPS,
    scriptFor: (idx) => {
      const script = input.reviewerScripts[idx];
      if (!script) throw new Error(`unexpected reviewer spawn #${idx}`);
      return script;
    },
  });
  const registry = new RunnerRegistry();
  const override: AdapterOverride = {
    plannerAdapter: () => plannerAdapter,
    executorAdapter: () => executorAdapter,
    reviewerAdapter: () => reviewerAdapter,
  };
  registerRunners(registry, {
    workspaceCwd: "/tmp/shamu-ci-integration",
    __adapterOverride: override,
    __ciRunOverride: input.ciRun,
    ...(input.maxIterations !== undefined ? { maxIterations: input.maxIterations } : {}),
  });
  return { registry, executorAdapter, reviewerAdapter };
}

describe("ci-integration: red CI cannot be approved", () => {
  test("reviewer + loop-predicate terminate with revise at cap when CI is persistently red", async () => {
    // Reviewer emits approve every pass; CI stays red. Each pass should be
    // auto-rewritten to revise. At cap, loop-predicate returns true so the
    // flow completes.
    const reviewerScripts: FakeAdapterScript[] = [
      { finalAssistantText: fencedJson(APPROVE) },
      { finalAssistantText: fencedJson(APPROVE) },
      { finalAssistantText: fencedJson(APPROVE) },
    ];
    let ciCallCount = 0;
    const ciRun: CIRunOverride = async () => {
      ciCallCount += 1;
      return redGate(`run-${ciCallCount}`, "test failed: math broken");
    };
    const { registry } = wire({ reviewerScripts, ciRun, maxIterations: 3 });

    const reviewerRunner = registry.get("reviewer");
    const reviewOut = await reviewerRunner?.(
      buildCtx({
        nodeKey: "review",
        initial: { task: "t", repoContext: "ctx" },
        priorOutputs: {
          plan: okOutput(PLAN),
          execute: okOutput(EXEC),
          ci: ciRedOutput("initial-red", "initial red excerpt"),
        },
      }),
    );
    expect(reviewOut?.ok).toBe(true);
    const verdict = reviewOut?.value as ReviewerVerdict;
    // All three passes were auto-rewritten to revise; the final verdict
    // surfaced to the NodeOutput reflects that.
    expect(verdict.verdict).toBe("revise");
    expect(verdict.iterationsUsed).toBe(3);
    expect(verdict.feedback).toMatch(/\[shamu\] reviewer emitted 'approve' against red CI/);

    // Loop predicate sees the revise-at-cap verdict and returns true so the
    // engine terminates. This is the structural check: red CI cannot leak
    // into an approved flow.
    const loopRunner = registry.get("loop-predicate");
    const loopOut = await loopRunner?.(
      buildCtx({
        nodeKey: "loop",
        priorOutputs: { review: okOutput(verdict) },
      }),
    );
    expect(loopOut?.value).toBe(true);
  });

  test("single-iteration red CI + approve -> final reviewer NodeOutput.value is revise", async () => {
    // The key invariant: the NodeOutput.value.verdict on the final reviewer
    // output must reflect the auto-rewritten verdict, NOT the raw model
    // output. A downstream sink keying on verdict must see 'revise'.
    const reviewerScripts: FakeAdapterScript[] = [{ finalAssistantText: fencedJson(APPROVE) }];
    const { registry } = wire({
      reviewerScripts,
      ciRun: async () => redGate("run-red", "boom"),
      maxIterations: 1,
    });
    const reviewerRunner = registry.get("reviewer");
    const out = await reviewerRunner?.(
      buildCtx({
        nodeKey: "review",
        initial: { task: "t", repoContext: "ctx" },
        priorOutputs: {
          plan: okOutput(PLAN),
          execute: okOutput(EXEC),
          ci: ciRedOutput("red-1", "boom"),
        },
      }),
    );
    expect(out?.ok).toBe(true);
    const value = out?.value as ReviewerVerdict;
    expect(value.verdict).toBe("revise");
    expect(value.concerns[0]).toMatch(/approve against red CI is not permitted/);
  });
});
