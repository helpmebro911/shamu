/**
 * Typed in-memory pub/sub bus for flow events.
 *
 * Shape copied from `@shamu/core-supervisor`'s `EventBus`. Two buses
 * rather than a single shared typed union: flow and supervisor concerns
 * have distinct subscribers (flow sinks want per-node progress; supervisor
 * sinks want restart/escalation traces). A composition layer higher up
 * can subscribe to both and multiplex if it wants.
 *
 * Dispatch is synchronous and snapshotted so a listener that unsubscribes
 * mid-dispatch does not skip its sibling. Exceptions thrown by listeners
 * are isolated and reported via `console.error`; one broken sink cannot
 * silence the rest.
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
    // Snapshot to a local array: Set iteration with a mid-iteration delete
    // is spec-safe, but the snapshot makes the "one listener per publish
    // call" invariant obvious at the call site.
    const snapshot = [...this.listeners];
    for (const listener of snapshot) {
      try {
        listener(event);
      } catch (err) {
        // Biome allows console.error explicitly; preserve the same pattern
        // the supervisor bus uses so a grep over sinks turns up one place.
        console.error("Flow EventBus listener threw", err);
      }
    }
  }

  /** Drop every subscriber. Used on engine teardown to break refs. */
  clear(): void {
    this.listeners.clear();
  }

  /** Number of active subscribers. Primarily for tests. */
  get size(): number {
    return this.listeners.size;
  }
}
