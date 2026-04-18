/**
 * Structural event shapes the watchdog emits.
 *
 * PLAN.md § "Core architecture → 4 Supervisor" says escalations are
 * local domain events published on an in-memory bus; PLAN §6 adds that
 * watchdog alerts should be compatible with that pipe without this
 * package importing `@shamu/core-supervisor` directly. The composition
 * layer (wherever the supervisor bus is wired) takes a `WatchdogAlert`
 * and forwards it onto the supervisor's own `EscalationRaised` bus.
 *
 * The shape below is intentionally a superset of the fields the
 * supervisor's `EscalationRaised` carries so a forwarding shim is a
 * shallow field mapping — no translation tables.
 */
import type { WatchdogAlert, WatchdogCiTripwire, WatchdogHint } from "./types.ts";

/** Discriminated union of everything the watchdog emits. */
export type WatchdogEvent = WatchdogHint | WatchdogAlert | WatchdogCiTripwire;

/**
 * Emitter interface — the main loop takes any sink that implements this.
 * A test emitter captures the events into an array; the subprocess
 * wrapper writes each event as one JSON line to stdout.
 *
 * `emitCiTripwire` is a parallel channel for the cross-run per-role CI
 * counter (Phase 5.C). It is intentionally NOT routed through the
 * agreement buffer — the tripwire's semantics (same-signal counter
 * across runs, scoped by role) don't fit the buffer's "two different
 * signals within one run" rule. Default implementation delegates to
 * `emit` so callers that haven't overridden it still see the event
 * land as a `WatchdogEvent`.
 */
export interface WatchdogEmitter {
  emit(event: WatchdogEvent): void;
  emitCiTripwire?(event: WatchdogCiTripwire): void;
}

/** No-op emitter so callers that don't care about events don't crash. */
export const noopEmitter: WatchdogEmitter = {
  emit() {
    // intentionally empty
  },
  emitCiTripwire() {
    // intentionally empty
  },
};
