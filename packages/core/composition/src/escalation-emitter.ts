/**
 * Escalation emitter — bridges `@shamu/mailbox` and `@shamu/watchdog`
 * events onto the `@shamu/core-supervisor` bus.
 *
 * PLAN.md § "Core architecture → 4. Supervisor" declares `EscalationRaised`
 * as a local domain event published on an in-memory bus. `@shamu/watchdog`
 * emits `WatchdogAlert` (two-observation agreement) via `WatchdogEmitter`.
 * `@shamu/mailbox` emits `MailboxEscalationRaised` (stale-lease reclaim
 * refusals) via `EscalationEmitter`. Neither primitive imports the
 * supervisor bus — keeping them clean of the supervisor's event
 * taxonomy. This module is the composition-layer shim that forwards
 * both source taxonomies onto a single `EventBus<SupervisorEvent>`.
 *
 * Source taxonomy references (resolved to actual exported names):
 *
 *   - `@shamu/watchdog` — `WatchdogAlert` + `WatchdogEmitter`
 *     (defined in `packages/watchdog/src/types.ts` and
 *      `packages/watchdog/src/events.ts`). The emitter dispatches both
 *     hints (`watchdog.hint`) and alerts (`watchdog.alert`); we subscribe
 *     via a wrapping emitter that filters to `watchdog.alert` only —
 *     hints are intentionally below the escalation threshold.
 *
 *   - `@shamu/mailbox` — `MailboxEscalationRaised` +
 *     `EscalationEmitter as MailboxEscalationEmitter`
 *     (defined in `packages/mailbox/src/escalation.ts`). The mailbox
 *     emitter fires on stale-lease reclaim refusals.
 *
 * Target taxonomy: `@shamu/core-supervisor`'s `EscalationRaised` +
 * `SupervisorEvent`. The shim publishes onto any `EventBus<SupervisorEvent>`
 * the caller hands in — typically the swarm's bus.
 *
 * Escalation-cause mapping:
 *
 *   Source                                            → Target
 *   ------------------------------------------------- | -----------------------
 *   watchdog.alert (any signal pair)                   → "policy_violation"
 *   mailbox.lease_reclaim_refused_dirty_holder         → "policy_violation"
 *   mailbox.lease_reclaim_refused_holder_missing       → "policy_violation"
 *
 * The supervisor's `EscalationCause` enum today is
 * `"intensity_exceeded" | "start_failed" | "policy_violation"`. Neither
 * watchdog signals nor mailbox lease refusals are intensity or start
 * failures, so they land under `"policy_violation"` as a catch-all. This
 * is lossy — a downstream Linear sink can't tell a watchdog alert from a
 * mailbox dirty-holder from the cause alone; it has to read the
 * `reason` string. We flag a FOLLOWUP to extend `EscalationCause` with
 * `"watchdog_agreement"` and `"lease_reclaim_refused"` variants so the
 * target can switch on the shape; until then the shim preserves the
 * source detail in `reason` so no evidence is lost.
 *
 * Target routing:
 *
 *   - WatchdogAlert → `target: "role"`. A signal agreement points at a
 *     specific run, which belongs to a role; the role supervisor is
 *     the right surface to halt. (Swarm-wide halts come from the
 *     supervisor's own intensity budget, not the watchdog.)
 *   - MailboxEscalationRaised → `target: "swarm"` for the missing-
 *     worktree case (catastrophic: uncommitted work may have been lost),
 *     `target: "role"` for dirty-holder (reviewer/operator needs to
 *     decide; the role stopping surfaces that need). We preserve
 *     whatever the source event's `target` already says — the mailbox
 *     already classifies correctly, so this is a pass-through.
 */

import type { EventBus } from "@shamu/core-supervisor/bus";
import type { EscalationRaised, SupervisorEvent } from "@shamu/core-supervisor/events";
import type {
  EscalationEmitter as MailboxEscalationEmitter,
  MailboxEscalationRaised,
} from "@shamu/mailbox";
import type { WatchdogAlert, WatchdogEmitter, WatchdogEvent } from "@shamu/watchdog";

/**
 * Options for {@link createEscalationEmitter}.
 *
 * The shim wires itself by handing the caller two emitters (one per
 * source package) that the caller passes into the source primitives
 * (`reclaimIfStale(opts.emitter = mailboxEmitter)`, `runWatchdog(emit =
 * watchdogEmitter)`). Everything the source emitters receive is
 * forwarded onto `supervisorBus`.
 */
