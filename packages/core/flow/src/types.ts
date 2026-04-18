/**
 * Typed DAG node surface for the flow engine.
 *
 * PLAN.md § 8: workflows are expressed as typed, serializable DAGs —
 * resumable, inspectable, replayable. This file declares the node
 * taxonomy and the shape of the output that runners produce; it does NOT
 * declare runners themselves (see `runners.ts`) or the executor
 * (`engine.ts`).
 *
 * Why a discriminated union rather than a class hierarchy: the DAG is
 * serialized to `flow_runs.state_json` and passed across process boundaries
 * (future: subprocess watchdog / replay). Plain data is the simplest thing
 * that survives those hops.
 *
 * Node identity is carried by a branded `NodeId`. The brand is declared
 * locally rather than imported from `@shamu/shared/ids` because flow
 * nodes are a core-flow concept and we don't want to leak that type into
 * the shared surface. The brand trick is the same one `@shamu/shared`
 * uses — a phantom symbol-typed property with zero runtime cost.
 */

// Phantom symbol for the local NodeId brand. Distinct from the shared
// `__brand` symbol so the two can never be accidentally confused.
declare const __flowBrand: unique symbol;
type Brand<T, Tag extends string> = T & { readonly [__flowBrand]: Tag };

export type NodeId = Brand<string, "NodeId">;

export function nodeId(value: string): NodeId {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("NodeId must be a non-empty string");
  }
  return value as NodeId;
}

/**
 * Confidence labels on cost samples mirror the `cost` event vocabulary in
 * PLAN.md § 1 and `@shamu/shared/events`. "exact" and "estimate" roll up;
 * "unknown" is accounted for but does not contribute to budgets.
 */
export type NodeCostConfidence = "exact" | "estimate" | "unknown";

/**
 * Output of a single node run.
 *
 * - `ok: false` with a retriable error means the engine may retry per the
 *   node's `maxRetries`. A non-retriable error bubbles to a fail-fast
 *   flow status.
 * - `costUsd` is null when the runner cannot report dollars (subscription
 *   tier or no metering). The engine aggregates non-nulls; the cost
 *   confidence rollup on `FlowCompleted` records how mixed the samples were.
 * - `costSource` is a free-form string identifying where the measurement
 *   came from (`"vendor"`, `"computed"`, `"subscription"`, `"unknown"`,
 *   runner-specific tags). Mirrors `AgentEvent.cost.source` on purpose so
 *   4.B can forward-translate adapter cost events.
 */
export interface NodeOutput {
  readonly ok: boolean;
  readonly value: unknown;
  readonly costUsd: number | null;
  readonly costConfidence: NodeCostConfidence;
  readonly costSource: string;
  readonly error?: NodeError;
}

export interface NodeError {
  readonly message: string;
  readonly retriable: boolean;
}

/**
 * An `AgentStep` is the generic "invoke a runner" node. The `runner` field
 * keys into the `RunnerRegistry`; 4.B will register runners that spawn
 * `@shamu/adapter-claude` / `@shamu/adapter-codex`. The engine is
 * vendor-opaque: it knows the key, not the implementation.
 *
 * `inputs` is the static input bundle from the flow definition. The
 * engine resolves a combined input view (initial inputs + prior outputs +
 * this field) before computing the content hash, so changes in any of
 * those three inputs invalidate the cached output.
 */
export interface AgentStep {
  readonly kind: "agent_step";
  readonly id: NodeId;
  readonly role: string;
  readonly runner: string;
  readonly inputs: Record<string, unknown>;
  readonly dependsOn: readonly NodeId[];
  readonly maxRetries?: number;
}

/**
 * A `Conditional` evaluates a runner-resolvable predicate and selects one
 * of two branches. The `predicate` key plugs into the RunnerRegistry;
 * 4.B will register a JSON-expression evaluator. In 4.A, tests stub a
 * fake predicate runner.
 *
 * Both branches are node ids. The selected branch is the only one whose
 * node is executed (the unselected branch is skipped).
 */
export interface Conditional {
  readonly kind: "conditional";
  readonly id: NodeId;
  readonly predicate: string;
  readonly trueBranch: NodeId;
  readonly falseBranch: NodeId;
  readonly dependsOn: readonly NodeId[];
}

/**
 * A `Loop` iterates over `body` (a list of node ids in the same flow)
 * until `until` is satisfied or `maxIterations` is reached. `until` is a
 * runner-resolvable predicate key — same contract as `Conditional`.
 *
 * The loop is a bounded construct by design: runaway flows are a threat
 * model concern (budgets, watchdog). `maxIterations` is mandatory; there
 * is no "loop forever" option.
 */
export interface Loop {
  readonly kind: "loop";
  readonly id: NodeId;
  readonly body: readonly NodeId[];
  readonly until: string;
  readonly maxIterations: number;
  readonly dependsOn: readonly NodeId[];
}

/**
 * A `HumanGate` pauses the flow, records a resume token, and returns a
 * `paused` status. The caller resumes by re-invoking the engine with the
 * prior `FlowRunState` and, typically, a `human_input` entry added to
 * `initialInputs` keyed on `resumeToken`.
 *
 * The engine never verifies the resume token — the caller owns that
 * policy. 4.B will layer on token minting + verification; 4.A just
 * surfaces the seam.
 */
export interface HumanGate {
  readonly kind: "human_gate";
  readonly id: NodeId;
  readonly prompt: string;
  readonly resumeToken: string;
  readonly dependsOn: readonly NodeId[];
}

export type FlowNode = AgentStep | Conditional | Loop | HumanGate;
export type FlowNodeKind = FlowNode["kind"];

/**
 * A `FlowDefinition` is the static shape of a DAG. `version` is the
 * `dag_version` column on `flow_runs`; bump it in lockstep with any
 * change that affects content hashes (inputs layout, node identity
 * scheme, etc.) so cached outputs from the prior version don't cross
 * over.
 */
export interface FlowDefinition {
  readonly id: string;
  readonly version: number;
  readonly nodes: readonly FlowNode[];
  readonly entry: NodeId;
}
