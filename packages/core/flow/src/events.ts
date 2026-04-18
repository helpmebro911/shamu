/**
 * Flow lifecycle events.
 *
 * PLAN.md § 8: per-node progress and per-node cost roll-ups are delivered
 * on an event stream. Callers (CLI, TUI, persistence projectors, Phase 6
 * Linear sink) subscribe via the `EventBus` in `bus.ts`. Kind discriminant
 * names stay consistent with the supervisor's event vocabulary (snake_case
 * literals; `kind` field) so a single bus-adapter can forward both if a
 * caller multiplexes.
 *
 * Events carry `flowRunId` so a process with multiple concurrent flow
 * runs can route listeners by id. They do NOT carry the full node object
 * — just `nodeId` plus the minimum a UI sink needs to render. The full
 * definition lives in `FlowDefinition`; callers that need more reference
 * it directly.
 */

import type { WorkflowRunId } from "@shamu/shared/ids";
import type { NodeCostConfidence, NodeId, NodeOutput } from "./types.ts";

/**
 * Emitted at the start of every `engine.run(...)` invocation, including
 * resumes. `resumedFrom` points at the previous `flowRunId` when the
 * caller passed a `resumeFrom` state; null for cold starts.
 */
export interface FlowStarted {
  readonly kind: "flow_started";
  readonly flowRunId: WorkflowRunId;
  readonly flowId: string;
  readonly version: number;
  readonly at: number;
  readonly resumedFrom: WorkflowRunId | null;
}

/**
 * Emitted before a runner is invoked for an AgentStep, before a
 * predicate is evaluated for a Conditional/Loop guard, or before a
 * HumanGate publishes its prompt. `attempt` starts at 1 and increments
 * on retries of the same node.
 *
 * `role` is only populated for `AgentStep` nodes; other kinds leave it
 * undefined so the supervisor / Linear sinks don't misattribute cost.
 */
export interface NodeStarted {
  readonly kind: "node_started";
  readonly flowRunId: WorkflowRunId;
  readonly nodeId: NodeId;
  readonly role?: string;
  readonly at: number;
  readonly attempt: number;
}

/**
 * Emitted on successful node completion OR on a cache hit where the
 * engine replays a prior output without invoking the runner. `cached`
 * lets sinks distinguish the two — a cached completion does not incur
 * new cost, so budget/metering sinks must not double-count.
 */
export interface NodeCompleted {
  readonly kind: "node_completed";
  readonly flowRunId: WorkflowRunId;
  readonly nodeId: NodeId;
  readonly at: number;
  readonly durationMs: number;
  readonly output: NodeOutput;
  readonly cached: boolean;
}

/**
 * Emitted on any failed attempt. `willRetry` says whether the engine
 * plans to re-invoke the runner (intensity: retries bounded by the
 * node's `maxRetries`). A terminal failure emits this with
 * `willRetry: false` followed by a `FlowCompleted` with `status: "failed"`.
 */
export interface NodeFailed {
  readonly kind: "node_failed";
  readonly flowRunId: WorkflowRunId;
  readonly nodeId: NodeId;
  readonly at: number;
  readonly error: { readonly message: string; readonly retriable: boolean };
  readonly willRetry: boolean;
}

/**
 * Emitted when a `HumanGate` node runs. The flow state is persisted with
 * `status: "paused"`; resume semantics are owned by the caller.
 */
export interface HumanGateReached {
  readonly kind: "human_gate_reached";
  readonly flowRunId: WorkflowRunId;
  readonly nodeId: NodeId;
  readonly at: number;
  readonly prompt: string;
  readonly resumeToken: string;
}

/**
 * Emitted once per `engine.run(...)` invocation after the topological
 * walk finishes (whether via success, failure, or pause). The aggregate
 * cost roll-up (`totalCostUsd`, `costConfidence`) summarizes every node
 * that ran during THIS invocation; a resume builds on the prior state's
 * `totalCostUsd`.
 *
 * `costConfidence` collapses per-node confidence labels:
 *   - "exact"    — every non-null sample was exact
 *   - "estimate" — every non-null sample was an estimate
 *   - "mixed"    — at least one exact + at least one estimate
 *   - "unknown"  — every sample was unknown (or all were null)
 *
 * `nodeCount` is the number of distinct nodes executed or cache-hit
 * during this invocation; it excludes unvisited branches and skipped
 * dependencies.
 */
export interface FlowCompleted {
  readonly kind: "flow_completed";
  readonly flowRunId: WorkflowRunId;
  readonly at: number;
  readonly status: "succeeded" | "failed" | "paused";
  readonly totalCostUsd: number | null;
  readonly costConfidence: FlowCostConfidence;
  readonly nodeCount: number;
}

export type FlowCostConfidence = NodeCostConfidence | "mixed";

export type FlowEvent =
  | FlowStarted
  | NodeStarted
  | NodeCompleted
  | NodeFailed
  | HumanGateReached
  | FlowCompleted;

export type FlowEventKind = FlowEvent["kind"];

export const FLOW_EVENT_KINDS: readonly FlowEventKind[] = [
  "flow_started",
  "node_started",
  "node_completed",
  "node_failed",
  "human_gate_reached",
  "flow_completed",
] as const;
