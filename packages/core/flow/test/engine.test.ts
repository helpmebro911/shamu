import { newWorkflowRunId } from "@shamu/shared/ids";
import { describe, expect, it } from "vitest";
import { EventBus } from "../src/bus.ts";
import { FlowEngine } from "../src/engine.ts";
import type { FlowEvent } from "../src/events.ts";
import { type Runner, RunnerRegistry } from "../src/runners.ts";
import type { FlowRunState } from "../src/state.ts";
import type {
  AgentStep,
  Conditional,
  FlowDefinition,
  HumanGate,
  Loop,
  NodeOutput,
} from "../src/types.ts";
import { nodeId } from "../src/types.ts";

/** Build a NodeOutput with sensible defaults. */
function okOutput(
  value: unknown,
  opts: Partial<Pick<NodeOutput, "costUsd" | "costConfidence" | "costSource">> = {},
): NodeOutput {
  return {
    ok: true,
    value,
    costUsd: opts.costUsd ?? null,
    costConfidence: opts.costConfidence ?? "unknown",
    costSource: opts.costSource ?? "test",
  };
}

function failOutput(message: string, retriable: boolean): NodeOutput {
  return {
    ok: false,
    value: null,
    costUsd: null,
    costConfidence: "unknown",
    costSource: "test",
    error: { message, retriable },
  };
}

interface Harness {
  readonly engine: FlowEngine;
  readonly registry: RunnerRegistry;
  readonly bus: EventBus<FlowEvent>;
  readonly events: FlowEvent[];
  readonly flowRunId: ReturnType<typeof newWorkflowRunId>;
  tick(): number;
}

function makeHarness(): Harness {
  const registry = new RunnerRegistry();
  const bus = new EventBus<FlowEvent>();
  const events: FlowEvent[] = [];
  bus.subscribe((ev) => events.push(ev));
  let t = 0;
  const now = () => {
    t += 1;
    return t;
  };
  const engine = new FlowEngine({ registry, bus, now });
  return { engine, registry, bus, events, flowRunId: newWorkflowRunId(), tick: now };
}

describe("FlowEngine — linear DAG", () => {
  it("runs a two-node DAG in topological order and publishes events", async () => {
    const h = makeHarness();
    const a: AgentStep = {
      kind: "agent_step",
      id: nodeId("a"),
      role: "planner",
      runner: "fake",
      inputs: {},
      dependsOn: [],
    };
    const b: AgentStep = {
      kind: "agent_step",
      id: nodeId("b"),
      role: "executor",
      runner: "fake",
      inputs: {},
      dependsOn: [nodeId("a")],
    };
    const calls: string[] = [];
    const runner: Runner = async (ctx) => {
      calls.push(String(ctx.node.id));
      return okOutput(`${String(ctx.node.id)}-done`);
    };
    h.registry.register("fake", runner);

    const def: FlowDefinition = {
      id: "linear",
      version: 1,
      nodes: [a, b],
      entry: nodeId("a"),
    };
    const state = await h.engine.run(def, { flowRunId: h.flowRunId });

    expect(calls).toEqual(["a", "b"]);
    expect(state.nodeStatus).toEqual({ a: "succeeded", b: "succeeded" });
    const kinds = h.events.map((e) => e.kind);
    expect(kinds[0]).toBe("flow_started");
    expect(kinds[kinds.length - 1]).toBe("flow_completed");
    // Started-a, Completed-a, Started-b, Completed-b ordering.
    const perNode = kinds.filter((k) => k === "node_started" || k === "node_completed");
    expect(perNode).toEqual(["node_started", "node_completed", "node_started", "node_completed"]);
    const done = h.events.find((e) => e.kind === "flow_completed");
    expect(done?.kind === "flow_completed" && done.status).toBe("succeeded");
  });
});

