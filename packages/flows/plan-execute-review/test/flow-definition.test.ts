import { topologicalOrder } from "@shamu/core-flow/engine";
import { describe, expect, test } from "vitest";
import { flowDefinition } from "../src/flow.ts";

describe("flowDefinition", () => {
  test("has exactly the four expected nodes with the expected ids", () => {
    expect(flowDefinition.id).toBe("plan-execute-review");
    expect(flowDefinition.version).toBe(1);
    expect(flowDefinition.entry).toBe("plan");
    const ids = flowDefinition.nodes.map((n) => n.id).sort();
    expect(ids).toEqual(["execute", "loop", "plan", "review"].sort());
  });

  test("round-trips through JSON.stringify / JSON.parse losslessly", () => {
    const json = JSON.stringify(flowDefinition);
    const parsed = JSON.parse(json);
    expect(parsed).toEqual(flowDefinition);
  });

  test("topo-sorts cleanly (no cycles, all dependsOn resolvable)", () => {
    const order = topologicalOrder(flowDefinition);
    // NodeId is a branded string; compare via the raw string value.
    const orderIds: string[] = order.map((n) => String(n.id));
    // plan must come before execute; execute before review; review before loop.
    expect(orderIds.indexOf("plan")).toBeLessThan(orderIds.indexOf("execute"));
    expect(orderIds.indexOf("execute")).toBeLessThan(orderIds.indexOf("review"));
    expect(orderIds.indexOf("review")).toBeLessThan(orderIds.indexOf("loop"));
  });

  test("plan node has role planner and runner planner, no deps, maxRetries 1", () => {
    const plan = flowDefinition.nodes.find((n) => n.id === "plan");
    expect(plan).toBeDefined();
    if (plan?.kind !== "agent_step") throw new Error("plan should be AgentStep");
    expect(plan.role).toBe("planner");
    expect(plan.runner).toBe("planner");
    expect(plan.dependsOn).toEqual([]);
    expect(plan.maxRetries).toBe(1);
  });

  test("execute node depends on plan, maxRetries 2", () => {
    const exec = flowDefinition.nodes.find((n) => n.id === "execute");
    if (exec?.kind !== "agent_step") throw new Error("execute should be AgentStep");
    expect(exec.role).toBe("executor");
    expect(exec.runner).toBe("executor");
    expect(exec.dependsOn).toEqual(["plan"]);
    expect(exec.maxRetries).toBe(2);
  });

  test("review node depends on execute, role reviewer", () => {
    const review = flowDefinition.nodes.find((n) => n.id === "review");
    if (review?.kind !== "agent_step") throw new Error("review should be AgentStep");
    expect(review.role).toBe("reviewer");
    expect(review.runner).toBe("reviewer");
    expect(review.dependsOn).toEqual(["execute"]);
    expect(review.maxRetries).toBe(1);
  });

  test("loop node uses loop-predicate and maxIterations 5", () => {
    const loop = flowDefinition.nodes.find((n) => n.id === "loop");
    if (loop?.kind !== "loop") throw new Error("loop should be Loop");
    expect(loop.until).toBe("loop-predicate");
    expect(loop.maxIterations).toBe(5);
    expect(loop.dependsOn).toEqual(["review"]);
  });
});
