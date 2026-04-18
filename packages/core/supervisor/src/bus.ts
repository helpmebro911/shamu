/**
 * Tiny typed in-memory pub/sub bus.
 *
 * PLAN.md § 4: "Escalations are local domain events (EscalationRaised) —
 * the supervisor never knows about Linear." This bus is the supervisor's
 * publish point. Subscribers (CLI status sink, TUI toaster, eventually the
 * Linear sink in Phase 6) attach via `subscribe()` and receive events
 * synchronously in the order they were published.
 *
 * Design notes:
 * - Generic over the event shape so callers can narrow to a specific
 *   payload without the bus caring. The `SupervisorBus` alias below pins
 *   it to `SupervisorEvent` for convenience.
 * - Synchronous dispatch. A listener that throws is isolated: the error is
 *   logged via `console.error` (Biome allows it explicitly) and the rest
 *   of the subscribers still fire. We don't want one broken sink to
 *   silence escalation delivery.
 * - No ordering guarantees across concurrent publishers — there aren't
 *   any; the supervisor is single-threaded per-swarm.
 */

export type BusListener<E> = (event: E) => void;

export class EventBus<E> {
  private readonly listeners = new Set<BusListener<E>>();

  /** Register a listener. Returns a disposer that removes it. */
  subscribe(listener: BusListener<E>): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Fire an event to every subscribed listener, isolating thrown errors. */
  publish(event: E): void {
    // Snapshot to a local array so a listener that unsubscribes during
    // dispatch doesn't skip a neighbor (Set iteration + mid-iteration
    // delete is spec'd-safe but easier to reason about this way).
    const snapshot = [...this.listeners];
    for (const listener of snapshot) {
      try {
        listener(event);
      } catch (err) {
        // eslint-disable-next-line no-console -- Biome allows console.error.
        console.error("EventBus listener threw", err);
      }
    }
  }

  /** Drop every subscriber. Used on supervisor teardown to break refs. */
  clear(): void {
    this.listeners.clear();
  }

  /** Number of active subscribers. Primarily for tests. */
  get size(): number {
    return this.listeners.size;
  }
}