export interface EscalationEmitterOptions {
  /** Destination bus for forwarded `EscalationRaised` events. */
  readonly supervisorBus: EventBus<SupervisorEvent>;
  /** Optional clock for deterministic tests. Defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * Handle returned by {@link createEscalationEmitter}.
 *
 * `watchdogEmitter` is a {@link WatchdogEmitter} the caller passes to the
 * watchdog entry point; `mailboxEmitter` is a {@link MailboxEscalationEmitter}
 * the caller passes to mailbox primitives (e.g. `reclaimIfStale`).
 *
 * `stop()` disconnects both sources from the supervisor bus by flipping
 * an internal flag — subsequent `emit()` calls on either returned
 * emitter become no-ops. Useful on shutdown.
 */
export interface EscalationEmitterHandle {
  readonly watchdogEmitter: WatchdogEmitter;
  readonly mailboxEmitter: MailboxEscalationEmitter;
  /** Flip the internal stop flag. Both emitters become no-ops. */
  stop(): void;
}

/**
 * Create a composition shim that forwards mailbox + watchdog events onto
 * the supervisor bus.
 *
 * Because neither source primitive holds an EventBus reference itself —
 * they accept an injected emitter — the "subscribe" action here is
 * producing the emitter the caller wires in. That's also why there's no
 * implicit pump or background loop: events flow synchronously as the
 * source primitives fire.
 */
export function createEscalationEmitter(opts: EscalationEmitterOptions): EscalationEmitterHandle {
  const { supervisorBus } = opts;
  const now = opts.now ?? Date.now;
  let stopped = false;

  const watchdogEmitter: WatchdogEmitter = {
    emit(event: WatchdogEvent): void {
      if (stopped) return;
      // Hints intentionally do not escalate. Only two-observation
      // agreement alerts reach the supervisor bus.
      if (event.kind !== "watchdog.alert") return;
      supervisorBus.publish(translateWatchdogAlert(event, now()));
    },
  };

  const mailboxEmitter: MailboxEscalationEmitter = {
    emit(event: MailboxEscalationRaised): void {
      if (stopped) return;
      supervisorBus.publish(translateMailboxEscalation(event));
    },
  };

  return {
    watchdogEmitter,
    mailboxEmitter,
    stop(): void {
      stopped = true;
    },
  };
}

/**
 * Translate a `WatchdogAlert` into the supervisor's `EscalationRaised`.
 *
 * - `swarmId` / `roleId`: the watchdog cannot resolve these without the
 *   flow engine. We use `null` for swarm and the alert's `role` (nullable)
 *   for role. Downstream sinks that need a swarm id must look it up via
 *   the run registry — that's why `runId` is preserved in `childId` and
 *   `reason`.
 * - `childId`: the `runId` the alert is scoped to; aligns with how the
 *   supervisor identifies children elsewhere.
 * - `reason`: carries the watchdog's own reason verbatim so the evidence
 *   is not dropped. The confidence pair + signal pair are appended as
 *   a readable suffix so a CLI sink can render one line without parsing.
 * - `restartsInWindow`: 0. The watchdog doesn't track restart budgets;
 *   the field is supervisor-native and there's no sensible value here.
 */
function translateWatchdogAlert(alert: WatchdogAlert, at: number): EscalationRaised {
  const signalsLabel = `${alert.signals[0]}+${alert.signals[1]}`;
  const reason = `${alert.reason} [signals=${signalsLabel} confidence=${alert.confidence}]`;
  return {
    kind: "escalation_raised",
    swarmId: null,
    roleId: alert.role,
    childId: alert.runId,
    cause: "policy_violation",
    reason,
    // Prefer the alert's own wall-clock for replay fidelity; fall back
    // to the injected clock only if the alert didn't carry one.
    at: alert.at > 0 ? alert.at : at,
    restartsInWindow: 0,
    target: "role",
  };
}

/**
 * Translate a `MailboxEscalationRaised` into the supervisor's
 * `EscalationRaised`.
 *
 * The mailbox event is already structurally compatible (same `kind`,
 * same field names). The only translation we do is collapse the
 * mailbox-specific cause enum into `"policy_violation"` and preserve
 * the original cause inside `reason` so the evidence lives on.
 */
function translateMailboxEscalation(event: MailboxEscalationRaised): EscalationRaised {
  return {
    kind: "escalation_raised",
    swarmId: event.swarmId,
    roleId: event.roleId,
    childId: event.childId,
    cause: "policy_violation",
    reason: `${event.reason} [mailbox_cause=${event.cause}]`,
    at: event.at,
    restartsInWindow: event.restartsInWindow,
    target: event.target,
  };
}
