/**
 * `FlowEngine` — sequential topological executor for a typed DAG.
 *
 * PLAN.md § 8 Phase 4.A checklist:
 *   - Typed DAG node taxonomy (types.ts).
 *   - Resumable state (state.ts).
 *   - Per-node progress + cost roll-up events (events.ts + here).
 *   - Content-hashed dedupe on resume.
 *
 * Scope boundary (explicit): ParallelFanOut / Join are NOT implemented in
 * 4.A. The engine runs nodes sequentially in topological order. Parallel
 * execution lands in a later track.
 *
 * Cycle detection is a deterministic Kahn-style walk: count incoming
 * edges, emit nodes with zero remaining edges, decrement children. If
 * any node retains a non-zero count at the end, the graph has a cycle.
 *
 * Retry semantics (AgentStep only — other kinds don't retry):
 *   - attempt 1 runs first.
 *   - on a retriable failure, the engine retries up to `maxRetries`
 *     additional times (so maxRetries=2 means up to 3 total attempts).
 *   - non-retriable errors abort the flow immediately with `status: "failed"`.
 *   - retry exhaustion also aborts; the last NodeFailed has
 *     `willRetry: false`.
 *
 * Abort semantics:
 *   - The `signal` from `opts.signal` is forwarded to every runner via
 *     `RunnerContext`. When aborted, pending nodes are not started; the
 *     flow returns a terminal state with a synthetic FlowCompleted.
 *
 * Cost rollup (per PLAN § 7 and events.ts):
 *   - Null samples do not contribute to `totalCostUsd`. If EVERY sample
 *     is null, `totalCostUsd` is null.
 *   - Confidence: all exact → "exact"; all estimate → "estimate"; mix of
 *     exact+estimate → "mixed"; everything else (all unknown, all null,
 *     no samples) → "unknown".
 */

import type { WorkflowRunId } from "@shamu/shared/ids";
import type { EventBus } from "./bus.ts";
import type { FlowCostConfidence, FlowEvent } from "./events.ts";
import { contentHash } from "./hash.ts";
import type { RunnerRegistry } from "./runners.ts";
import type { CostSample, FlowRunState, NodeRuntimeStatus, PersistedNodeOutput } from "./state.ts";
import { emptyState } from "./state.ts";
import type {
  AgentStep,
  Conditional,
  FlowDefinition,
  FlowNode,
  HumanGate,
  Loop,
  NodeId,
  NodeOutput,
} from "./types.ts";

export interface FlowEngineOptions {
  readonly registry: RunnerRegistry;
  readonly bus: EventBus<FlowEvent>;
  /** Injectable clock for deterministic tests. Defaults to `Date.now`. */
  readonly now?: () => number;
}

export interface FlowRunOptions {
  readonly flowRunId: WorkflowRunId;
  readonly initialInputs?: Record<string, unknown>;
  readonly resumeFrom?: FlowRunState;
  readonly signal?: AbortSignal;
}

/** Internal shape the engine threads through its walk. */
interface MutableState {
  flowRunId: WorkflowRunId;
  flowId: string;
  version: number;
  entry: NodeId;
  nodeStatus: Record<string, NodeRuntimeStatus>;
  nodeOutputs: Record<string, PersistedNodeOutput>;
  pendingGate: { nodeId: NodeId; resumeToken: string } | null;
  startedAt: number;
  updatedAt: number;
  totalCostUsd: number | null;
  costSamples: CostSample[];
}

export class FlowEngine {
  private readonly registry: RunnerRegistry;
  private readonly bus: EventBus<FlowEvent>;
  private readonly now: () => number;

