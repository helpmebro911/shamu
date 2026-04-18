/**
 * Scenario: setModel(X) → subsequent `usage` events report model=X.
 *
 * Skipped when `usageReporting === "none"` or the adapter declines the
 * `usageReporting` capability.
 */

import { FOLLOWUP_TURN } from "../fixtures.ts";
import type { Scenario, ScenarioContext } from "../types.ts";
import { collectUntilTurnEnd } from "./spawn-basic.ts";

export const setModelScenario: Scenario = {
  id: "set-model",
  description: "setModel() causes subsequent usage events to carry the new model id",
  requires: ["usageReporting"],
  async run(ctx: ScenarioContext, handle): Promise<void> {
    await handle.send(ctx.helloTurn);
    await collectUntilTurnEnd(handle, ctx.timeoutMs);

    const newModel = "model-from-set-model-scenario";
    await handle.setModel(newModel);

    await handle.send(FOLLOWUP_TURN);
    const events = await collectUntilTurnEnd(handle, ctx.timeoutMs);

    const usage = events.filter((e) => e.kind === "usage");
    if (usage.length === 0) {
      throw new Error("set-model: adapter declared usageReporting but emitted no usage events");
    }
    const latest = usage[usage.length - 1];
    if (!latest || latest.kind !== "usage") {
      throw new Error("set-model: unable to inspect latest usage event");
    }
    if (latest.model !== newModel) {
      throw new Error(
        `set-model: expected usage.model=${newModel}; got ${JSON.stringify(latest.model)}`,
      );
    }
  },
};
