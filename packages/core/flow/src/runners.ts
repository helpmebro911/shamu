/**
 * Runner registry.
 *
 * PLAN.md § 8: the flow engine is opaque to specific vendors. Node
 * execution is plugged in via a runner registry — `(context, node) =>
 * Promise<NodeOutput>`. 4.B will register runners that spawn
 * `@shamu/adapter-claude` / `@shamu/adapter-codex`. 4.A wires the seam
 * and demonstrates it with in-test fakes.
 *
 * The registry covers `AgentStep` nodes *and* the runner-resolvable
 * predicate keys used by `Conditional.predicate` / `Loop.until`.
 * Conditional/Loop/HumanGate themselves are handled internally by the
 * engine; the registry carries only the pluggable building blocks.
 *
 * Design notes:
 *   - Registration is runtime mutable. Tests register + unregister a
 *     fake runner per test; production code registers at startup. No
 *     freeze-after-start option — the engine doesn't need it in 4.A.
 *   - Duplicate registration throws to catch programmer error. Overwrite
 *     semantics can be added later if a use case surfaces.
 *   - Runner functions receive a `RunnerContext` that includes the full
 *     prior-output map. A runner is NOT required to read it; the engine
 *     computes content hashes from the resolved inputs view anyway.
 */

import type { WorkflowRunId } from "@shamu/shared/ids";
import type { FlowNode, NodeId, NodeOutput } from "./types.ts";

/**
 * Context passed to every runner invocation. A runner can inspect the
 * prior outputs map (for chained steps) or the node itself (for the
 * static inputs). The `signal` plumbs an `AbortSignal` the engine
 * passes down from `engine.run({ signal })` so callers can cancel
 * mid-flow.
 */
export interface RunnerContext {
  readonly flowRunId: WorkflowRunId;
  readonly node: FlowNode;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly priorOutputs: Readonly<Record<NodeId, NodeOutput>>;
  readonly signal: AbortSignal;
}

export type Runner = (ctx: RunnerContext) => Promise<NodeOutput>;

/**
 * Runner registry. Keys are the strings referenced by
 * `AgentStep.runner`, `Conditional.predicate`, and `Loop.until`. A
 * single registry instance is typically shared by the whole flow run.
 */
export class RunnerRegistry {
  private readonly byKey = new Map<string, Runner>();

  register(key: string, runner: Runner): void {
    if (typeof key !== "string" || key.length === 0) {
      throw new TypeError("RunnerRegistry.register: key must be a non-empty string");
    }
    if (this.byKey.has(key)) {
      throw new Error(`RunnerRegistry.register: duplicate key ${key}`);
    }
    this.byKey.set(key, runner);
  }

  /** Returns the runner for `key`, or `null` if not registered. */
  get(key: string): Runner | null {
    return this.byKey.get(key) ?? null;
  }

  has(key: string): boolean {
    return this.byKey.has(key);
  }

  /** Primarily for tests; removes a previously registered runner. */
  unregister(key: string): void {
    this.byKey.delete(key);
  }
}