  constructor(options: FlowEngineOptions) {
    this.registry = options.registry;
    this.bus = options.bus;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Execute the flow. On a fresh run, `resumeFrom` is undefined and
   * state is empty; on a resume, state carries prior outputs + node
   * statuses, and the engine honours content-hash cache hits.
   */
  async run(def: FlowDefinition, opts: FlowRunOptions): Promise<FlowRunState> {
    const order = topologicalOrder(def);
    const state = this.initState(def, opts);
    const initialInputs = opts.initialInputs ?? {};
    const signal = opts.signal ?? new AbortController().signal;

    // Flow-started event. `resumedFrom` records the prior flowRunId so a
    // Linear rolling comment / dashboard sink can thread continuation.
    this.bus.publish({
      kind: "flow_started",
      flowRunId: state.flowRunId,
      flowId: state.flowId,
      version: state.version,
      at: this.now(),
      resumedFrom:
        opts.resumeFrom !== undefined && opts.resumeFrom.flowRunId !== state.flowRunId
          ? opts.resumeFrom.flowRunId
          : null,
    });

    // Clear any pending gate from a prior pause: if the caller resumed
    // us, the engine is about to re-walk and either hit a different
    // gate or walk past this one. Resume semantics are carried via the
    // node status + outputs map, not the pending gate marker.
    state.pendingGate = null;

    // Track nodes executed (runner invoked) this invocation vs cached
    // (short-circuit via content hash). `nodeCount` on the final
    // FlowCompleted event sums them so sinks can render "N of M nodes
    // ran this pass (K cached)".
    let nodeCount = 0;
    let loopGuard = 0;

    // Skip-set for conditional branches whose predicate selected the
    // other side. We populate it when we execute a Conditional and then
    // propagate through dependsOn edges so downstream nodes whose only
    // path was the unselected branch are skipped too.
    const skipped = new Set<string>();

    const finish = (
      status: "succeeded" | "failed" | "paused",
      cachedInThisRun: number,
    ): FlowRunState => {
      const frozen = this.freeze(state);
      const confidence = rollupConfidence(state.costSamples);
      this.bus.publish({
        kind: "flow_completed",
        flowRunId: state.flowRunId,
        at: this.now(),
        status,
        totalCostUsd: state.totalCostUsd,
        costConfidence: confidence,
        nodeCount: nodeCount + cachedInThisRun,
      });
      return frozen;
    };

    let cachedInThisRun = 0;
    // Track the node we're about to execute so a thrown runner-miss or
    // hash fault can be attributed to the right id in state + events.
    let currentNodeId: NodeId | null = null;

    try {
      for (const node of order) {
        // Bail if cancelled. Pending nodes don't start.
        if (signal.aborted) {
          state.nodeStatus[node.id] = state.nodeStatus[node.id] ?? "pending";
          return finish("failed", cachedInThisRun);
        }
        if (skipped.has(node.id)) {
          // Conditional skipped this branch; leave its status as-is
          // (usually "pending") so downstream inspection can see the
          // unvisited nodes.
          continue;
        }
        // If a dependency was skipped or failed, propagate skipping.
        const depSkipped = node.dependsOn.some(
          (d) => skipped.has(d) || state.nodeStatus[d] === "failed",
        );
        if (depSkipped) {
          skipped.add(node.id);
          continue;
        }

        // Loop guard: the loop counter is a safety cap on total node
        // executions to catch a pathological flow that somehow reuses a
        // node via a self-link (shouldn't be possible given topo order,
        // but defense in depth). Large enough to never fire in practice
        // for legitimate flows.
        loopGuard += 1;
        if (loopGuard > 100_000) {
          throw new Error("FlowEngine.run: loop guard tripped (> 100000 node activations)");
        }

        currentNodeId = node.id;
        const outcome = await this.executeNode({
          node,
          state,
          initialInputs,
          signal,
          skipped,
        });
        currentNodeId = null;

        if (outcome.cached) cachedInThisRun += 1;
        else if (outcome.executed) nodeCount += 1;

        if (outcome.terminal) {
          return finish(outcome.terminal, cachedInThisRun);
        }
      }
    } catch (err) {
      // Runner registry miss or hash fault lands here. Attribute the
      // failure to the node we were about to execute so state + events
      // stay consistent. If the error happened outside a node context
      // (topological walk corruption), we just mark the flow failed.
      const message = err instanceof Error ? err.message : String(err);
      if (currentNodeId !== null) {
        state.nodeStatus[currentNodeId] = "failed";
        this.bus.publish({
          kind: "node_failed",
          flowRunId: state.flowRunId,
          nodeId: currentNodeId,
          at: this.now(),
          error: { message, retriable: false },
          willRetry: false,
        });
      }
      return finish("failed", cachedInThisRun);
    }

    return finish("succeeded", cachedInThisRun);
  }

  // --- Internals ------------------------------------------------------------

  private initState(def: FlowDefinition, opts: FlowRunOptions): MutableState {
    const started = this.now();
    if (opts.resumeFrom !== undefined) {
      // Defensive copy so the caller's object is never mutated. The
      // returned `FlowRunState` is a freshly frozen snapshot.
      return {
        flowRunId: opts.flowRunId,
        flowId: def.id,
        version: def.version,
        entry: def.entry,
        nodeStatus: { ...opts.resumeFrom.nodeStatus },
        nodeOutputs: { ...opts.resumeFrom.nodeOutputs },
        pendingGate: opts.resumeFrom.pendingGate,
        startedAt: opts.resumeFrom.startedAt,
        updatedAt: started,
        totalCostUsd: opts.resumeFrom.totalCostUsd,
        costSamples: [...opts.resumeFrom.costSamples],
      };
    }
    const blank = emptyState({
      flowRunId: opts.flowRunId,
      flowId: def.id,
      version: def.version,
      entry: def.entry,
      startedAt: started,
    });
    return {
      flowRunId: blank.flowRunId,
      flowId: blank.flowId,
      version: blank.version,
      entry: blank.entry,
      nodeStatus: { ...blank.nodeStatus },
      nodeOutputs: { ...blank.nodeOutputs },
      pendingGate: blank.pendingGate,
      startedAt: blank.startedAt,
      updatedAt: blank.updatedAt,
      totalCostUsd: blank.totalCostUsd,
      costSamples: [...blank.costSamples],
    };
  }

  private freeze(state: MutableState): FlowRunState {
    return {
      flowRunId: state.flowRunId,
      flowId: state.flowId,
      version: state.version,
      entry: state.entry,
      nodeStatus: { ...state.nodeStatus },
      nodeOutputs: { ...state.nodeOutputs },
      pendingGate: state.pendingGate,
      startedAt: state.startedAt,
      updatedAt: this.now(),
      totalCostUsd: state.totalCostUsd,
      costSamples: [...state.costSamples],
    };
  }

  private async executeNode(params: {
    readonly node: FlowNode;
    readonly state: MutableState;
    readonly initialInputs: Record<string, unknown>;
    readonly signal: AbortSignal;
    readonly skipped: Set<string>;
  }): Promise<{
    readonly executed: boolean;
    readonly cached: boolean;
    readonly terminal?: "succeeded" | "failed" | "paused";
  }> {
    const { node, state, initialInputs, signal, skipped } = params;

    switch (node.kind) {
      case "agent_step":
        return this.runAgentStep(node, state, initialInputs, signal);
      case "conditional":
        return this.runConditional(node, state, initialInputs, signal, skipped);
      case "loop":
        return this.runLoop(node, state, initialInputs, signal);
      case "human_gate":
        return this.runHumanGate(node, state, initialInputs);
      default: {
        // Exhaustiveness check: if a future kind lands without wiring,
        // this assignment fails to type-check. At runtime we throw so a
        // misconfigured flow doesn't silently skip nodes.
        const exhaustive: never = node;
        throw new Error(`FlowEngine: unhandled node kind: ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  private async runAgentStep(
    node: AgentStep,
    state: MutableState,
    initialInputs: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<{
    readonly executed: boolean;
    readonly cached: boolean;
    readonly terminal?: "succeeded" | "failed" | "paused";
  }> {
    const runner = this.registry.get(node.runner);
    if (!runner) {
      throw new Error(`FlowEngine: no runner registered for key '${node.runner}'`);
    }

    const resolvedInputs = this.resolveInputs(node, state, initialInputs);
    const hash = contentHash({ nodeId: node.id, kind: node.kind, inputs: resolvedInputs });

    // Cache hit: a prior invocation produced the same hash for this node
    // id. Short-circuit with the cached output and publish a completed
    // event flagged as cached so budget/metering sinks don't double-count.
    const cached = state.nodeOutputs[node.id];
    if (cached && cached.hash === hash) {
      state.nodeStatus[node.id] = cached.output.ok ? "succeeded" : "failed";
      this.bus.publish({
        kind: "node_completed",
        flowRunId: state.flowRunId,
        nodeId: node.id,
        at: this.now(),
        durationMs: 0,
        output: cached.output,
        cached: true,
      });
      if (!cached.output.ok) {
        // A cached failure still terminates the flow; resume must
        // present different inputs to move past it.
        return { executed: false, cached: true, terminal: "failed" };
      }
      return { executed: false, cached: true };
    }

    // Fresh run: respect maxRetries for retriable errors. Total attempt
    // budget is 1 (initial try) + maxRetries (possible retries). The
    // loop always returns from inside — either on success, on a
    // non-retriable failure, or on retry exhaustion.
    const maxRetries = node.maxRetries ?? 0;
    const maxAttempts = 1 + maxRetries;
    const priorOutputs = this.priorOutputsView(state);
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      state.nodeStatus[node.id] = "running";
      const startedAt = this.now();
      this.bus.publish({
        kind: "node_started",
        flowRunId: state.flowRunId,
        nodeId: node.id,
        role: node.role,
        at: startedAt,
        attempt,
      });

      let output: NodeOutput;
      try {
        output = await runner({
          flowRunId: state.flowRunId,
          node,
          inputs: resolvedInputs,
          priorOutputs,
          signal,
        });
      } catch (err) {
        // An unexpected throw from the runner is treated as a non-retriable
        // fault. Runners that want retries should return `{ ok: false,
        // error: { retriable: true } }` instead of throwing.
        const message = err instanceof Error ? err.message : String(err);
        state.nodeStatus[node.id] = "failed";
        this.bus.publish({
          kind: "node_failed",
          flowRunId: state.flowRunId,
          nodeId: node.id,
          at: this.now(),
          error: { message, retriable: false },
          willRetry: false,
        });
        return { executed: true, cached: false, terminal: "failed" };
      }

      const completedAt = this.now();

      if (output.ok) {
        state.nodeStatus[node.id] = "succeeded";
        state.nodeOutputs[node.id] = { hash, output, completedAt };
        this.recordCostSample(state, output);
        this.bus.publish({
          kind: "node_completed",
          flowRunId: state.flowRunId,
          nodeId: node.id,
          at: completedAt,
          durationMs: completedAt - startedAt,
          output,
          cached: false,
        });
        return { executed: true, cached: false };
      }

      // Failure path.
      const error = output.error ?? { message: "runner reported ok=false", retriable: false };
      const willRetry = error.retriable && attempt <= maxRetries;
      this.bus.publish({
        kind: "node_failed",
        flowRunId: state.flowRunId,
        nodeId: node.id,
        at: completedAt,
        error,
        willRetry,
      });
      if (willRetry) {
        // Intensity cap lives on the node itself; we loop and try again.
        continue;
      }
      state.nodeStatus[node.id] = "failed";
      state.nodeOutputs[node.id] = { hash, output, completedAt };
      this.recordCostSample(state, output);
      return { executed: true, cached: false, terminal: "failed" };
    }
    // Unreachable: maxAttempts >= 1 so the loop body always executes at
    // least once, and every path inside returns. Present to satisfy
    // noImplicitReturns.
    throw new Error("FlowEngine: retry loop fell off end (should be unreachable)");
  }

  private async runConditional(
    node: Conditional,
    state: MutableState,
    initialInputs: Record<string, unknown>,
    signal: AbortSignal,
    skipped: Set<string>,
  ): Promise<{
    readonly executed: boolean;
    readonly cached: boolean;
    readonly terminal?: "succeeded" | "failed" | "paused";
  }> {
    const runner = this.registry.get(node.predicate);
    if (!runner) {
      throw new Error(
        `FlowEngine: no predicate runner registered for key '${node.predicate}' (conditional ${node.id})`,
      );
    }
    const resolvedInputs = this.resolveInputs(node, state, initialInputs);
    const hash = contentHash({ nodeId: node.id, kind: node.kind, inputs: resolvedInputs });

    const cached = state.nodeOutputs[node.id];
    if (cached && cached.hash === hash) {
      state.nodeStatus[node.id] = cached.output.ok ? "succeeded" : "failed";
      this.bus.publish({
        kind: "node_completed",
        flowRunId: state.flowRunId,
        nodeId: node.id,
        at: this.now(),
        durationMs: 0,
        output: cached.output,
        cached: true,
      });
      if (!cached.output.ok) {
        return { executed: false, cached: true, terminal: "failed" };
      }
      const picked = cached.output.value === true ? node.trueBranch : node.falseBranch;
      this.markUnpickedBranchSkipped(node, picked, skipped);
      return { executed: false, cached: true };
    }

    const startedAt = this.now();
    state.nodeStatus[node.id] = "running";
    this.bus.publish({
      kind: "node_started",
      flowRunId: state.flowRunId,
      nodeId: node.id,
      at: startedAt,
      attempt: 1,
    });

    let output: NodeOutput;
    try {
      output = await runner({
        flowRunId: state.flowRunId,
        node,
        inputs: resolvedInputs,
        priorOutputs: this.priorOutputsView(state),
        signal,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      state.nodeStatus[node.id] = "failed";
      this.bus.publish({
        kind: "node_failed",
        flowRunId: state.flowRunId,
        nodeId: node.id,
        at: this.now(),
        error: { message, retriable: false },
        willRetry: false,
      });
      return { executed: true, cached: false, terminal: "failed" };
    }

    const completedAt = this.now();
    this.recordCostSample(state, output);
    if (!output.ok) {
      state.nodeStatus[node.id] = "failed";
      state.nodeOutputs[node.id] = { hash, output, completedAt };
      const error = output.error ?? { message: "predicate reported ok=false", retriable: false };
      this.bus.publish({
        kind: "node_failed",
        flowRunId: state.flowRunId,
        nodeId: node.id,
        at: completedAt,
        error,
        willRetry: false,
      });
      return { executed: true, cached: false, terminal: "failed" };
    }
    state.nodeStatus[node.id] = "succeeded";
    state.nodeOutputs[node.id] = { hash, output, completedAt };
    this.bus.publish({
      kind: "node_completed",
      flowRunId: state.flowRunId,
      nodeId: node.id,
      at: completedAt,
      durationMs: completedAt - startedAt,
      output,
      cached: false,
    });

    const picked = output.value === true ? node.trueBranch : node.falseBranch;
    this.markUnpickedBranchSkipped(node, picked, skipped);
    return { executed: true, cached: false };
  }

  private markUnpickedBranchSkipped(node: Conditional, picked: NodeId, skipped: Set<string>): void {
    const other = picked === node.trueBranch ? node.falseBranch : node.trueBranch;
    skipped.add(other);
  }

  private async runLoop(
    node: Loop,
    state: MutableState,
    initialInputs: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<{
    readonly executed: boolean;
    readonly cached: boolean;
    readonly terminal?: "succeeded" | "failed" | "paused";
  }> {
    const runner = this.registry.get(node.until);
    if (!runner) {
      throw new Error(
        `FlowEngine: no until-predicate runner registered for key '${node.until}' (loop ${node.id})`,
      );
    }
    state.nodeStatus[node.id] = "running";
    const startedAt = this.now();
    this.bus.publish({
      kind: "node_started",
      flowRunId: state.flowRunId,
      nodeId: node.id,
      at: startedAt,
      attempt: 1,
    });

    // The Loop node itself doesn't invoke body nodes in 4.A — those body
    // nodes appear as their own entries in the DAG and depend on the
    // Loop. Instead, the loop evaluates its `until` predicate repeatedly
    // until satisfied or maxIterations hits.
    //
    // This keeps the engine a single pass. 4.B or later can layer a
    // richer loop that re-invokes body nodes; 4.A's goal is to prove the
    // predicate seam + iteration counter behave, which is what the tests
    // exercise.
    let iterations = 0;
    let finalOutput: NodeOutput | null = null;
    while (iterations < node.maxIterations) {
      iterations += 1;
      const resolvedInputs = {
        ...this.resolveInputs(node, state, initialInputs),
        __loop_iteration: iterations,
      };
      let output: NodeOutput;
      try {
        output = await runner({
          flowRunId: state.flowRunId,
          node,
          inputs: resolvedInputs,
          priorOutputs: this.priorOutputsView(state),
          signal,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        state.nodeStatus[node.id] = "failed";
        this.bus.publish({
          kind: "node_failed",
          flowRunId: state.flowRunId,
          nodeId: node.id,
          at: this.now(),
          error: { message, retriable: false },
          willRetry: false,
        });
        return { executed: true, cached: false, terminal: "failed" };
      }
      this.recordCostSample(state, output);
      finalOutput = output;
      if (!output.ok) {
        state.nodeStatus[node.id] = "failed";
        this.bus.publish({
          kind: "node_failed",
          flowRunId: state.flowRunId,
          nodeId: node.id,
          at: this.now(),
          error: output.error ?? { message: "loop predicate reported ok=false", retriable: false },
          willRetry: false,
        });
        return { executed: true, cached: false, terminal: "failed" };
      }
      if (output.value === true) break;
    }
    const completedAt = this.now();
    state.nodeStatus[node.id] = "succeeded";
    // The cached output for a loop captures the final predicate result and
    // the iteration count for debuggability.
    const persisted: NodeOutput = finalOutput ?? {
      ok: true,
      value: false,
      costUsd: null,
      costConfidence: "unknown",
      costSource: "loop",
    };
    const hash = contentHash({
      nodeId: node.id,
      kind: node.kind,
      inputs: this.resolveInputs(node, state, initialInputs),
      iterations,
    });
    state.nodeOutputs[node.id] = { hash, output: persisted, completedAt };
    this.bus.publish({
      kind: "node_completed",
      flowRunId: state.flowRunId,
      nodeId: node.id,
      at: completedAt,
      durationMs: completedAt - startedAt,
      output: persisted,
      cached: false,
    });
    return { executed: true, cached: false };
  }

  private async runHumanGate(
    node: HumanGate,
    state: MutableState,
    initialInputs: Record<string, unknown>,
  ): Promise<{
    readonly executed: boolean;
    readonly cached: boolean;
    readonly terminal?: "succeeded" | "failed" | "paused";
  }> {
    // Resume-past-gate semantics: if `initialInputs[resumeToken]` is
    // present, treat the gate as satisfied and record a synthetic
    // successful output that downstream nodes can pull via
    // `RunnerContext.priorOutputs`. The engine does NOT verify the token
    // — the caller owns that policy (4.B will add a verifier shim on
    // top; 4.A exposes the seam).
    const humanInput = Object.hasOwn(initialInputs, node.resumeToken)
      ? initialInputs[node.resumeToken]
      : undefined;
    if (humanInput !== undefined) {
      const at = this.now();
      const output: NodeOutput = {
        ok: true,
        value: humanInput,
        costUsd: null,
        costConfidence: "unknown",
        costSource: "human_gate",
      };
      const hash = contentHash({
        nodeId: node.id,
        kind: node.kind,
        resumeToken: node.resumeToken,
      });
      state.nodeStatus[node.id] = "succeeded";
      state.nodeOutputs[node.id] = { hash, output, completedAt: at };
      // Clear any leftover pending gate marker for this node.
      if (state.pendingGate && state.pendingGate.nodeId === node.id) {
        state.pendingGate = null;
      }
      this.bus.publish({
        kind: "node_started",
        flowRunId: state.flowRunId,
        nodeId: node.id,
        at,
        attempt: 1,
      });
      this.bus.publish({
        kind: "node_completed",
        flowRunId: state.flowRunId,
        nodeId: node.id,
        at,
        durationMs: 0,
        output,
        cached: false,
      });
      return { executed: true, cached: false };
    }

    // First-time visit (or resume without the human input supplied):
    // pause the flow. Record the pending gate in state; the caller reads
    // `state.pendingGate` to surface the prompt to the human.
    const at = this.now();
    state.nodeStatus[node.id] = "paused";
    state.pendingGate = { nodeId: node.id, resumeToken: node.resumeToken };
    this.bus.publish({
      kind: "node_started",
      flowRunId: state.flowRunId,
      nodeId: node.id,
      at,
      attempt: 1,
    });
    this.bus.publish({
      kind: "human_gate_reached",
      flowRunId: state.flowRunId,
      nodeId: node.id,
      at,
      prompt: node.prompt,
      resumeToken: node.resumeToken,
    });
    return { executed: true, cached: false, terminal: "paused" };
  }

  /**
   * Resolve a node's input view = initialInputs + prior node outputs
   * (keyed by node id) + the node's own static inputs. The order matters
   * for content hashing: changing initial inputs, changing a dependency's
   * output, or changing the node's static inputs all invalidate the
   * cache. We do NOT overlay — we key them into named sub-objects so a
   * caller can distinguish them at a glance.
   */
  private resolveInputs(
    node: FlowNode,
    state: MutableState,
    initialInputs: Record<string, unknown>,
  ): Record<string, unknown> {
    const deps: Record<string, unknown> = {};
    for (const depId of node.dependsOn) {
      const persisted = state.nodeOutputs[depId];
      if (persisted) {
        deps[depId] = persisted.output.value;
      }
    }
    const staticInputs = node.kind === "agent_step" ? node.inputs : ({} as Record<string, unknown>);
    return {
      initial: initialInputs,
      deps,
      node: staticInputs,
    };
  }

  private priorOutputsView(state: MutableState): Readonly<Record<NodeId, NodeOutput>> {
    const out: Record<string, NodeOutput> = {};
    for (const [id, persisted] of Object.entries(state.nodeOutputs)) {
      out[id] = persisted.output;
    }
    return out as Readonly<Record<NodeId, NodeOutput>>;
  }

  private recordCostSample(state: MutableState, output: NodeOutput): void {
    state.costSamples.push({
      usd: output.costUsd,
      confidence: output.costConfidence,
      source: output.costSource,
    });
    if (output.costUsd !== null) {
      state.totalCostUsd = (state.totalCostUsd ?? 0) + output.costUsd;
    }
  }
}

// --- Module-level helpers ---------------------------------------------------

/**
 * Produce a topological order over `def.nodes`. Throws on cycles.
 *
 * Kahn's algorithm: start with nodes that have zero incoming edges,
 * emit them, decrement their children's in-degree. If any nodes remain
 * unemitted at the end, the graph has a cycle.
 *
 * We also validate `dependsOn` points only at known node ids — a
 * dangling dependency is a definition-time bug that deserves a crisp
 * error up-front, not silent cache misses.
 */
export function topologicalOrder(def: FlowDefinition): FlowNode[] {
  const byId = new Map<string, FlowNode>();
  for (const node of def.nodes) {
    if (byId.has(node.id)) {
      throw new Error(`FlowDefinition: duplicate node id '${node.id}'`);
    }
    byId.set(node.id, node);
  }
  if (!byId.has(def.entry)) {
    throw new Error(`FlowDefinition: entry '${def.entry}' is not a node`);
  }

  const inDegree = new Map<string, number>();
  const children = new Map<string, string[]>();
  for (const node of def.nodes) {
    inDegree.set(node.id, inDegree.get(node.id) ?? 0);
    for (const dep of node.dependsOn) {
      if (!byId.has(dep)) {
        throw new Error(`FlowDefinition: node '${node.id}' depends on unknown node '${dep}'`);
      }
      inDegree.set(node.id, (inDegree.get(node.id) ?? 0) + 1);
      const list = children.get(dep) ?? [];
      list.push(node.id);
      children.set(dep, list);
    }
  }

  const ready: string[] = [];
  for (const [id, count] of inDegree.entries()) {
    if (count === 0) ready.push(id);
  }
  // Sort for deterministic iteration order across platforms and map
  // implementations. Insertion order IS preserved on a Map, but being
  // explicit here makes the traversal stable even if a caller constructs
  // `nodes` in a different order across runs.
  ready.sort();

  const emitted: FlowNode[] = [];
  while (ready.length > 0) {
    const id = ready.shift() as string;
    const node = byId.get(id);
    if (!node) continue;
    emitted.push(node);
    const outs = children.get(id) ?? [];
    for (const child of outs) {
      const next = (inDegree.get(child) ?? 0) - 1;
      inDegree.set(child, next);
      if (next === 0) {
        // Binary-insert to keep `ready` sorted for determinism.
        const insertAt = lowerBound(ready, child);
        ready.splice(insertAt, 0, child);
      }
    }
  }

  if (emitted.length !== def.nodes.length) {
    throw new Error("FlowDefinition: cycle detected in dependsOn graph");
  }
  return emitted;
}

function lowerBound(arr: readonly string[], target: string): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const current = arr[mid];
    if (current !== undefined && current < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function rollupConfidence(samples: readonly CostSample[]): FlowCostConfidence {
  if (samples.length === 0) return "unknown";
  let sawExact = false;
  let sawEstimate = false;
  let sawKnown = false;
  for (const s of samples) {
    if (s.usd === null && s.confidence === "unknown") continue;
    sawKnown = true;
    if (s.confidence === "exact") sawExact = true;
    else if (s.confidence === "estimate") sawEstimate = true;
  }
  if (!sawKnown) return "unknown";
  if (sawExact && sawEstimate) return "mixed";
  if (sawExact) return "exact";
  if (sawEstimate) return "estimate";
  return "unknown";
}

// Re-exported for the test suite; kept out of the public index to make
// the public surface narrow.
export { rollupConfidence as __rollupConfidenceForTests };