describe("FlowEngine — conditional branching", () => {
  it("executes only the selected branch", async () => {
    const h = makeHarness();
    const cond: Conditional = {
      kind: "conditional",
      id: nodeId("c"),
      predicate: "predicate",
      trueBranch: nodeId("t"),
      falseBranch: nodeId("f"),
      dependsOn: [],
    };
    const tNode: AgentStep = {
      kind: "agent_step",
      id: nodeId("t"),
      role: "x",
      runner: "echo",
      inputs: {},
      dependsOn: [nodeId("c")],
    };
    const fNode: AgentStep = {
      kind: "agent_step",
      id: nodeId("f"),
      role: "x",
      runner: "echo",
      inputs: {},
      dependsOn: [nodeId("c")],
    };
    const ran: string[] = [];
    h.registry.register("predicate", async () => okOutput(true));
    h.registry.register("echo", async (ctx) => {
      ran.push(String(ctx.node.id));
      return okOutput("ok");
    });
    const state = await h.engine.run(
      { id: "c", version: 1, nodes: [cond, tNode, fNode], entry: nodeId("c") },
      { flowRunId: h.flowRunId },
    );
    expect(ran).toEqual(["t"]);
    expect(state.nodeStatus.t).toBe("succeeded");
    // Unselected branch stays pending (never visited).
    expect(state.nodeStatus.f).toBeUndefined();
  });

  it("executes the false branch when predicate returns false", async () => {
    const h = makeHarness();
    const cond: Conditional = {
      kind: "conditional",
      id: nodeId("c"),
      predicate: "predicate",
      trueBranch: nodeId("t"),
      falseBranch: nodeId("f"),
      dependsOn: [],
    };
    const tNode: AgentStep = {
      kind: "agent_step",
      id: nodeId("t"),
      role: "x",
      runner: "echo",
      inputs: {},
      dependsOn: [nodeId("c")],
    };
    const fNode: AgentStep = {
      kind: "agent_step",
      id: nodeId("f"),
      role: "x",
      runner: "echo",
      inputs: {},
      dependsOn: [nodeId("c")],
    };
    const ran: string[] = [];
    h.registry.register("predicate", async () => okOutput(false));
    h.registry.register("echo", async (ctx) => {
      ran.push(String(ctx.node.id));
      return okOutput("ok");
    });
    const state = await h.engine.run(
      { id: "c", version: 1, nodes: [cond, tNode, fNode], entry: nodeId("c") },
      { flowRunId: h.flowRunId },
    );
    expect(ran).toEqual(["f"]);
    expect(state.nodeStatus.f).toBe("succeeded");
  });
});

describe("FlowEngine — loop", () => {
  it("iterates until the predicate is satisfied", async () => {
    const h = makeHarness();
    const loop: Loop = {
      kind: "loop",
      id: nodeId("l"),
      body: [],
      until: "until",
      maxIterations: 5,
      dependsOn: [],
    };
    let iters = 0;
    h.registry.register("until", async () => {
      iters += 1;
      return okOutput(iters === 3);
    });
    const state = await h.engine.run(
      { id: "l", version: 1, nodes: [loop], entry: nodeId("l") },
      { flowRunId: h.flowRunId },
    );
    expect(iters).toBe(3);
    expect(state.nodeStatus.l).toBe("succeeded");
  });

  it("stops at maxIterations when the predicate never flips", async () => {
    const h = makeHarness();
    const loop: Loop = {
      kind: "loop",
      id: nodeId("l"),
      body: [],
      until: "until",
      maxIterations: 4,
      dependsOn: [],
    };
    let iters = 0;
    h.registry.register("until", async () => {
      iters += 1;
      return okOutput(false);
    });
    const state = await h.engine.run(
      { id: "l", version: 1, nodes: [loop], entry: nodeId("l") },
      { flowRunId: h.flowRunId },
    );
    expect(iters).toBe(4);
    expect(state.nodeStatus.l).toBe("succeeded");
  });
});

describe("FlowEngine — human gate", () => {
  it("pauses on gate and resumes past it with initial input", async () => {
    const h = makeHarness();
    const gate: HumanGate = {
      kind: "human_gate",
      id: nodeId("g"),
      prompt: "approve?",
      resumeToken: "approve_token",
      dependsOn: [],
    };
    const after: AgentStep = {
      kind: "agent_step",
      id: nodeId("after"),
      role: "x",
      runner: "echo",
      inputs: {},
      dependsOn: [nodeId("g")],
    };
    const ran: string[] = [];
    h.registry.register("echo", async (ctx) => {
      ran.push(String(ctx.node.id));
      return okOutput("done");
    });

    const paused = await h.engine.run(
      { id: "hg", version: 1, nodes: [gate, after], entry: nodeId("g") },
      { flowRunId: h.flowRunId },
    );
    expect(ran).toEqual([]);
    expect(paused.pendingGate).toEqual({ nodeId: "g", resumeToken: "approve_token" });
    const pauseEvent = h.events.find((e) => e.kind === "flow_completed");
    expect(pauseEvent?.kind === "flow_completed" && pauseEvent.status).toBe("paused");
    expect(h.events.some((e) => e.kind === "human_gate_reached")).toBe(true);

    // Resume with the human input surfaced.
    const resumed = await h.engine.run(
      { id: "hg", version: 1, nodes: [gate, after], entry: nodeId("g") },
      {
        flowRunId: newWorkflowRunId(),
        initialInputs: { approve_token: { approved: true } },
        resumeFrom: paused,
      },
    );
    expect(ran).toEqual(["after"]);
    expect(resumed.pendingGate).toBeNull();
    expect(resumed.nodeStatus.g).toBe("succeeded");
    expect(resumed.nodeStatus.after).toBe("succeeded");
  });
});

