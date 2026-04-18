/**
 * T17 (threat-model): authoritative cost-confidence stamping.
 *
 * PLAN.md § 7 rule: the `confidence` + `source` on a `cost` event are
 * assigned by the CORE from the adapter's declared `costReporting`
 * capability — NOT from whatever the adapter writes at runtime. A
 * compromised adapter that wants to evade budget enforcement cannot simply
 * emit `confidence: "exact"` on a subscription run; the core overrides.
 *
 * Lives in `@shamu/adapters-base` rather than `@shamu/shared` because the
 * seam is tight to the adapter contract (it takes the same `Capabilities`
 * type the contract does) and the CLI already imports from this package for
 * its ingestion loop. Moving to `@shamu/shared` would require duplicating
 * the capability-shape import graph without buying any downstream reuse.
 *
 * This helper is a pure function — the caller (CLI / Phase 3 supervisor)
 * decides when to apply it (typically right before the event is persisted
 * to `events`).
 */

import type { Capabilities } from "@shamu/shared/capabilities";
import type { AgentEvent } from "@shamu/shared/events";

/**
 * Apply core-authoritative confidence + source tags to a `cost` event based
 * on the adapter's declared `costReporting`. Non-cost events are returned
 * unchanged.
 *
 * Truth table (mirrors PLAN § 7):
 *
 * | costReporting  | usd     | confidence  | source         |
 * |----------------|---------|-------------|----------------|
 * | native         | keep    | "exact"     | "vendor"       |
 * | computed       | keep    | "estimate"  | "computed"     |
 * | subscription   | null    | "unknown"   | "subscription" |
 * | unknown        | null    | "unknown"   | "unknown"      |
 *
 * The `usd` field is clobbered to `null` for subscription + unknown so a
 * bug in the adapter that "accidentally" reports a cost on a subscription
 * capability cannot skew aggregation.
 */
export function stampCostEventFromCapability(
  event: AgentEvent,
  capability: Capabilities["costReporting"],
): AgentEvent {
  if (event.kind !== "cost") return event;

  switch (capability) {
    case "native":
      return {
        ...event,
        confidence: "exact",
        source: "vendor",
      };
    case "computed":
      return {
        ...event,
        confidence: "estimate",
        source: "computed",
      };
    case "subscription":
      // Subscription: vendor does not itemize per-run spend. Clobber usd to
      // null so an accidental adapter-side estimate doesn't show up in
      // budget accounting (T17).
      return {
        ...event,
        usd: null,
        confidence: "unknown",
        source: "subscription",
      };
    case "unknown":
      return {
        ...event,
        usd: null,
        confidence: "unknown",
        source: "unknown",
      };
  }
}
