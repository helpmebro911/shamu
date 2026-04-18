/**
 * FlowDefinition for the canonical plan -> execute -> review loop.
 *
 * WHY this shape (trade-off with 4.A's engine surface):
 *
 * The 4.A engine's Loop node evaluates its `until` predicate repeatedly but
 * does NOT re-invoke body nodes per iteration -- body nodes appear at DAG
 * level and execute exactly once during the topological walk. A richer
 * body-re-execution loop is deferred to a later engine upgrade.
 *
 * To still deliver the PLAN.md § 8 behavior ("reviewer reject causes a
 * clean executor re-run"), the reviewer runner performs the revise->retry
 * cycle INTERNALLY: on a `revise` verdict, it re-invokes the executor
 * runner itself (up to maxIterations) and re-reviews. The final
 * `ReviewerOutput.iterationsUsed` reflects the actual count.
 *
 * The `loop` node in this DAG is therefore a light terminator: it checks
 * the reviewer's verdict and records completion. It does NOT drive
 * re-execution -- that work already happened inside the reviewer runner.
 *
 * This is tracked as a followup: once the engine's Loop node can re-execute
 * body nodes, we collapse the reviewer-internal loop and restore the
 * predicate-driven dance. For now the contract is:
 *   plan  (runner: "planner")
 *   -> execute (runner: "executor")
 *     -> review (runner: "reviewer")       -- internally re-runs executor+review
 *       -> loop (predicate: "loop-predicate") -- terminator, zero cost
 *
 * The loop's `maxIterations` matches the reviewer runner's own cap so the
 * bound is consistent regardless of which layer first observes it.
 */

import { type AgentStep, type FlowDefinition, type Loop, nodeId } from "@shamu/core-flow/types";
import { DEFAULT_MAX_ITERATIONS, FLOW_ID, FLOW_VERSION } from "./config.ts";

const planId = nodeId("plan");
const executeId = nodeId("execute");
const reviewId = nodeId("review");
const loopId = nodeId("loop");

const planNode: AgentStep = {
  kind: "agent_step",
  id: planId,
  role: "planner",
  runner: "planner",
  // `task` + `repoContext` travel via the engine's `initialInputs` bundle
  // (resolved into `RunnerContext.inputs.initial`). We keep `inputs` empty so
  // the node's content hash does not include volatile per-invocation data --
  // the initial inputs already contribute to the hash.
  inputs: {},
  dependsOn: [],
  maxRetries: 1,
};

const executeNode: AgentStep = {
  kind: "agent_step",
  id: executeId,
  role: "executor",
  runner: "executor",
  inputs: {},
  dependsOn: [planId],
  // Two retries on retriable errors (adapter stream hiccups, transient
  // parse failures). Non-retriable errors still fail-fast.
  maxRetries: 2,
};

const reviewNode: AgentStep = {
  kind: "agent_step",
  id: reviewId,
  role: "reviewer",
  runner: "reviewer",
  inputs: {},
  dependsOn: [executeId],
  maxRetries: 1,
};

const loopNode: Loop = {
  kind: "loop",
  id: loopId,
  // `body` is a reference list; per the trade-off note above, the engine
  // does not re-invoke body nodes in 4.A. We still name them so the DAG is
  // self-describing for future upgrades.
  body: [executeId, reviewId],
  until: "loop-predicate",
  maxIterations: DEFAULT_MAX_ITERATIONS,
  dependsOn: [reviewId],
};

export const flowDefinition: FlowDefinition = {
  id: FLOW_ID,
  version: FLOW_VERSION,
  nodes: [planNode, executeNode, reviewNode, loopNode],
  entry: planId,
};