describe("FlowEngine — retries", () => {
  it("succeeds after retriable failures within budget", async () => {
    const h = makeHarness();
    const step: AgentStep = {
      kind: "agent_step",
      id: nodeId("s"),
      role: "x",
      runner: "flaky",
      inputs: {},
      dependsOn: [],
      maxRetries: 2,
    };
    let calls = 0;
    h.registry.register("flaky", async () => {
      calls += 1;
      if (calls < 3) return failOutput("transient", true);
      return okOutput("ok");
    });
    const state = await h.engine.run(
      { id: "r", version: 1, nodes: [step], entry: nodeId("s") },
      { flowRunId: h.flowRunId },
    );
    expect(calls).toBe(3);
    expect(state.nodeStatus.s).toBe("succeeded");
    const failEvents = h.events.filter((e) => e.kind === "node_failed");
    expect(failEvents).toHaveLength(2);
    expect(failEvents.every((e) => e.kind === "node_failed" && e.willRetry === true)).toBe(true);
  });

  it("fails after retry exhaustion", async () => {
    const h = makeHarness();
    const step: AgentStep = {
      kind: "agent_step",
      id: nodeId("s"),
      role: "x",
      runner: "flaky",
      inputs: {},
      dependsOn: [],
      maxRetries: 2,
    };
    let calls = 0;
    h.registry.register("flaky", async () => {
      calls += 1;
      return failOutput("nope", true);
    });
    const state = await h.engine.run(
      { id: "r", version: 1, nodes: [step], entry: nodeId("s") },
      { flowRunId: h.flowRunId },
    );
    expect(calls).toBe(3);
    expect(state.nodeStatus.s).toBe("failed");
    const failEvents = h.events.filter((e) => e.kind === "node_failed");
    expect(failEvents).toHaveLength(3);
    const last = failEvents[failEvents.length - 1];
    expect(last?.kind === "node_failed" && last.willRetry).toBe(false);
    const done = h.events.find((e) => e.kind === "flow_completed");
    expect(done?.kind === "flow_completed" && done.status).toBe("failed");
  });

  it("does not retry on non-retriable failure", async () => {
    const h = makeHarness();
    const step: AgentStep = {
      kind: "agent_step",
      id: nodeId("s"),
      role: "x",
      runner: "fatal",
      inputs: {},
      dependsOn: [],
      maxRetries: 5,
    };
    let calls = 0;
    h.registry.register("fatal", async () => {
      calls += 1;
      return failOutput("hard no", false);
    });
    const state = await h.engine.run(
      { id: "r", version: 1, nodes: [step], entry: nodeId("s") },
      { flowRunId: h.flowRunId },
    );
    expect(calls).toBe(1);
    expect(state.nodeStatus.s).toBe("failed");
  });

  it("treats a thrown runner as non-retriable", async () => {
    const h = makeHarness();
    const step: AgentStep = {
      kind: "agent_step",
      id: nodeId("s"),
      role: "x",
      runner: "throws",
      inputs: {},
      dependsOn: [],
      maxRetries: 5,
    };
    let calls = 0;
    h.registry.register("throws", async () => {
      calls += 1;
      throw new Error("boom");
    });
    const state = await h.engine.run(
      { id: "r", version: 1, nodes: [step], entry: nodeId("s") },
      { flowRunId: h.flowRunId },
    );
    expect(calls).toBe(1);
    expect(state.nodeStatus.s).toBe("failed");
  });
});

