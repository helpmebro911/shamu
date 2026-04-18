/**
 * Escalation events emitted by mailbox/lease primitives.
 *
 * PLAN.md § "Core architecture → 4. Supervisor, restart, escalation" says
 * the supervisor publishes `EscalationRaised` on an in-memory bus and
 * downstream sinks subscribe. Track 3.C produces two kinds of escalations
 * (stale-lease reclaim refused because the holder's worktree is dirty /
 * missing) that must flow to the same bus without this package
 * importing `@shamu/core-supervisor`.
 *
 * We therefore define a locally-owned interface that is **structurally
 * compatible** with the supervisor's `EscalationRaised` (same `kind` and
 * cause-like string). A supervisor-layer shim can forward events of this
 * shape onto its own bus; the two types don't need to be the same
 * nominal type.
 *
 * Callers who don't care about escalations pass {@link noopEmitter};
 * callers who do (the orchestrator) pass an {@link EscalationEmitter}
 * that forwards onto the supervisor bus. We intentionally keep the
 * subscriber interface minimal — just `emit` — so wiring the two
 * packages is a one-liner without re-declaring bus semantics here.
 */

/**
 * Cause taxonomy for escalations originating in this package.
 *
 *   - `lease_reclaim_refused_dirty_holder` — stale-lease reclaim was
 *     attempted, the holder's worktree had uncommitted changes inside
 *     the lease glob, reclaim was refused to avoid stomping work.
 *   - `lease_reclaim_refused_holder_missing` — the worktree directory
 *     recorded on the lease no longer exists; we cannot prove it's safe
 *     to reclaim.
 */
export type MailboxEscalationCause =
  | "lease_reclaim_refused_dirty_holder"
  | "lease_reclaim_refused_holder_missing";

/**
 * Structurally compatible with `@shamu/core-supervisor`'s `EscalationRaised`.
 *
 * Fields match shape so a supervisor-layer adapter can forward without
 * translation. The `cause` enum is a superset on the supervisor side; any
 * cause the supervisor doesn't know about is surfaced as an opaque string
 * on its bus.
 */
export interface MailboxEscalationRaised {
  readonly kind: "escalation_raised";
  readonly swarmId: string | null;
  readonly roleId: string | null;
  readonly childId: string;
  readonly cause: MailboxEscalationCause;
  readonly reason: string;
  readonly at: number;
  readonly restartsInWindow: number;
  readonly target: "role" | "swarm";
}

/**
 * Minimal emitter interface. A caller (orchestrator) wires this to their
 * supervisor bus; tests pass a capturing emitter to assert events.
 */
export interface EscalationEmitter {
  emit(event: MailboxEscalationRaised): void;
}

/**
 * Default emitter — discards events. Useful as a fallback so primitives
 * never crash on an undefined bus.
 */
export const noopEmitter: EscalationEmitter = {
  emit() {
    // intentionally empty
  },
};
