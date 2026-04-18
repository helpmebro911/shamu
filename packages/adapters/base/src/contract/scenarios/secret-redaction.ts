/**
 * Scenario: a planted secret round-trips through the adapter's event stream
 * redacted.
 *
 * The adapter is presumed to run its events through the shared redactor
 * before emission (the acceptance-criteria row is explicit on this). We
 * plant `PLANTED_SECRET` in the user turn, drain the event stream, and
 * assert the raw secret does not appear verbatim in any event payload.
 */

import { assertPlantedSecretScrubbed, SECRET_TURN } from "../fixtures.ts";
import type { Scenario, ScenarioContext } from "../types.ts";
import { collectUntilTurnEnd } from "./spawn-basic.ts";

export const secretRedactionScenario: Scenario = {
  id: "secret-redaction",
  description: "planted API-key strings in prompts/tool-args appear redacted in event payloads",
  requires: [],
  async run(ctx: ScenarioContext, handle): Promise<void> {
    await handle.send(SECRET_TURN);
    const events = await collectUntilTurnEnd(handle, ctx.timeoutMs);

    for (const ev of events) {
      // We stringify the whole event payload (sans envelope fields, which
      // are ULIDs/ints and can't carry a secret).
      const copy = { ...ev } as Record<string, unknown>;
      delete copy.eventId;
      delete copy.parentEventId;
      delete copy.runId;
      delete copy.sessionId;
      delete copy.turnId;
      delete copy.rawRef;
      const body = JSON.stringify(copy);
      assertPlantedSecretScrubbed(body);
    }
  },
};