describe("FlowEngine — content-hash cache", () => {
  it("short-circuits on identical inputs with prior state", async () => {
    const h = makeHarness();
    const step: AgentStep = {
      kind: "agent_step",
      id: nodeId("s"),
      role: "x",
      runner: "count",
      inputs: { seed: 1 },
      dependsOn: [],
    };
    let calls = 0;
    h.registry.register("count", async () => {
      calls += 1;
      return okOutput(`call-${calls}`);
    });
    const first = await h.engine.run(
      { id: "c", version: 1, nodes: [step], entry: nodeId("s") },
      { flowRunId: h.flowRunId },
    );
    expect(calls).toBe(1);
    // Replay with the same inputs + resumed state.
    const second = await h.engine.run(
      { id: "c", version: 1, nodes: [step], entry: nodeId("s") },
      { flowRunId: newWorkflowRunId(), resumeFrom: first },
    );
    expect(calls).toBe(1);
    expect(second.nodeStatus.s).toBe("succeeded");
    const cachedEvent = h.events
      .filter((e) => e.kind === "node_completed")
      .find((e) => e.kind === "node_completed" && e.cached === true);
    expect(cachedEvent).toBeDefined();
  });

  it("re-runs the node when static inputs change", async () => {
    const h = makeHarness();
    const step1: AgentStep = {
      kind: "agent_step",
      id: nodeId("s"),
      role: "x",
      runner: "count",
      inputs: { seed: 1 },
      dependsOn: [],
    };
    const step2: AgentStep = { ...step1, inputs: { seed: 2 } };
    let calls = 0;
    h.registry.register("count", async () => {
      calls += 1;
      return okOutput(`call-${calls}`);
    });
    const first = await h.engine.run(
      { id: "c", version: 1, nodes: [step1], entry: nodeId("s") },
      { flowRunId: h.flowRunId },
    );
    expect(calls).toBe(1);
    await h.engine.run(
      { id: "c", version: 1, nodes: [step2], entry: nodeId("s") },
      { flowRunId: newWorkflowRunId(), resumeFrom: first },
    );
    expect(calls).toBe(2);
  });

  it("re-runs when initialInputs change", async () => {
    const h = makeHarness();
    const step: AgentStep = {
      kind: "agent_step",
      id: nodeId("s"),
      role: "x",
      runner: "count",
      inputs: {},
      dependsOn: [],
    };
    let calls = 0;
    h.registry.register("count", async () => {
      calls += 1;
      return okOutput(`call-${calls}`);
    });
    const first = await h.engine.run(
      { id: "c", version: 1, nodes: [step], entry: nodeId("s") },
      { flowRunId: h.flowRunId, initialInputs: { q: "a" } },
    );
    expect(calls).toBe(1);
    await h.engine.run(
      { id: "c", version: 1, nodes: [step], entry: nodeId("s") },
      { flowRunId: newWorkflowRunId(), initialInputs: { q: "b" }, resumeFrom: first },
    );
    expect(calls).toBe(2);
  });
});

describe("FlowEngine — cost rollup", () => {
  it("sums non-null samples and collapses confidence labels to 'mixed'", async () => {
    const h = makeHarness();
    const a: AgentStep = {
      kind: "agent_step",
      id: nodeId("a"),
      role: "x",
      runner: "cost_exact",
      inputs: {},
      dependsOn: [],
    };
    const b: AgentStep = {
      kind: "agent_step",
      id: nodeId("b"),
      role: "x",
      runner: "cost_est",
      inputs: {},
      dependsOn: [nodeId("a")],
    };
    const c: AgentStep = {
      kind: "agent_step",
      id: nodeId("c"),
      role: "x",
      runner: "cost_none",
      inputs: {},
      dependsOn: [nodeId("b")],
    };
    h.registry.register("cost_exact", async () =>
      okOutput("ok", { costUsd: 0.1, costConfidence: "exact", costSource: "vendor" }),
    );
    h.registry.register("cost_est", async () =>
      okOutput("ok", { costUsd: 0.05, costConfidence: "estimate", costSource: "computed" }),
    );
    h.registry.register("cost_none", async () =>
      okOutput("ok", { costUsd: null, costConfidence: "unknown", costSource: "subscription" }),
    );
    const state = await h.engine.run(
      { id: "cost", version: 1, nodes: [a, b, c], entry: nodeId("a") },
      { flowRunId: h.flowRunId },
    );
    expect(state.totalCostUsd).toBeCloseTo(0.15, 6);
    const done = h.events.find((e) => e.kind === "flow_completed");
    expect(done?.kind === "flow_completed" && done.costConfidence).toBe("mixed");
  });

  it("reports 'unknown' when every sample is null", async () => {
    const h = makeHarness();
    const a: AgentStep = {
      kind: "agent_step",
      id: nodeId("a"),
      role: "x",
      runner: "none",
      inputs: {},
      dependsOn: [],
    };
    h.registry.register("none", async () =>
      okOutput("ok", { costUsd: null, costConfidence: "unknown", costSource: "subscription" }),
    );
    const state = await h.engine.run(
      { id: "c", version: 1, nodes: [a], entry: nodeId("a") },
      { flowRunId: h.flowRunId },
    );
    expect(state.totalCostUsd).toBeNull();
    const done = h.events.find((e) => e.kind === "flow_completed");
    expect(done?.kind === "flow_completed" && done.costConfidence).toBe("unknown");
  });
});

