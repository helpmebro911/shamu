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
 * Phase 5.B wire-up: the `ci` node runs between `execute` and `review`.
 * Inside the reviewer's internal re-execute loop, the reviewer runner also
 * re-runs CI (via the same helper the `ci` runner uses) so every iteration
 * sees a fresh CI result. The engine's Loop body list is self-describing
 * (execute, ci, review) even though the body does not re-execute in 4.A;
 * once the engine upgrades, the reviewer-internal loop collapses.
 *
 * This is tracked as a followup: once the engine's Loop node can re-execute
 * body nodes, we collapse the reviewer-internal loop and restore the
 * predicate-driven dance. For now the contract is:
 *   plan   (runner: "planner")
 *   -> execute (runner: "executor")
 *     -> ci     (runner: "ci")
 *       -> review (runner: "reviewer")          -- internally re-runs executor+ci+review
 *         -> loop (predicate: "loop-predicate") -- terminator, zero cost
 *
 * The loop's `maxIterations` matches the reviewer runner's own cap so the
 * bound is consistent regardless of which layer first observes it.
 */

import { type AgentStep, type FlowDefinition, type Loop, nodeId } from "@shamu/core-flow/types";
import { DEFAULT_MAX_ITERATIONS, FLOW_ID, FLOW_VERSION } from "./config.ts";

const planId = nodeId("plan");
const executeId = nodeId("execute");
const ciId = nodeId("ci");
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

const ciNode: AgentStep = {
  kind: "agent_step",
  id: ciId,
  role: "ci",
  runner: "ci",
  inputs: {},
  dependsOn: [executeId],
  // CI is deterministic; retries belong inside the CI tool (agent-ci's own
  // workflow retry), not in the DAG. A boot-level failure (no GITHUB_REPO,
  // bin missing) is not retriable here -- surface it to the reviewer as a
  // failed NodeOutput instead.
  maxRetries: 0,
};

const reviewNode: AgentStep = {
  kind: "agent_step",
  id: reviewId,
  role: "reviewer",
  runner: "reviewer",
  inputs: {},
  dependsOn: [ciId],
  maxRetries: 1,
};

const loopNode: Loop = {
  kind: "loop",
  id: loopId,
  // `body` is a reference list; per the trade-off note above, the engine
  // does not re-invoke body nodes in 4.A. We still name them so the DAG is
  // self-describing for future upgrades. CI is a body member because a
  // future iteration upgrade must re-run it per pass.
  body: [executeId, ciId, reviewId],
  until: "loop-predicate",
  maxIterations: DEFAULT_MAX_ITERATIONS,
  dependsOn: [reviewId],
};

export const flowDefinition: FlowDefinition = {
  id: FLOW_ID,
  version: FLOW_VERSION,
  nodes: [planNode, executeNode, ciNode, reviewNode, loopNode],
  entry: planId,
};
