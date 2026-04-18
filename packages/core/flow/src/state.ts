/**
 * Serializable flow-run state.
 *
 * PLAN.md § 8: "Flow state persists to `flow_runs(... state_json ...)`.
 * Any flow can resume against its last completed node; node outputs are
 * content-hashed so reruns deduplicate."
 *
 * `FlowRunState` is the object the engine threads through every node.
 * It is written to SQLite via `@shamu/persistence/queries/flow-runs` as
 * a single JSON blob. Serialization must therefore be lossless and
 * validated on the way back in — a malformed blob (schema drift, manual
 * edit) must fail loudly, not silently corrupt a resume.
 *
 * Sentinel rules on serialize (enforced at runtime):
 *   - Date / BigInt / undefined / functions / symbols at any depth throw
 *     with a clear message. The engine never produces these, but defensive
 *     serialization catches a caller who wedges one in via `initialInputs`
 *     or a misbehaving runner.
 *   - The resulting string is valid JSON (a JSON.parse round-trip tests
 *     this in the test suite).
 *
 * Deserialize uses a Zod schema. The schema is exported so higher layers
 * can reuse it for shape checks (CLI inspect command, dashboard payload
 * validation).
 */

import type { WorkflowRunId } from "@shamu/shared/ids";
import { workflowRunId as brandWorkflowRunId } from "@shamu/shared/ids";
import { z } from "zod";
import type { NodeCostConfidence, NodeId, NodeOutput } from "./types.ts";
import { nodeId as brandNodeId } from "./types.ts";

export type NodeRuntimeStatus = "pending" | "running" | "succeeded" | "failed" | "paused";

/**
 * Persisted output with the content hash used to detect a cache hit.
 * Separating `completedAt` from the output itself lets future features
 * (replay, cost-by-day) query without parsing the payload.
 */
export interface PersistedNodeOutput {
  readonly hash: string;
  readonly output: NodeOutput;
  readonly completedAt: number;
}

/**
 * Cost sample entry. The engine appends one per completed node that
 * produced a non-cached output (cached replays do not add new samples;
 * they reuse the original entry via the cost-roll-up on FlowCompleted).
 */
export interface CostSample {
  readonly usd: number | null;
  readonly confidence: NodeCostConfidence;
  readonly source: string;
}

/**
 * Pending human-gate entry. When populated, the flow is paused and the
 * caller supplies the token back through a resume to continue.
 */
export interface PendingGate {
  readonly nodeId: NodeId;
  readonly resumeToken: string;
}

export interface FlowRunState {
  readonly flowRunId: WorkflowRunId;
  readonly flowId: string;
  readonly version: number;
  readonly entry: NodeId;
  readonly nodeStatus: Readonly<Record<string, NodeRuntimeStatus>>;
  readonly nodeOutputs: Readonly<Record<string, PersistedNodeOutput>>;
  readonly pendingGate: PendingGate | null;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly totalCostUsd: number | null;
  readonly costSamples: readonly CostSample[];
}

// --- Zod schemas ------------------------------------------------------------

const nodeErrorSchema = z.object({
  message: z.string(),
  retriable: z.boolean(),
});

const nodeOutputSchema = z.object({
  ok: z.boolean(),
  value: z.unknown(),
  costUsd: z.number().nullable(),
  costConfidence: z.enum(["exact", "estimate", "unknown"]),
  costSource: z.string(),
  error: nodeErrorSchema.optional(),
});

const persistedNodeOutputSchema = z.object({
  hash: z.string().min(1),
  output: nodeOutputSchema,
  completedAt: z.number().int().nonnegative(),
});

const costSampleSchema = z.object({
  usd: z.number().nullable(),
  confidence: z.enum(["exact", "estimate", "unknown"]),
  source: z.string(),
});

const pendingGateSchema = z.object({
  nodeId: z.string().min(1),
  resumeToken: z.string().min(1),
});

export const flowRunStateSchema = z.object({
  flowRunId: z.string().min(1),
  flowId: z.string().min(1),
  version: z.number().int().nonnegative(),
  entry: z.string().min(1),
  nodeStatus: z.record(z.string(), z.enum(["pending", "running", "succeeded", "failed", "paused"])),
  nodeOutputs: z.record(z.string(), persistedNodeOutputSchema),
  pendingGate: pendingGateSchema.nullable(),
  startedAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  totalCostUsd: z.number().nullable(),
  costSamples: z.array(costSampleSchema),
});

// --- Serialize / deserialize -----------------------------------------------

/**
 * Depth-first sentinel check. Throws with a clear, path-annotated message
 * if it hits a value that must not be persisted. Kept conservative: Map,
 * Set, Date, RegExp, and any Error subclass are all rejected because
 * round-tripping them through JSON would silently change their identity.
 */