describe("FlowEngine — graph validation", () => {
  it("throws on cycles before running any node", async () => {
    const h = makeHarness();
    const a: AgentStep = {
      kind: "agent_step",
      id: nodeId("a"),
      role: "x",
      runner: "fake",
      inputs: {},
      dependsOn: [nodeId("b")],
    };
    const b: AgentStep = {
      kind: "agent_step",
      id: nodeId("b"),
      role: "x",
      runner: "fake",
      inputs: {},
      dependsOn: [nodeId("a")],
    };
    let calls = 0;
    h.registry.register("fake", async () => {
      calls += 1;
      return okOutput("ok");
    });
    await expect(
      h.engine.run(
        { id: "c", version: 1, nodes: [a, b], entry: nodeId("a") },
        { flowRunId: h.flowRunId },
      ),
    ).rejects.toThrow(/cycle/);
    expect(calls).toBe(0);
  });

  it("throws on duplicate node ids", async () => {
    const h = makeHarness();
    const a: AgentStep = {
      kind: "agent_step",
      id: nodeId("a"),
      role: "x",
      runner: "fake",
      inputs: {},
      dependsOn: [],
    };
    const dup: AgentStep = { ...a };
    h.registry.register("fake", async () => okOutput("ok"));
    await expect(
      h.engine.run(
        { id: "c", version: 1, nodes: [a, dup], entry: nodeId("a") },
        { flowRunId: h.flowRunId },
      ),
    ).rejects.toThrow(/duplicate/);
  });

  it("throws on unknown entry", async () => {
    const h = makeHarness();
    const a: AgentStep = {
      kind: "agent_step",
      id: nodeId("a"),
      role: "x",
      runner: "fake",
      inputs: {},
      dependsOn: [],
    };
    h.registry.register("fake", async () => okOutput("ok"));
    await expect(
      h.engine.run(
        { id: "c", version: 1, nodes: [a], entry: nodeId("missing") },
        { flowRunId: h.flowRunId },
      ),
    ).rejects.toThrow(/entry/);
  });

  it("throws on unknown dependency", async () => {
    const h = makeHarness();
    const a: AgentStep = {
      kind: "agent_step",
      id: nodeId("a"),
      role: "x",
      runner: "fake",
      inputs: {},
      dependsOn: [nodeId("ghost")],
    };
    h.registry.register("fake", async () => okOutput("ok"));
    await expect(
      h.engine.run(
        { id: "c", version: 1, nodes: [a], entry: nodeId("a") },
        { flowRunId: h.flowRunId },
      ),
    ).rejects.toThrow(/unknown node/);
  });
});

