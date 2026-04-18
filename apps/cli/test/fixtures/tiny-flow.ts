/**
 * Test fixture: a minimal two-node flow that drives the CLI without
 * requiring an adapter subprocess.
 *
 * DAG: `start` → `end`
 *
 * Environment flags the fixture reads (so tests can force specific
 * outcomes):
 *   - SHAMU_TINY_FLOW_FAIL_AT=<node-id> — that node returns ok=false.
 *   - SHAMU_TINY_FLOW_THROW_AT=<node-id> — that node throws.
 *   - SHAMU_TINY_FLOW_COST=<number> — per-node cost attached to each sample.
 *   - SHAMU_TINY_FLOW_CACHE_PROBE=<node-id> — writes a side-effect marker
 *     file at $SHAMU_TINY_FLOW_CACHE_PROBE_FILE when the node runs
 *     (missing file after a --resume proves the cache path short-circuited).
 */

import { appendFileSync } from "node:fs";
import type { RunnerContext, RunnerRegistry } from "@shamu/core-flow/runners";
import type { FlowDefinition, NodeOutput } from "@shamu/core-flow/types";
import { nodeId } from "@shamu/core-flow/types";

import type { RegisterRunnersOptions } from "../../src/commands/flow-contract.ts";

export const name = "tiny-flow";

export const flowDefinition: FlowDefinition = {
  id: "tiny-flow",
  version: 1,
  entry: nodeId("start"),
  nodes: [
    {
      kind: "agent_step",
      id: nodeId("start"),
      role: "planner",
      runner: "tiny-pass",
      inputs: { label: "start" },
      dependsOn: [],
    },
    {
      kind: "agent_step",
      id: nodeId("end"),
      role: "executor",
      runner: "tiny-pass",
      inputs: { label: "end" },
      dependsOn: [nodeId("start")],
    },
  ],
};

export function parseOptions(opts: Record<string, string>): Partial<RegisterRunnersOptions> {
  // The fixture ignores knobs except a demonstration pass-through of
  // maxIterations — returning what we got is enough for the test to
  // verify the round trip.
  if (typeof opts.maxIterations === "string" && opts.maxIterations.length > 0) {
    const n = Number(opts.maxIterations);
    if (Number.isFinite(n) && Number.isInteger(n) && n > 0) {
      return { maxIterations: n };
    }
  }
  return {};
}

export function registerRunners(registry: RunnerRegistry, _opts: RegisterRunnersOptions): void {
  registry.register("tiny-pass", async (ctx: RunnerContext): Promise<NodeOutput> => {
    const nodeIdStr = String(ctx.node.id);
    const failAt = process.env.SHAMU_TINY_FLOW_FAIL_AT;
    const throwAt = process.env.SHAMU_TINY_FLOW_THROW_AT;
    const cacheProbe = process.env.SHAMU_TINY_FLOW_CACHE_PROBE;
    const cacheProbeFile = process.env.SHAMU_TINY_FLOW_CACHE_PROBE_FILE;

    if (
      cacheProbe === nodeIdStr &&
      typeof cacheProbeFile === "string" &&
      cacheProbeFile.length > 0
    ) {
      appendFileSync(cacheProbeFile, `${nodeIdStr}\n`);
    }

    if (throwAt === nodeIdStr) {
      throw new Error(`tiny-flow: forced throw at ${nodeIdStr}`);
    }

    if (failAt === nodeIdStr) {
      return {
        ok: false,
        value: null,
        costUsd: null,
        costConfidence: "unknown",
        costSource: "tiny-flow",
        error: { message: `tiny-flow: forced failure at ${nodeIdStr}`, retriable: false },
      };
    }

    const costRaw = process.env.SHAMU_TINY_FLOW_COST;
    const cost = typeof costRaw === "string" && costRaw.length > 0 ? Number(costRaw) : null;

    return {
      ok: true,
      value: { label: nodeIdStr, task: readTask(ctx) },
      costUsd: Number.isFinite(cost ?? Number.NaN) ? (cost as number) : null,
      costConfidence: "estimate",
      costSource: "tiny-flow",
    };
  });
}

function readTask(ctx: RunnerContext): unknown {
  const inputs = ctx.inputs as Record<string, unknown>;
  const initial = (inputs.initial ?? {}) as Record<string, unknown>;
  return initial.task ?? null;
}
