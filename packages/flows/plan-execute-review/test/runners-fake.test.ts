/**
 * Runner tests using the in-test fake adapters.
 *
 * Tests the planner/executor/reviewer/loop-predicate runners with the
 * `__adapterOverride` seam so no real vendor CLI is touched. Covers the
 * reviewer-internal revise->retry loop and the loop-predicate's terminal
 * semantics.
 */

import type { RunnerContext } from "@shamu/core-flow/runners";
import { RunnerRegistry } from "@shamu/core-flow/runners";
import type { NodeId, NodeOutput } from "@shamu/core-flow/types";
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
import type { FakeAdapterScript } from "./_fake-adapter.ts";
import { FAKE_CLAUDE_CAPS, FAKE_CODEX_CAPS, FakeAdapter, fencedJson } from "./_fake-adapter.ts";

const SAMPLE_PLAN: PlannerOutput = {
  goal: "add a readme heading",
  steps: [{ id: "s1", description: "insert heading", filesTouched: ["README.md"] }],
  assumptions: [],
};

const SAMPLE_EXEC: ExecutorOutput = {
  summary: "inserted the heading",
  diffStats: { added: 1, removed: 0, files: ["README.md"] },
  notes: "",
};

const APPROVE: ReviewerModelOutput = {
  verdict: "approve",
  feedback: "looks good",
  concerns: [],
};

const REVISE: ReviewerModelOutput = {
  verdict: "revise",
  feedback: "missing the table of contents update",
  concerns: ["toc stale"],
};