describe("FlowEngine — abort signal", () => {
  it("stops pending nodes when cancelled between steps", async () => {
    const h = makeHarness();
    const controller = new AbortController();
    const a: AgentStep = {
      kind: "agent_step",
      id: nodeId("a"),
      role: "x",
      runner: "firstThenAbort",
      inputs: {},
      dependsOn: [],
    };
    const b: AgentStep = {
      kind: "agent_step",
      id: nodeId("b"),
      role: "x",
      runner: "neverCalled",
      inputs: {},
      dependsOn: [nodeId("a")],
    };
    let bCalls = 0;
    h.registry.register("firstThenAbort", async () => {
      controller.abort();
      return okOutput("done");
    });
    h.registry.register("neverCalled", async () => {
      bCalls += 1;
      return okOutput("nope");
    });
    const state = await h.engine.run(
      { id: "abort", version: 1, nodes: [a, b], entry: nodeId("a") },
      { flowRunId: h.flowRunId, signal: controller.signal },
    );
    expect(bCalls).toBe(0);
    expect(state.nodeStatus.a).toBe("succeeded");
    expect(state.nodeStatus.b).toBeDefined();
    expect(state.nodeStatus.b).toBe("pending");
    const done = h.events.find((e) => e.kind === "flow_completed");
    expect(done?.kind === "flow_completed" && done.status).toBe("failed");
  });
});

describe("FlowEngine — runner miss", () => {
  it("fails the flow with a clear error when the runner key is unregistered", async () => {
    const h = makeHarness();
    const a: AgentStep = {
      kind: "agent_step",
      id: nodeId("a"),
      role: "x",
      runner: "does_not_exist",
      inputs: {},
      dependsOn: [],
    };
    // Note: engine throws from the executor loop catch block; the
    // overall promise resolves with status failed because the engine
    // handles the error as flow-level terminal.
    const state = await h.engine.run(
      { id: "miss", version: 1, nodes: [a], entry: nodeId("a") },
      { flowRunId: h.flowRunId },
    );
    const done = h.events.find((e) => e.kind === "flow_completed");
    expect(done?.kind === "flow_completed" && done.status).toBe("failed");
    expect(state.nodeStatus.a).toBe("failed");
  });
});

describe("FlowEngine — confidence rollup variants", () => {
  it("reports 'exact' when every sample is exact", async () => {
    const h = makeHarness();
    const a: AgentStep = {
      kind: "agent_step",
      id: nodeId("a"),
      role: "x",
      runner: "ex",
      inputs: {},
      dependsOn: [],
    };
    h.registry.register("ex", async () =>
      okOutput("ok", { costUsd: 0.1, costConfidence: "exact", costSource: "vendor" }),
    );
    await h.engine.run(
      { id: "c", version: 1, nodes: [a], entry: nodeId("a") },
      { flowRunId: h.flowRunId },
    );
    const done = h.events.find((e) => e.kind === "flow_completed");
    expect(done?.kind === "flow_completed" && done.costConfidence).toBe("exact");
  });

  it("reports 'estimate' when every sample is estimate", async () => {
    const h = makeHarness();
    const a: AgentStep = {
      kind: "agent_step",
      id: nodeId("a"),
      role: "x",
      runner: "es",
      inputs: {},
      dependsOn: [],
    };
    h.registry.register("es", async () =>
      okOutput("ok", { costUsd: 0.1, costConfidence: "estimate", costSource: "computed" }),
    );
    await h.engine.run(
      { id: "c", version: 1, nodes: [a], entry: nodeId("a") },
      { flowRunId: h.flowRunId },
    );
    const done = h.events.find((e) => e.kind === "flow_completed");
    expect(done?.kind === "flow_completed" && done.costConfidence).toBe("estimate");
  });
});

describe("FlowEngine — loop predicate errors", () => {
  it("fails the flow when the loop predicate returns ok=false", async () => {
    const h = makeHarness();
    const loop: Loop = {
      kind: "loop",
      id: nodeId("l"),
      body: [],
      until: "broken",
      maxIterations: 5,
      dependsOn: [],
    };
    h.registry.register("broken", async () => failOutput("nope", false));
    const state = await h.engine.run(
      { id: "l", version: 1, nodes: [loop], entry: nodeId("l") },
      { flowRunId: h.flowRunId },
    );
    expect(state.nodeStatus.l).toBe("failed");
    const done = h.events.find((e) => e.kind === "flow_completed");
    expect(done?.kind === "flow_completed" && done.status).toBe("failed");
  });

  it("fails the flow when the loop predicate throws", async () => {
    const h = makeHarness();
    const loop: Loop = {
      kind: "loop",
      id: nodeId("l"),
      body: [],
      until: "boom",
      maxIterations: 5,
      dependsOn: [],
    };
    h.registry.register("boom", async () => {
      throw new Error("loop fault");
    });
    const state = await h.engine.run(
      { id: "l", version: 1, nodes: [loop], entry: nodeId("l") },
      { flowRunId: h.flowRunId },
    );
    expect(state.nodeStatus.l).toBe("failed");
  });
});

