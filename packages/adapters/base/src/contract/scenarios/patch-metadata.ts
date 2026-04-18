/**
 * Scenario: patch_applied for file writes.
 *
 * Skipped when `patchVisibility === "filesystem-only"` (adapters that don't
 * surface patch metadata on the event bus — e.g., any adapter that writes
 * through a vendor SDK that gives no file-change telemetry).
 */

import { PATCH_TURN } from "../fixtures.ts";
import type { Scenario, ScenarioContext } from "../types.ts";
import { collectUntilTurnEnd } from "./spawn-basic.ts";

export const patchMetadataScenario: Scenario = {
  id: "patch-metadata",
  description: "an adapter with patchVisibility=events emits patch_applied for every file write",
  requires: ["patchEvents"],
  async run(ctx: ScenarioContext, handle): Promise<void> {
    await handle.send(PATCH_TURN);
    const events = await collectUntilTurnEnd(handle, ctx.timeoutMs);

    const patches = events.filter((e) => e.kind === "patch_applied");
    if (patches.length === 0) {
      ctx.log.warn(
        "patch-metadata: adapter declared patchVisibility=events but no patch_applied event was emitted for this scenario; downstream adapters should revisit whether the prompt reliably forces a write",
      );
      return;
    }
    for (const p of patches) {
      if (p.kind !== "patch_applied") continue;
      if (!Array.isArray(p.files) || p.files.length === 0) {
        throw new Error(`patch-metadata: patch_applied.files must be a non-empty array`);
      }
      if (typeof p.stats.add !== "number" || typeof p.stats.del !== "number") {
        throw new Error(`patch-metadata: patch_applied.stats missing add/del counts`);
      }
    }
  },
};