function assertSerializable(value: unknown, path: string, seen: WeakSet<object>): void {
  if (value === null) return;
  const t = typeof value;
  if (t === "undefined") {
    throw new TypeError(`serialize(FlowRunState): undefined at ${path}`);
  }
  if (t === "function") {
    throw new TypeError(`serialize(FlowRunState): function at ${path}`);
  }
  if (t === "symbol") {
    throw new TypeError(`serialize(FlowRunState): symbol at ${path}`);
  }
  if (t === "bigint") {
    throw new TypeError(`serialize(FlowRunState): bigint at ${path}`);
  }
  if (t === "number") {
    const n = value as number;
    if (!Number.isFinite(n)) {
      throw new TypeError(`serialize(FlowRunState): non-finite number at ${path}`);
    }
    return;
  }
  if (t === "string" || t === "boolean") return;
  // Object-ish.
  if (value instanceof Date) {
    throw new TypeError(`serialize(FlowRunState): Date at ${path} (use epoch ms instead)`);
  }
  if (value instanceof Map || value instanceof Set || value instanceof RegExp) {
    throw new TypeError(`serialize(FlowRunState): non-JSON container at ${path}`);
  }
  const obj = value as object;
  if (seen.has(obj)) {
    throw new TypeError(`serialize(FlowRunState): cycle at ${path}`);
  }
  seen.add(obj);
  try {
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        assertSerializable(value[i], `${path}[${i}]`, seen);
      }
      return;
    }
    const rec = value as Record<string, unknown>;
    for (const key of Object.keys(rec)) {
      assertSerializable(rec[key], `${path}.${key}`, seen);
    }
  } finally {
    seen.delete(obj);
  }
}

export function serialize(state: FlowRunState): string {
  assertSerializable(state, "$", new WeakSet());
  return JSON.stringify(state);
}

/**
 * Parse and validate. Throws a TypeError with Zod's message on schema
 * violation so callers can surface it uniformly.
 */
export function deserialize(s: string): FlowRunState {
  let raw: unknown;
  try {
    raw = JSON.parse(s);
  } catch (cause) {
    throw new TypeError(
      `deserialize(FlowRunState): invalid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  const parsed = flowRunStateSchema.safeParse(raw);
  if (!parsed.success) {
    throw new TypeError(`deserialize(FlowRunState): schema violation: ${parsed.error.message}`);
  }
  // Re-apply branded-ID wrappers. Zod gives us plain strings; the runtime
  // shape is identical, but we want the TS types to be the branded flavor
  // so callers don't need to re-cast.
  return normalizeState(parsed.data);
}

function normalizeState(raw: z.infer<typeof flowRunStateSchema>): FlowRunState {
  const entryId = brandNodeId(raw.entry);
  const nodeStatus: Record<string, NodeRuntimeStatus> = {};
  for (const [k, v] of Object.entries(raw.nodeStatus)) {
    nodeStatus[k] = v;
  }
  const nodeOutputs: Record<string, PersistedNodeOutput> = {};
  for (const [k, v] of Object.entries(raw.nodeOutputs)) {
    // Zod emits `error?: T | undefined`; under exactOptionalPropertyTypes
    // we need to either include the key with a concrete value or omit it.
    const output: NodeOutput =
      v.output.error === undefined
        ? {
            ok: v.output.ok,
            value: v.output.value,
            costUsd: v.output.costUsd,
            costConfidence: v.output.costConfidence,
            costSource: v.output.costSource,
          }
        : {
            ok: v.output.ok,
            value: v.output.value,
            costUsd: v.output.costUsd,
            costConfidence: v.output.costConfidence,
            costSource: v.output.costSource,
            error: v.output.error,
          };
    nodeOutputs[k] = {
      hash: v.hash,
      output,
      completedAt: v.completedAt,
    };
  }
  return {
    flowRunId: brandWorkflowRunId(raw.flowRunId),
    flowId: raw.flowId,
    version: raw.version,
    entry: entryId,
    nodeStatus,
    nodeOutputs,
    pendingGate:
      raw.pendingGate === null
        ? null
        : {
            nodeId: brandNodeId(raw.pendingGate.nodeId),
            resumeToken: raw.pendingGate.resumeToken,
          },
    startedAt: raw.startedAt,
    updatedAt: raw.updatedAt,
    totalCostUsd: raw.totalCostUsd,
    costSamples: raw.costSamples,
  };
}

/**
 * Construct an empty state for a fresh flow run. Convenience for the
 * engine; callers who resume supply their own state instead.
 */
export function emptyState(input: {
  readonly flowRunId: WorkflowRunId;
  readonly flowId: string;
  readonly version: number;
  readonly entry: NodeId;
  readonly startedAt: number;
}): FlowRunState {
  return {
    flowRunId: input.flowRunId,
    flowId: input.flowId,
    version: input.version,
    entry: input.entry,
    nodeStatus: {},
    nodeOutputs: {},
    pendingGate: null,
    startedAt: input.startedAt,
    updatedAt: input.startedAt,
    totalCostUsd: null,
    costSamples: [],
  };
}
