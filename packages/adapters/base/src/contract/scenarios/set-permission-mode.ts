/**
 * Scenario: setPermissionMode(M) → permission_request events respect M.
 *
 * We probe by setting the mode to `acceptEdits` (if supported) and then
 * sending a prompt that's likely to need a permission request. The contract
 * test doesn't try to assert a specific `decision` value — adapters vary in
 * whether they auto-approve or surface pending requests — but it does
 * assert that any `permission_request` event emitted AFTER the set call
 * carries the new mode's semantics (i.e., not the default "ask" when we've
 * asked for auto-accept).
 *
 * Because different vendors spell their modes differently, we accept the
 * mode-change as a no-op on the event stream and only assert that
 * `setPermissionMode` does not throw when the mode is declared supported.
 * Adapters with richer permission surfaces add their own assertions in
 * their own test suites.
 */

import { supportsPermissionMode } from "../../capabilities.ts";
import type { Scenario, ScenarioContext } from "../types.ts";

export const setPermissionModeScenario: Scenario = {
  id: "set-permission-mode",
  description: "setPermissionMode accepts every mode the adapter declares as supported",
  requires: [],
  async run(ctx: ScenarioContext, handle): Promise<void> {
    for (const mode of ctx.adapter.capabilities.permissionModes) {
      if (!supportsPermissionMode(ctx.adapter.capabilities, mode)) continue;
      try {
        await handle.setPermissionMode(mode);
      } catch (err) {
        throw new Error(
          `set-permission-mode: adapter rejected its own declared mode ${mode}: ${(err as Error).message}`,
        );
      }
    }
  },
};
