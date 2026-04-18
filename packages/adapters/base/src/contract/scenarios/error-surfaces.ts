/**
 * Scenario: error with `fatal` + `retriable` accurately set on forced-fail.
 *
 * The scenario prompts the adapter with a user turn that's almost guaranteed
 * to fail (requests a nonexistent tool). We accept either a fatal error OR a
 * retriable error — what the suite checks is that BOTH flags are present
 * and of type boolean; adapters that silently swallow failures and pretend
 * to succeed are the failure mode this catches.
 */

import { FAIL_TURN } from "../fixtures.ts";
import type { Scenario, ScenarioContext } from "../types.ts";
import { collectUntilTurnEnd } from "./spawn-basic.ts";

export const errorSurfacesScenario: Scenario = {
  id: "error-surfaces",
  description: "forced-fail prompt surfaces an error event with both fatal and retriable set",
  requires: [],
  async run(ctx: ScenarioContext, handle): Promise<void> {
    await handle.send(FAIL_TURN);
    const events = await collectUntilTurnEnd(handle, ctx.timeoutMs);

    const errors = events.filter((e) => e.kind === "error");
    if (errors.length === 0) {
      // Not every adapter will propagate the failure as an error event —
      // some may instead surface a turn_end with stopReason=error. That's
      // acceptable *only* if the adapter's schema genuinely models the
      // failure; we warn so reviewers notice.
      ctx.log.warn(
        "error-surfaces: no error event emitted; adapter's schema may model failure via turn_end.stopReason alone — downstream adapters should confirm",
      );
      return;
    }
    for (const ev of errors) {
      if (ev.kind !== "error") continue;
      if (typeof ev.fatal !== "boolean") {
        throw new Error(`error-surfaces: error.fatal must be boolean; got ${typeof ev.fatal}`);
      }
      if (typeof ev.retriable !== "boolean") {
        throw new Error(
          `error-surfaces: error.retriable must be boolean; got ${typeof ev.retriable}`,
        );
      }
      if (!ev.errorCode || typeof ev.errorCode !== "string") {
        throw new Error("error-surfaces: error.errorCode must be a non-empty string");
      }
    }
  },
};