describe("FlowEngine — conditional error paths", () => {
  it("fails the flow when the predicate throws", async () => {
    const h = makeHarness();
    const cond: Conditional = {
      kind: "conditional",
      id: nodeId("c"),
      predicate: "bad",
      trueBranch: nodeId("t"),
      falseBranch: nodeId("f"),
      dependsOn: [],
    };
    const tNode: AgentStep = {
      kind: "agent_step",
      id: nodeId("t"),
      role: "x",
      runner: "echo",
      inputs: {},
      dependsOn: [nodeId("c")],
    };
    const fNode: AgentStep = {
      kind: "agent_step",
      id: nodeId("f"),
      role: "x",
      runner: "echo",
      inputs: {},
      dependsOn: [nodeId("c")],
    };
    h.registry.register("bad", async () => {
      throw new Error("pred boom");
    });
    h.registry.register("echo", async () => okOutput("ok"));
    const state = await h.engine.run(
      { id: "ce", version: 1, nodes: [cond, tNode, fNode], entry: nodeId("c") },
      { flowRunId: h.flowRunId },
    );
    expect(state.nodeStatus.c).toBe("failed");
  });

  it("fails the flow when the predicate returns ok=false", async () => {
    const h = makeHarness();
    const cond: Conditional = {
      kind: "conditional",
      id: nodeId("c"),
      predicate: "bad",
      trueBranch: nodeId("t"),
      falseBranch: nodeId("f"),
      dependsOn: [],
    };
    const tNode: AgentStep = {
      kind: "agent_step",
      id: nodeId("t"),
      role: "x",
      runner: "echo",
      inputs: {},
      dependsOn: [nodeId("c")],
    };
    const fNode: AgentStep = {
      kind: "agent_step",
      id: nodeId("f"),
      role: "x",
      runner: "echo",
      inputs: {},
      dependsOn: [nodeId("c")],
    };
    h.registry.register("bad", async () => failOutput("pred rejects", false));
    h.registry.register("echo", async () => okOutput("ok"));
    const state = await h.engine.run(
      { id: "ce", version: 1, nodes: [cond, tNode, fNode], entry: nodeId("c") },
      { flowRunId: h.flowRunId },
    );
    expect(state.nodeStatus.c).toBe("failed");
  });
});

describe("FlowEngine — runner registry", () => {
  it("register rejects empty keys and duplicates", () => {
    const r = new RunnerRegistry();
    expect(() => r.register("", async () => okOutput("x"))).toThrow(/non-empty/);
    r.register("k", async () => okOutput("x"));
    expect(() => r.register("k", async () => okOutput("y"))).toThrow(/duplicate/);
    expect(r.has("k")).toBe(true);
    expect(r.has("missing")).toBe(false);
    r.unregister("k");
    expect(r.has("k")).toBe(false);
    expect(r.get("nope")).toBeNull();
  });
});

describe("FlowEngine — resume with state", () => {
  it("round-trips through serialize/deserialize between passes", async () => {
    const h = makeHarness();
    const a: AgentStep = {
      kind: "agent_step",
      id: nodeId("a"),
      role: "x",
      runner: "echo",
      inputs: { n: 1 },
      dependsOn: [],
    };
    const b: AgentStep = {
      kind: "agent_step",
      id: nodeId("b"),
      role: "x",
      runner: "echo",
      inputs: { n: 2 },
      dependsOn: [nodeId("a")],
    };
    let calls = 0;
    h.registry.register("echo", async () => {
      calls += 1;
      return okOutput(`c${calls}`);
    });
    const after = await h.engine.run(
      { id: "r", version: 1, nodes: [a, b], entry: nodeId("a") },
      { flowRunId: h.flowRunId },
    );
    expect(calls).toBe(2);
    // Snapshot: serialize + deserialize to prove persistence compatibility.
    const { serialize, deserialize } = await import("../src/state.ts");
    const round: FlowRunState = deserialize(serialize(after));
    // Replay the same inputs against the round-tripped state.
    await h.engine.run(
      { id: "r", version: 1, nodes: [a, b], entry: nodeId("a") },
      { flowRunId: newWorkflowRunId(), resumeFrom: round },
    );
    // Neither node re-ran.
    expect(calls).toBe(2);
  });
});
