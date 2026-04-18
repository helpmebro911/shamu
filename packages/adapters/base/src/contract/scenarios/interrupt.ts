/**
 * Scenario: interrupt() publishes an `interrupt` event; next `turn_end` or
 * `error` arrives within 10 seconds.
 *
 * Subtle detail: `AgentHandle.events` may or may not support multiple
 * `for await` consumers depending on the adapter's implementation. The
 * contract only requires "async iterable", not "multi-cast". We therefore
 * pull events through a single async iteration and track state with flags.
 */

import type { AgentEvent } from "../../events.ts";
import { LONG_TURN } from "../fixtures.ts";
import type { Scenario, ScenarioContext } from "../types.ts";
import { withTimeout } from "./spawn-basic.ts";

/** Hard ceiling from the acceptance table. */
const INTERRUPT_BUDGET_MS = 10_000;

export const interruptScenario: Scenario = {
  id: "interrupt",
  description:
    "interrupt() publishes an interrupt event; the handle reaches turn_end or error within 10s",
  requires: ["interrupt"],
  async run(_ctx: ScenarioContext, handle): Promise<void> {
    await handle.send(LONG_TURN);

    const seen: AgentEvent[] = [];
    let sawInterrupt = false;
    let closed = false;
    const interruptTrigger = new Promise<void>((resolve) => {
      // Trigger interrupt once we've observed at least one event — some
      // vendors drop interrupts that land before stream open.
      const waitForFirst = setInterval(() => {
        if (seen.length > 0) {
          clearInterval(waitForFirst);
          handle.interrupt("contract-suite").then(resolve, resolve);
        }
      }, 10);
      // Safety: fire the interrupt after a small fixed delay even if no
      // events appear, so a broken adapter cannot hang the suite.
      setTimeout(() => {
        clearInterval(waitForFirst);
        handle.interrupt("contract-suite").then(resolve, resolve);
      }, 500);
    });

    const drain = (async () => {
      for await (const ev of handle.events) {
        seen.push(ev);
        if (ev.kind === "interrupt") sawInterrupt = true;
        if (ev.kind === "turn_end" || ev.kind === "error") {
          closed = true;
          return;
        }
      }
    })();

    await interruptTrigger;
    await withTimeout(drain, INTERRUPT_BUDGET_MS, "waiting for turn_end/error after interrupt");

    if (!sawInterrupt) {
      throw new Error(
        `interrupt: no interrupt event in stream: ${seen.map((e) => e.kind).join(", ")}`,
      );
    }
    if (!closed) {
      throw new Error("interrupt: neither turn_end nor error observed after interrupt");
    }
  },
};
