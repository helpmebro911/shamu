/**
 * @shamu/core-flow — public surface.
 *
 * The typed, resumable DAG workflow engine. Composes adapter events,
 * supervisor restart, mailbox coordination, and worktree lifecycle into
 * inspectable flows. 4.A ships the engine; 4.B wires planner/executor/
 * reviewer runners on top.
 *
 * Modules are also addressable individually via the per-subpath exports
 * in this package's `package.json` so callers can tree-shake to just the
 * bits they need.
 */

export { type BusListener, EventBus } from "./bus.ts";
export { FlowEngine, type FlowEngineOptions, type FlowRunOptions } from "./engine.ts";
export type {
  FlowCompleted,
  FlowCostConfidence,
  FlowEvent,
  FlowEventKind,
  FlowStarted,
  HumanGateReached,
  NodeCompleted,
  NodeFailed,
  NodeStarted,
} from "./events.ts";
export { FLOW_EVENT_KINDS } from "./events.ts";
export { canonicalize, contentHash } from "./hash.ts";
export { type Runner, type RunnerContext, RunnerRegistry } from "./runners.ts";
export type {
  CostSample,
  FlowRunState,
  NodeRuntimeStatus,
  PendingGate,
  PersistedNodeOutput,
} from "./state.ts";
export { deserialize, emptyState, flowRunStateSchema, serialize } from "./state.ts";
export type {
  AgentStep,
  Conditional,
  FlowDefinition,
  FlowNode,
  FlowNodeKind,
  HumanGate,
  Loop,
  NodeCostConfidence,
  NodeError,
  NodeId,
  NodeOutput,
} from "./types.ts";
export { nodeId } from "./types.ts";
