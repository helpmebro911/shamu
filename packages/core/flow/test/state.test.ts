import { newWorkflowRunId } from "@shamu/shared/ids";
import { describe, expect, it } from "vitest";
import type { FlowRunState } from "../src/state.ts";
import { deserialize, emptyState, serialize } from "../src/state.ts";
import { nodeId } from "../src/types.ts";

function sample(): FlowRunState {
  return {
    flowRunId: newWorkflowRunId(),
    flowId: "test-flow",
    version: 1,
    entry: nodeId("a"),
    nodeStatus: { a: "succeeded", b: "pending" },
    nodeOutputs: {
      a: {
        hash: "abc",
        output: {
          ok: true,
          value: { text: "done" },
          costUsd: 0.01,
          costConfidence: "exact",
          costSource: "vendor",
        },
        completedAt: 1_700_000_000_000,
      },
    },
    pendingGate: null,
    startedAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    totalCostUsd: 0.01,
    costSamples: [{ usd: 0.01, confidence: "exact", source: "vendor" }],
  };
}

describe("FlowRunState", () => {
  it("emptyState seeds consistent defaults", () => {
    const flowRunId = newWorkflowRunId();
    const s = emptyState({
      flowRunId,
      flowId: "f",
      version: 1,
      entry: nodeId("e"),
      startedAt: 42,
    });
    expect(s.flowRunId).toBe(flowRunId);
    expect(s.nodeStatus).toEqual({});
    expect(s.nodeOutputs).toEqual({});
    expect(s.pendingGate).toBeNull();
    expect(s.totalCostUsd).toBeNull();
    expect(s.costSamples).toEqual([]);
    expect(s.startedAt).toBe(42);
    expect(s.updatedAt).toBe(42);
  });

  it("serialize + deserialize is a round-trip", () => {
    const original = sample();
    const round = deserialize(serialize(original));
    expect(round.flowRunId).toBe(original.flowRunId);
    expect(round.flowId).toBe(original.flowId);
    expect(round.version).toBe(original.version);
    expect(round.entry).toBe(original.entry);
    expect(round.nodeStatus).toEqual(original.nodeStatus);
    expect(round.nodeOutputs).toEqual(original.nodeOutputs);
    expect(round.totalCostUsd).toBe(original.totalCostUsd);
    expect(round.costSamples).toEqual(original.costSamples);
  });

  it("deserialize rejects invalid JSON", () => {
    expect(() => deserialize("not json")).toThrow(/invalid JSON/);
  });

  it("deserialize rejects schema violations", () => {
    const bad = JSON.stringify({ flowRunId: "x", flowId: "y" });
    expect(() => deserialize(bad)).toThrow(/schema violation/);
  });

  it("deserialize rejects unknown status values", () => {
    const s = sample();
    const blob = JSON.parse(serialize(s)) as Record<string, unknown>;
    (blob.nodeStatus as Record<string, unknown>).a = "garbage";
    expect(() => deserialize(JSON.stringify(blob))).toThrow(/schema violation/);
  });

  it("serialize rejects Date values anywhere in the tree", () => {
    const s = sample();
    const corrupt = {
      ...s,
      nodeOutputs: {
        a: {
          hash: "abc",
          output: {
            ok: true,
            value: new Date(0),
            costUsd: null,
            costConfidence: "unknown" as const,
            costSource: "",
          },
          completedAt: 0,
        },
      },
    };
    expect(() => serialize(corrupt)).toThrow(/Date/);
  });

  it("serialize rejects undefined values anywhere in the tree", () => {
    const s = sample();
    const corrupt = {
      ...s,
      nodeOutputs: {
        a: {
          hash: "abc",
          output: {
            ok: true,
            value: { evil: undefined as unknown as string },
            costUsd: null,
            costConfidence: "unknown" as const,
            costSource: "",
          },
          completedAt: 0,
        },
      },
    };
    expect(() => serialize(corrupt)).toThrow(/undefined/);
  });

  it("serialize rejects bigint values", () => {
    const s = sample();
    const corrupt = {
      ...s,
      totalCostUsd: 1n as unknown as number,
    };
    expect(() => serialize(corrupt)).toThrow(/bigint/);
  });

  it("serialize rejects cycles", () => {
    const s = sample();
    const mutable = { ...s, costSamples: [...s.costSamples] };
    const cycle: Record<string, unknown> = { a: 1 };
    cycle.self = cycle;
    const corrupt = {
      ...mutable,
      nodeOutputs: {
        a: {
          hash: "abc",
          output: {
            ok: true,
            value: cycle,
            costUsd: null,
            costConfidence: "unknown" as const,
            costSource: "",
          },
          completedAt: 0,
        },
      },
    };
    expect(() => serialize(corrupt)).toThrow(/cycle/);
  });
});
