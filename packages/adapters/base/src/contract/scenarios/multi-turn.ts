/**
 * Scenario: send follow-up, correlated turn_id.
 *
 * Two send()/turn_end cycles on the same handle; assert the `turnId` on
 * events in the second cycle differs from the first, and that every event
 * within a cycle shares the same turnId.
 */

import { FOLLOWUP_TURN } from "../fixtures.ts";
import type { Scenario, ScenarioContext } from "../types.ts";
import { collectUntilTurnEnd } from "./spawn-basic.ts";

export const multiTurnScenario: Scenario = {
  id: "multi-turn",
  description:
    "two consecutive turns on one handle carry distinct turnIds with internal consistency",
  requires: [],
  async run(ctx: ScenarioContext, handle): Promise<void> {
    await handle.send(ctx.helloTurn);
    const first = await collectUntilTurnEnd(handle, ctx.timeoutMs);

    await handle.send(FOLLOWUP_TURN);
    const second = await collectUntilTurnEnd(handle, ctx.timeoutMs);

    const firstTurnIds = new Set(first.map((e) => e.turnId));
    const secondTurnIds = new Set(second.map((e) => e.turnId));

    if (firstTurnIds.size !== 1) {
      throw new Error(
        `multi-turn: first cycle carried multiple turnIds: ${[...firstTurnIds].join(", ")}`,
      );
    }
    if (secondTurnIds.size !== 1) {
      throw new Error(
        `multi-turn: second cycle carried multiple turnIds: ${[...secondTurnIds].join(", ")}`,
      );
    }
    const firstId = [...firstTurnIds][0];
    const secondId = [...secondTurnIds][0];
    if (firstId === secondId) {
      throw new Error(`multi-turn: turnId ${firstId} was reused between cycles`);
    }
  },
};
