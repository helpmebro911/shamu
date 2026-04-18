/**
 * Scenario: shutdown(reason) → handle events iterable completes, no subprocess
 * orphans remain.
 *
 * The adapter-level check for orphan subprocesses lives in the stress
 * scenario; here we just assert that `shutdown()` drains the event iterable
 * cleanly and surfaces a final `session_end` (if the adapter's events
 * iterable hadn't already completed).
 */

import type { Scenario, ScenarioContext } from "../types.ts";
import { withTimeout } from "./spawn-basic.ts";

export const shutdownScenario: Scenario = {
  id: "shutdown",
  description: "shutdown() drains the events iterable and does not leave the handle hung",
  requires: [],
  async run(ctx: ScenarioContext, handle): Promise<void> {
    await handle.send(ctx.helloTurn);

    // Drain a few events so the adapter is mid-flight, then shutdown.
    const drain = (async () => {
      let seen = 0;
      for await (const ev of handle.events) {
        seen += 1;
        if (seen >= 1 && ev.kind !== "session_start") {
          await handle.shutdown("scenario-shutdown");
        }
        if (ev.kind === "session_end") return;
      }
    })();

    // If the adapter doesn't surface session_end before the events iterable
    // completes, that's still valid — the `for await` loop exits cleanly.
    await withTimeout(drain, ctx.timeoutMs, "waiting for shutdown drain");
  },
};
