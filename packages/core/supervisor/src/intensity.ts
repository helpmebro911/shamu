/**
 * Sliding-window restart-count tracker.
 *
 * The supervisor feeds every restart timestamp into a tracker and asks
 * whether the count inside `withinMs` has exceeded the policy's `intensity`.
 * Two properties matter:
 *
 *   1. Eviction. Stamps older than `withinMs` are dropped lazily every time
 *      `record()` or `count()` is called. Memory reclaim is bounded by the
 *      number of restarts actually recorded; no scheduled timers.
 *   2. Threshold semantics. A policy declaring `intensity=3` permits three
 *      restarts inside the window. The FOURTH crash inside the window is
 *      the one that escalates. `shouldEscalate()` therefore returns true
 *      iff the count in the window is strictly greater than `intensity`.
 *
 * The tracker is pure bookkeeping — it never calls back, never starts
 * timers, and the clock source is injectable for deterministic tests.
 */

export type IntensityClock = () => number;

/** Returns wall-clock milliseconds. Real code uses `Date.now`. */
export const defaultIntensityClock: IntensityClock = () => Date.now();

/**
 * Tracks restart timestamps for a single child.
 *
 * Note: one tracker per child, not per role. The supervisor owns N trackers
 * keyed by childId so a noisy child doesn't spill over into its siblings'
 * budgets.
 */
export class IntensityTracker {
  private readonly stamps: number[] = [];

  constructor(private readonly clock: IntensityClock = defaultIntensityClock) {}

  /** Append a new restart stamp at the current clock time. */
  record(): void {
    this.stamps.push(this.clock());
  }

  /** Number of stamps currently inside `withinMs`. Evicts stale stamps. */
  count(withinMs: number): number {
    this.evict(withinMs);
    return this.stamps.length;
  }

  /**
   * True iff recording one more restart would push the in-window count
   * past `intensity`. Callers use this to decide, before re-invoking the
   * factory, whether to escalate instead.
   *
   * Semantics: `intensity` is the number of restarts tolerated. The
   * (intensity+1)th restart is the one that escalates. Implementation:
   * check whether we already have `intensity` stamps in the window;
   * adding another would put us at `intensity+1`, which trips the rule.
   */
  shouldEscalate(intensity: number, withinMs: number): boolean {
    const inWindow = this.count(withinMs);
    return inWindow >= intensity;
  }

  /** Drop all recorded stamps. Used when a role is stopped or reset. */
  reset(): void {
    this.stamps.length = 0;
  }

  /**
   * Snapshot the current stamps inside the window. Primarily for tests and
   * the `EscalationRaised.restartsInWindow` counter. Returns a copy so the
   * caller cannot mutate internal state.
   */
  snapshot(withinMs: number): readonly number[] {
    this.evict(withinMs);
    return [...this.stamps];
  }

  private evict(withinMs: number): void {
    const cutoff = this.clock() - withinMs;
    // Stamps are append-only in monotonic-ish order (Date.now is not
    // strictly monotonic but close enough for a restart counter). Drop
    // from the head until we find one inside the window.
    let drop = 0;
    for (const ts of this.stamps) {
      if (ts >= cutoff) break;
      drop += 1;
    }
    if (drop > 0) {
      this.stamps.splice(0, drop);
    }
  }
}
