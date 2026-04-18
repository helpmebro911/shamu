/**
 * Capability helpers for adapters.
 *
 * Re-exports the `Capabilities` / `PermissionMode` types and the
 * `loadCapabilities` + `freezeCapabilities` entry points from `@shamu/shared`,
 * plus a handful of adapter-side helpers:
 *
 * - `assertCapability(caps, name)` — throw if the adapter declared the feature
 *   unsupported but a caller asks for it anyway. Used by the adapter shell to
 *   guard `setModel` / `setPermissionMode` / `resume` call sites.
 * - `supportsCapability(caps, name)` — pure boolean check used by the
 *   contract suite to decide whether a scenario should run or self-skip.
 * - `requireInterrupt` / `requireResume` / `requirePatchEvents` — targeted
 *   predicates that encode the meaning of each `Capabilities` field without
 *   the contract-suite having to memorize the enum values.
 */

import {
  type Capabilities,
  freezeCapabilities,
  loadCapabilities,
  type PermissionMode,
} from "@shamu/shared/capabilities";
import { ContractViolationError } from "./errors.ts";

export type { Capabilities, PermissionMode };
export { freezeCapabilities, loadCapabilities };

/**
 * A capability "feature" predicate. Each predicate answers a single question
 * about a frozen `Capabilities` object. The contract suite keys its skip-list
 * off these names.
 */
export type CapabilityFeature =
  | "resume"
  | "fork"
  | "interrupt"
  | "customTools"
  | "patchEvents"
  | "usageReporting"
  | "costReporting"
  | "streamingEvents";

const featurePredicates: Readonly<Record<CapabilityFeature, (c: Capabilities) => boolean>> = {
  resume: (c) => c.resume === true,
  fork: (c) => c.fork === true,
  interrupt: (c) => c.interrupt !== "none",
  customTools: (c) => c.customTools === true,
  // `patchEvents` is adapter-observable only when `patchVisibility === "events"`.
  patchEvents: (c) => c.patchVisibility === "events",
  usageReporting: (c) => c.usageReporting !== "none",
  costReporting: (c) => c.costReporting !== "unknown",
  streamingEvents: (c) => c.streaming === "events",
};

/**
 * Non-throwing feature check. Returns true iff the adapter has declared the
 * feature as supported.
 *
 * Pure + allocation-free — a contract-suite inner loop is allowed to call it
 * for every scenario without worrying about cost.
 */
export function supportsCapability(caps: Capabilities, feature: CapabilityFeature): boolean {
  return featurePredicates[feature](caps);
}

/**
 * Throwing feature check. Raises `ContractViolationError` if the feature is
 * declared unsupported. Call sites use this to trip loudly when the adapter
 * shell's API surface is invoked for a capability the adapter disclaimed.
 */
export function assertCapability(caps: Capabilities, feature: CapabilityFeature): void {
  if (!supportsCapability(caps, feature)) {
    throw new ContractViolationError(
      `Capability ${feature} is declared unsupported by this adapter (capabilities: ${JSON.stringify(
        caps,
      )})`,
    );
  }
}

/**
 * True iff the adapter declares support for the given `PermissionMode`.
 *
 * The contract suite's `set-permission-mode` scenario uses this to pick a
 * mode the adapter has actually promised to honor.
 */
export function supportsPermissionMode(caps: Capabilities, mode: PermissionMode): boolean {
  return caps.permissionModes.includes(mode);
}
