/**
 * Scenario: usage per turn; cost with capability-driven source.
 *
 * `usage` is skipped when `usageReporting === "none"`.
 * `cost` is always required — even when `costReporting: "unknown"` the
 * adapter must emit a `cost` event with `usd=null` and `source="unknown"`.
 */

import type { Scenario, ScenarioContext } from "../types.ts";
import { collectUntilTurnEnd } from "./spawn-basic.ts";

export const usageAndCostScenario: Scenario = {
  id: "usage-and-cost",
  description:
    "usage is emitted per turn; cost event carries a source matching the declared capability",
  requires: [],
  async run(ctx: ScenarioContext, handle): Promise<void> {
    await handle.send(ctx.helloTurn);
    const events = await collectUntilTurnEnd(handle, ctx.timeoutMs);

    const caps = ctx.adapter.capabilities;

    if (caps.usageReporting !== "none") {
      const usage = events.filter((e) => e.kind === "usage");
      if (usage.length === 0) {
        throw new Error(
          `usage-and-cost: usageReporting=${caps.usageReporting} declares usage events but none emitted`,
        );
      }
    }

    const cost = events.find((e) => e.kind === "cost");
    if (!cost || cost.kind !== "cost") {
      throw new Error("usage-and-cost: expected a cost event, got none");
    }
    switch (caps.costReporting) {
      case "native":
        if (cost.confidence !== "exact" || cost.usd === null) {
          throw new Error(
            `usage-and-cost: costReporting=native requires confidence=exact and usd!=null; got ${JSON.stringify(cost)}`,
          );
        }
        break;
      case "computed":
        if (cost.confidence !== "estimate") {
          throw new Error(
            `usage-and-cost: costReporting=computed requires confidence=estimate; got ${cost.confidence}`,
          );
        }
        break;
      case "subscription":
        if (cost.usd !== null || cost.confidence !== "unknown") {
          throw new Error(
            `usage-and-cost: costReporting=subscription requires usd=null and confidence=unknown; got ${JSON.stringify(cost)}`,
          );
        }
        break;
      case "unknown":
        if (cost.usd !== null) {
          throw new Error(
            `usage-and-cost: costReporting=unknown requires usd=null; got ${cost.usd}`,
          );
        }
        break;
      default:
        throw new Error(
          `usage-and-cost: capability costReporting has unexpected value: ${caps.costReporting}`,
        );
    }
  },
};
