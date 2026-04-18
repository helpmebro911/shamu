/**
 * `runWatchdog` — one tick of the watchdog's evaluation loop.
 *
 * PLAN §6 describes the watchdog as an OUT-OF-PROCESS process that
 * reads SQLite read-only and publishes observations. `runWatchdog` is
 * the core evaluator, deliberately kept pure so the same function is
 * runnable in-process for tests AND from inside the Bun subprocess
 * wrapper:
 *
 *   - `now` is injected: tests advance a fake clock, production passes
 *     `Date.now()`.
 *   - `emit` is injected: tests capture events into an array,
 *     production forwards them to stdout / the supervisor bus.
 *   - No `setInterval` / `setTimeout`. Looping is the wrapper's job
 *     (`subprocess.ts` / `entry.ts`).
 *
 * The evaluator builds fresh observations for every signal, feeds
 * them into the agreement buffer in a stable order, and routes the
 * resulting hints + alerts to `emit`. Between ticks, the buffer ages
 * old observations out via `sweep(now)`.
 */

import { AgreementBuffer } from "./agreement.ts";
import type { WatchdogEmitter } from "./events.ts";
import { evaluateCheckpointLag } from "./signals/checkpoint-lag.ts";
import { evaluateCostVelocity } from "./signals/cost-velocity.ts";
import { evaluateNoWriteActivity } from "./signals/no-write-activity.ts";
import { evaluateToolLoop, ToolLoopDedupState } from "./signals/tool-loop.ts";
import type { ReadOnlyWatchdogDatabase } from "./store.ts";
import type { Observation, SignalKind, WatchdogConfig } from "./types.ts";

/** Cross-tick state held by the watchdog wrapper. */
export interface WatchdogState {
  readonly agreement: AgreementBuffer;
  readonly toolLoopDedup: ToolLoopDedupState;
}

export function createWatchdogState(config: WatchdogConfig): WatchdogState {
  return {
    agreement: new AgreementBuffer({ windowMs: config.agreementWindowMs }),
    toolLoopDedup: new ToolLoopDedupState(),
  };
}

/**
 * Stable order of signal evaluation so that, for a given `(now, db)`,
 * the emitted event sequence is deterministic — load-bearing for
 * snapshot-style tests.
 */
const SIGNAL_ORDER: readonly SignalKind[] = [
  "checkpoint_lag",
  "no_write_activity",
  "cost_velocity",
  "tool_loop",
];

function sortObservations(observations: readonly Observation[]): readonly Observation[] {
  const order = new Map<SignalKind, number>();
  for (let i = 0; i < SIGNAL_ORDER.length; i++) {
    const k = SIGNAL_ORDER[i];
    if (k) order.set(k, i);
  }
  return [...observations].sort((a, b) => {
    const ao = order.get(a.signal) ?? 999;
    const bo = order.get(b.signal) ?? 999;
    if (ao !== bo) return ao - bo;
    if (a.runId !== b.runId) return a.runId < b.runId ? -1 : 1;
    return a.at - b.at;
  });
}

/**
 * Run one watchdog tick. Pure in the sense that it does not mutate
 * the database; it DOES mutate `state` (agreement buffer, dedup) so
 * the caller should treat `state` as owned by this function's caller
 * across ticks.
 */
export function runWatchdog(args: {
  readonly db: ReadOnlyWatchdogDatabase;
  readonly now: number;
  readonly config: WatchdogConfig;
  readonly emit: WatchdogEmitter;
  readonly state: WatchdogState;
}): void {
  const { db, now, config, emit, state } = args;

  const allObservations: Observation[] = [];
  allObservations.push(...evaluateCheckpointLag({ db, now, config }));
  allObservations.push(...evaluateNoWriteActivity({ db, now, config }));
  allObservations.push(...evaluateCostVelocity({ db, now, config }));
  allObservations.push(...evaluateToolLoop({ db, now, config, dedup: state.toolLoopDedup }));

  for (const obs of sortObservations(allObservations)) {
    const { hint, alert } = state.agreement.ingest(obs);
    if (hint) emit.emit(hint);
    if (alert) emit.emit(alert);
  }

  state.agreement.sweep(now);
}
