/**
 * CI tripwire — per-role cross-run red-streak counter.
 *
 * PLAN.md § "Core architecture → 10. Quality gate" (Phase 5.C):
 *
 *   > Per-role CI-failure counter (watchdog tripwire on 3 reds).
 *
 * This is structurally DIFFERENT from the four-signal agreement buffer:
 *
 *   - The agreement buffer correlates two DIFFERENT signals within one
 *     run inside a time window. Its unit is `runId`.
 *   - The CI tripwire counts SAME-signal repetitions across MULTIPLE
 *     runs for the SAME role. Its unit is `role`.
 *
 * Shoehorning the tripwire into the buffer would break the buffer's
 * "cross-signal corroboration" invariant. So this lives as a parallel
 * channel, emitted via `WatchdogEmitter.emitCiTripwire`.
 *
 * Semantics:
 *   - `red` increments the per-role counter; when it hits `threshold`,
 *     fire a `watchdog.ci_tripwire` event and RESET that role's counter
 *     to 0. Re-firing requires another full threshold cycle.
 *   - `green` resets the per-role counter to 0 (a passing CI clears
 *     the streak).
 *   - `unknown` is a no-op — the tripwire is conservative and will not
 *     count an indeterminate signal toward an escalation.
 *
 * `runIds` accumulated inside each role's streak are carried through
 * to the fire event in oldest-first order so consumers can render the
 * streak chronologically.
 */

import type { RunId } from "@shamu/shared/ids";
import type { WatchdogEmitter } from "./events.ts";
import type { WatchdogCiTripwire } from "./types.ts";

/** Input to {@link CiTripwire.observe}. */
export interface CiTripwireObservation {
  readonly role: string;
  readonly status: "red" | "green" | "unknown";
  readonly runId: RunId;
  readonly at: number;
  /** Free-form structured payload; attached to the fire event's `detail`. */
  readonly detail?: Readonly<Record<string, unknown>>;
}

/** Options for {@link createCiTripwire}. */
export interface CiTripwireOptions {
  readonly emitter: WatchdogEmitter;
  /** Consecutive reds required to fire. Defaults to 3 (PLAN §10). */
  readonly threshold?: number;
}

/** Handle returned by {@link createCiTripwire}. */
export interface CiTripwire {
  /** Feed a CI outcome; fires at most once per call. */
  observe(input: CiTripwireObservation): void;
  /** Clear one role's counter (or all roles, if `role` is undefined). */
  reset(role?: string): void;
  /** Return a copy of current per-role counter state for dashboards/tests. */
  snapshot(): Readonly<Record<string, { count: number; runIds: readonly RunId[] }>>;
}

interface RoleStreak {
  count: number;
  /** RunIds that contributed to the current streak, oldest-first. */
  readonly runIds: RunId[];
  /** Detail payload from the most recent red — attached to the fire event. */
  lastDetail: Readonly<Record<string, unknown>>;
}

export function createCiTripwire(opts: CiTripwireOptions): CiTripwire {
  const threshold = opts.threshold ?? 3;
  if (!Number.isInteger(threshold) || threshold <= 0) {
    throw new TypeError("CiTripwire threshold must be a positive integer");
  }
  const { emitter } = opts;
  const perRole = new Map<string, RoleStreak>();

  function getOrCreate(role: string): RoleStreak {
    const existing = perRole.get(role);
    if (existing) return existing;
    const fresh: RoleStreak = { count: 0, runIds: [], lastDetail: Object.freeze({}) };
    perRole.set(role, fresh);
    return fresh;
  }

  function fire(role: string, streak: RoleStreak, at: number): void {
    // Snapshot the streak before the reset so the emitted event
    // carries the exact RunIds that tripped the wire.
    const runIds: readonly RunId[] = Object.freeze([...streak.runIds]);
    const event: WatchdogCiTripwire = {
      kind: "watchdog.ci_tripwire",
      role,
      runIds,
      at,
      threshold,
      reason: `CI red streak: ${threshold} consecutive failures for role ${role}`,
      detail: streak.lastDetail,
    };
    // Reset the counter so subsequent reds require another threshold
    // cycle to re-fire (PLAN: fire once, then reset).
    streak.count = 0;
    streak.runIds.length = 0;
    streak.lastDetail = Object.freeze({});
    // Prefer the parallel channel; fall back to `emit` for emitters
    // that haven't implemented the tripwire method yet.
    if (emitter.emitCiTripwire) {
      emitter.emitCiTripwire(event);
    } else {
      emitter.emit(event);
    }
  }

  return {
    observe(input: CiTripwireObservation): void {
      // `unknown` is a conservative no-op — neither incrementing nor
      // resetting lets an indeterminate CI run disturb the streak.
      if (input.status === "unknown") return;

      const streak = getOrCreate(input.role);

      if (input.status === "green") {
        streak.count = 0;
        streak.runIds.length = 0;
        streak.lastDetail = Object.freeze({});
        return;
      }

      streak.count += 1;
      streak.runIds.push(input.runId);
      streak.lastDetail = Object.freeze({ ...(input.detail ?? {}) });

      if (streak.count >= threshold) {
        fire(input.role, streak, input.at);
      }
    },

    reset(role?: string): void {
      if (role === undefined) {
        perRole.clear();
        return;
      }
      perRole.delete(role);
    },

    snapshot(): Readonly<Record<string, { count: number; runIds: readonly RunId[] }>> {
      const out: Record<string, { count: number; runIds: readonly RunId[] }> = {};
      for (const [role, streak] of perRole.entries()) {
        out[role] = { count: streak.count, runIds: Object.freeze([...streak.runIds]) };
      }
      return Object.freeze(out);
    },
  };
}
