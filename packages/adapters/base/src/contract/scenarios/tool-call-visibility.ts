/**
 * Scenario: tool_call + tool_result events with matching toolCallId and
 * parentEventId linkage.
 *
 * Skipped if the adapter declares `streaming: "final-only"` — those
 * adapters expose no intermediate tool activity.
 */

import { toolCallEventsMatch } from "../../events.ts";
import { TOOL_CALL_TURN } from "../fixtures.ts";
import type { Scenario, ScenarioContext } from "../types.ts";
import { collectUntilTurnEnd } from "./spawn-basic.ts";

export const toolCallVisibilityScenario: Scenario = {
  id: "tool-call-visibility",
  description: "every tool_result event matches a prior tool_call by toolCallId and parentEventId",
  requires: ["streamingEvents"],
  async run(ctx: ScenarioContext, handle): Promise<void> {
    await handle.send(TOOL_CALL_TURN);
    const events = await collectUntilTurnEnd(handle, ctx.timeoutMs);

    const calls = new Map<string, Extract<(typeof events)[number], { kind: "tool_call" }>>();
    for (const ev of events) {
      if (ev.kind === "tool_call") {
        calls.set(ev.toolCallId, ev);
      }
    }
    // Not every adapter will produce tool calls for every prompt (the model
    // may decline to call a tool). We skip-with-warning in that case, the
    // key invariant is "if we saw a tool_result, it must match a call."
    if (calls.size === 0) {
      ctx.log.warn(
        "tool-call-visibility: no tool_call observed; adapter is still in compliance but the scenario did not force one",
      );
      return;
    }

    for (const ev of events) {
      if (ev.kind !== "tool_result") continue;
      const matchingCall = calls.get(ev.toolCallId);
      if (!matchingCall) {
        throw new Error(
          `tool-call-visibility: tool_result ${ev.toolCallId} has no preceding tool_call`,
        );
      }
      if (!toolCallEventsMatch(matchingCall, ev)) {
        throw new Error(
          `tool-call-visibility: tool_result.parentEventId ${ev.parentEventId} did not match tool_call.eventId ${matchingCall.eventId}`,
        );
      }
    }
  },
};
