/**
 * Scenario: spawn → remember sessionId → resume → follow-up turn succeeds.
 *
 * Requires the `resume` capability. The scenario runs its own factory calls
 * because the shared harness is spawn-only; the factory is invoked twice
 * via `adapter.spawn` + `adapter.resume` directly.
 */

import { FOLLOWUP_TURN } from "../fixtures.ts";
import type { Scenario, ScenarioContext } from "../types.ts";
import { collectUntilTurnEnd } from "./spawn-basic.ts";

export const resumeWarmScenario: Scenario = {
  id: "resume-warm",
  description: "spawn, harvest sessionId, resume, follow-up turn yields turn_end",
  requires: ["resume"],
  async run(ctx: ScenarioContext, handle): Promise<void> {
    // First turn on the spawned handle — harvest sessionId.
    await handle.send(ctx.helloTurn);
    await collectUntilTurnEnd(handle, ctx.timeoutMs);

    const sessionId = handle.sessionId;
    if (!sessionId) {
      throw new Error(
        "resume-warm: adapter declared resume support but did not populate sessionId",
      );
    }

    await handle.shutdown("scenario-done");

    // Resume a fresh handle against the same session.
    const resumed = await ctx.adapter.resume(sessionId, ctx.spawnOpts);
    try {
      await resumed.send(FOLLOWUP_TURN);
      const events = await collectUntilTurnEnd(resumed, ctx.timeoutMs);
      if (!events.some((e) => e.kind === "turn_end")) {
        throw new Error("resume-warm: resumed handle did not emit turn_end");
      }
      if (resumed.sessionId !== sessionId) {
        throw new Error(
          `resume-warm: resumed sessionId ${resumed.sessionId} does not match original ${sessionId}`,
        );
      }
    } finally {
      await resumed.shutdown("scenario-cleanup");
    }
  },
};