/** Helper: build a runnerContext matching one of our four node ids. */
function buildCtx(params: {
  readonly nodeKey: "plan" | "execute" | "review" | "loop";
  readonly initial?: Record<string, unknown>;
  readonly priorOutputs?: Record<string, NodeOutput>;
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

function okOutput(value: unknown, overrides: Partial<NodeOutput> = {}): NodeOutput {
  return {
    ok: true,
    value,
    costUsd: null,
    costConfidence: "unknown",
    costSource: "test",
    ...overrides,
  };
}

interface BuildRegistryInput {
  readonly planner?: FakeAdapterScript | (() => FakeAdapterScript);
  readonly executor?: FakeAdapterScript | ((idx: number) => FakeAdapterScript);
  readonly reviewer?: FakeAdapterScript | ((idx: number) => FakeAdapterScript);
  readonly maxIterations?: number;
}

interface BuildRegistryResult {
  readonly registry: RunnerRegistry;
  readonly plannerAdapter: FakeAdapter;
  readonly executorAdapter: FakeAdapter;
  readonly reviewerAdapter: FakeAdapter;
}

function buildRegistry(input: BuildRegistryInput): BuildRegistryResult {
  const plannerScript = scriptFnFrom(input.planner ?? { finalAssistantText: "" });
  const executorScript = scriptFnFrom(input.executor ?? { finalAssistantText: "" });
  const reviewerScript = scriptFnFrom(input.reviewer ?? { finalAssistantText: "" });

  const plannerAdapter = new FakeAdapter({
    vendor: "codex",
    capabilities: FAKE_CODEX_CAPS,
    scriptFor: plannerScript,
  });
  const executorAdapter = new FakeAdapter({
    vendor: "claude",
    capabilities: FAKE_CLAUDE_CAPS,
    scriptFor: executorScript,
  });
  const reviewerAdapter = new FakeAdapter({
    vendor: "codex",
    capabilities: FAKE_CODEX_CAPS,
    scriptFor: reviewerScript,
  });
  const registry = new RunnerRegistry();
  const override: AdapterOverride = {
    plannerAdapter: () => plannerAdapter,
    executorAdapter: () => executorAdapter,
    reviewerAdapter: () => reviewerAdapter,
  };
  registerRunners(registry, {
    workspaceCwd: "/tmp/shamu-fake",
    __adapterOverride: override,
    ...(input.maxIterations !== undefined ? { maxIterations: input.maxIterations } : {}),
  });
  return { registry, plannerAdapter, executorAdapter, reviewerAdapter };
}

function scriptFnFrom(
  src: FakeAdapterScript | ((idx: number) => FakeAdapterScript),
): (idx: number) => FakeAdapterScript {
  return typeof src === "function" ? src : () => src;
}

describe("planner runner", () => {
  test("parses a fenced-json planner response into PlannerOutput", async () => {
    const { registry, plannerAdapter } = buildRegistry({
      planner: { finalAssistantText: fencedJson(SAMPLE_PLAN) },
    });
    const runner = registry.get("planner");
    expect(runner).not.toBeNull();
    const out = await runner?.(
      buildCtx({
        nodeKey: "plan",
        initial: { task: "t", repoContext: "ctx" },
      }),
    );
    expect(out?.ok).toBe(true);
    expect(out?.value).toEqual(SAMPLE_PLAN);
    // Codex subscription cost reporting -> null + unknown.
    expect(out?.costUsd).toBeNull();
    expect(out?.costConfidence).toBe("unknown");
    expect(out?.costSource).toBe("codex-subscription");
    // Sanity: the fake adapter was actually spawned once with the workspace cwd.
    expect(plannerAdapter.spawnCount).toBe(1);
    expect(plannerAdapter.handles[0]?.lastSpawnOpts.cwd).toBe("/tmp/shamu-fake");
    expect(plannerAdapter.handles[0]?.lastSpawnOpts.model).toBe("gpt-5.4");
  });

  test("throws with a clear message when the model omits a json block", async () => {
    const { registry } = buildRegistry({
      planner: { finalAssistantText: "no json block here" },
    });
    const runner = registry.get("planner");
    await expect(
      runner?.(buildCtx({ nodeKey: "plan", initial: { task: "t", repoContext: "ctx" } })),
    ).rejects.toThrow(/no fenced `json` block/);
  });

  test("throws when initial inputs are missing", async () => {
    const { registry } = buildRegistry({
      planner: { finalAssistantText: fencedJson(SAMPLE_PLAN) },
    });
    const runner = registry.get("planner");
    await expect(runner?.(buildCtx({ nodeKey: "plan", initial: { task: "t" } }))).rejects.toThrow(
      /repoContext/,
    );
  });
});

describe("executor runner", () => {
  test("sums cost events from fake Claude adapter as exact + source=vendor", async () => {
    const { registry, executorAdapter } = buildRegistry({
      executor: {
        finalAssistantText: fencedJson(SAMPLE_EXEC),
        costSamples: [
          { usd: 0.12, confidence: "exact", source: "vendor" },
          { usd: 0.03, confidence: "exact", source: "vendor" },
        ],
      },
    });
    const runner = registry.get("executor");
    const out = await runner?.(
      buildCtx({
        nodeKey: "execute",
        initial: { task: "t", repoContext: "ctx" },
        priorOutputs: { plan: okOutput(SAMPLE_PLAN) },
      }),
    );
    expect(out?.ok).toBe(true);
    expect(out?.value).toEqual(SAMPLE_EXEC);
    expect(out?.costUsd).toBeCloseTo(0.15, 5);
    expect(out?.costConfidence).toBe("exact");
    expect(out?.costSource).toBe("vendor");
    expect(executorAdapter.spawnCount).toBe(1);
    expect(executorAdapter.handles[0]?.lastSpawnOpts.model).toBe("claude-opus-4-7");
  });

  test("reports costConfidence=unknown when no cost events arrive", async () => {
    const { registry } = buildRegistry({
      executor: { finalAssistantText: fencedJson(SAMPLE_EXEC) },
    });
    const runner = registry.get("executor");
    const out = await runner?.(
      buildCtx({
        nodeKey: "execute",
        initial: { task: "t", repoContext: "ctx" },
        priorOutputs: { plan: okOutput(SAMPLE_PLAN) },
      }),
    );
    expect(out?.ok).toBe(true);
    expect(out?.costUsd).toBeNull();
    expect(out?.costConfidence).toBe("unknown");
  });

  test("throws if the prior planner output is missing from priorOutputs", async () => {
    const { registry } = buildRegistry({
      executor: { finalAssistantText: fencedJson(SAMPLE_EXEC) },
    });
    const runner = registry.get("executor");
    await expect(
      runner?.(buildCtx({ nodeKey: "execute", initial: { task: "t", repoContext: "ctx" } })),
    ).rejects.toThrow(/missing successful 'plan'/);
  });
});

describe("reviewer runner", () => {
  test("approve on first pass returns iterationsUsed=1 without re-invoking executor", async () => {
    const { registry, executorAdapter, reviewerAdapter } = buildRegistry({
      reviewer: { finalAssistantText: fencedJson(APPROVE) },
    });
    const runner = registry.get("reviewer");
    const out = await runner?.(
      buildCtx({
        nodeKey: "review",
        initial: { task: "t", repoContext: "ctx" },
        priorOutputs: {
          plan: okOutput(SAMPLE_PLAN),
          execute: okOutput(SAMPLE_EXEC),
        },
      }),
    );
    expect(out?.ok).toBe(true);
    const verdict = out?.value as ReviewerVerdict;
    expect(verdict.verdict).toBe("approve");
    expect(verdict.iterationsUsed).toBe(1);
    expect(reviewerAdapter.spawnCount).toBe(1);
    // Executor was NOT re-invoked on an initial approve.
    expect(executorAdapter.spawnCount).toBe(0);
  });

  test("revise twice then approve -> executor called twice, iterationsUsed=3", async () => {
    const reviewerScripts: FakeAdapterScript[] = [
      { finalAssistantText: fencedJson(REVISE) },
      { finalAssistantText: fencedJson(REVISE) },
      { finalAssistantText: fencedJson(APPROVE) },
    ];
    const executorScripts: FakeAdapterScript[] = [
      { finalAssistantText: fencedJson(SAMPLE_EXEC) },
      { finalAssistantText: fencedJson(SAMPLE_EXEC) },
    ];
    const { registry, executorAdapter, reviewerAdapter } = buildRegistry({
      reviewer: (idx) => {
        const script = reviewerScripts[idx];
        if (!script) throw new Error(`unexpected reviewer spawn #${idx}`);
        return script;
      },
      executor: (idx) => {
        const script = executorScripts[idx];
        if (!script) throw new Error(`unexpected executor spawn #${idx}`);
        return script;
      },
    });
    const runner = registry.get("reviewer");
    const out = await runner?.(
      buildCtx({
        nodeKey: "review",
        initial: { task: "t", repoContext: "ctx" },
        priorOutputs: {
          plan: okOutput(SAMPLE_PLAN),
          execute: okOutput(SAMPLE_EXEC),
        },
      }),
    );
    expect(out?.ok).toBe(true);
    const verdict = out?.value as ReviewerVerdict;
    expect(verdict.verdict).toBe("approve");
    expect(verdict.iterationsUsed).toBe(3);
    expect(reviewerAdapter.spawnCount).toBe(3);
    expect(executorAdapter.spawnCount).toBe(2);
  });

  test("revise until cap -> returns revise with iterationsUsed==maxIterations", async () => {
    const maxIterations = 3;
    const { registry, executorAdapter, reviewerAdapter } = buildRegistry({
      reviewer: { finalAssistantText: fencedJson(REVISE) },
      executor: { finalAssistantText: fencedJson(SAMPLE_EXEC) },
      maxIterations,
    });
    const runner = registry.get("reviewer");
    const out = await runner?.(
      buildCtx({
        nodeKey: "review",
        initial: { task: "t", repoContext: "ctx" },
        priorOutputs: {
          plan: okOutput(SAMPLE_PLAN),
          execute: okOutput(SAMPLE_EXEC),
        },
      }),
    );
    expect(out?.ok).toBe(true);
    const verdict = out?.value as ReviewerVerdict;
    expect(verdict.verdict).toBe("revise");
    expect(verdict.iterationsUsed).toBe(maxIterations);
    expect(reviewerAdapter.spawnCount).toBe(maxIterations);
    // Executor re-invoked once per revise-not-at-cap = maxIterations - 1.
    expect(executorAdapter.spawnCount).toBe(maxIterations - 1);
  });
});

describe("loop-predicate runner", () => {
  test("returns true when reviewer approved", async () => {
    const { registry } = buildRegistry({});
    const runner = registry.get("loop-predicate");
    const verdict: ReviewerVerdict = {
      verdict: "approve",
      feedback: "ok",
      iterationsUsed: 1,
      concerns: [],
    };
    const out = await runner?.(
      buildCtx({
        nodeKey: "loop",
        priorOutputs: { review: okOutput(verdict) },
      }),
    );
    expect(out?.value).toBe(true);
  });

  test("returns true when iterationsUsed hits the cap", async () => {
    const { registry } = buildRegistry({ maxIterations: 2 });
    const runner = registry.get("loop-predicate");
    const verdict: ReviewerVerdict = {
      verdict: "revise",
      feedback: "meh",
      iterationsUsed: 2,
      concerns: [],
    };
    const out = await runner?.(
      buildCtx({
        nodeKey: "loop",
        priorOutputs: { review: okOutput(verdict) },
      }),
    );
    expect(out?.value).toBe(true);
  });

  test("returns false on revise below the cap", async () => {
    const { registry } = buildRegistry({ maxIterations: 5 });
    const runner = registry.get("loop-predicate");
    const verdict: ReviewerVerdict = {
      verdict: "revise",
      feedback: "meh",
      iterationsUsed: 1,
      concerns: [],
    };
    const out = await runner?.(
      buildCtx({
        nodeKey: "loop",
        priorOutputs: { review: okOutput(verdict) },
      }),
    );
    expect(out?.value).toBe(false);
  });

  test("returns true when no review output is present (defensive)", async () => {
    const { registry } = buildRegistry({});
    const runner = registry.get("loop-predicate");
    const out = await runner?.(buildCtx({ nodeKey: "loop" }));
    expect(out?.value).toBe(true);
    expect(out?.costUsd).toBeNull();
  });
});
