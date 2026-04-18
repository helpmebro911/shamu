/**
 * `checkpoint_lag` signal.
 *
 * PLAN §6: fires when no `checkpoint` event has arrived for a run in
 * `max(floor, 3 × rolling_median_for_role)`. Floor default 20 minutes.
 * Confidence is `"unknown"` until the role has observed ≥ 10
 * checkpoints — we do not have a population yet.
 *
 * Role bucketing — an open problem in Phase 3 because the `events`
 * table doesn't yet carry a `role` field. PLAN §6 is framed around
 * role, but the flow layer that assigns roles lands in Phase 4. Until
 * then we use `(vendor, runId)` as a role proxy: checkpoint intervals
 * are measured WITHIN a run, and the rolling median is computed
 * against that same run's history. This is strictly narrower than
 * "role" — a role with many runs will look like N separate populations
 * here — but it never lies: we don't claim to know a role-wide median
 * when we don't. The signal surfaces `role=null` on the observation to
 * make the proxy explicit downstream.
 *
 * Confidence tiers:
 *
 *   - `"unknown"` — fewer than `checkpointMinSampleSize` checkpoints
 *                   observed on this run. We cannot compute a median;
 *                   fall back to the floor alone, and never agree.
 *   - `"medium"`  — enough checkpoints to compute a rolling median, and
 *                   the current gap is ≥ `max(floor, 3 × median)`.
 *   - We never emit `"high"` here — the signal is inherently noisy
 *                   (agents pause legitimately during long tools). A
 *                   future enhancement could bump to `"high"` when the
 *                   gap is, say, 10× median; out of scope for Phase 3.
 *   - `"low"`     — currently unused; reserved for a future weaker trip
 *                   condition so the enum stays exhaustive.
 *
 * When the signal does NOT trip, it returns `null` rather than a
 * "quiet" observation. The watchdog main loop only cares about firing
 * observations; absent signal is implicit.
 */

import type { RunId } from "@shamu/shared/ids";
import type { ReadOnlyWatchdogDatabase } from "../store.ts";
import type { Confidence, Observation, WatchdogConfig } from "../types.ts";

/** A single checkpoint's timestamp, for interval math. */
interface CheckpointTsRow {
  ts_wall: number;
}

/** `runs` row metadata we need for the observation payload. */
interface RunMetaRow {
  run_id: string;
  role: string | null;
  vendor: string | null;
  status: string;
}

const RUN_META_SQL =
  "SELECT run_id, role, vendor, status FROM runs WHERE status NOT IN ('completed', 'failed')";

const CHECKPOINT_TS_SQL =
  "SELECT ts_wall FROM events WHERE run_id = ? AND kind = 'checkpoint' ORDER BY seq";

const LAST_EVENT_TS_SQL = "SELECT MAX(ts_wall) AS ts_wall FROM events WHERE run_id = ?";

/** Median of a non-empty sorted numeric array. */
function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    // Safe-indexed because `0 <= mid < sorted.length`.
    return sorted[mid] as number;
  }
  const lo = sorted[mid - 1] as number;
  const hi = sorted[mid] as number;
  return (lo + hi) / 2;
}

/**
 * Build an observation for a single run if the lag condition trips.
 *
 * Exposed for tests that want to feed synthetic data without going
 * through the full {@link evaluateCheckpointLag} loop.
 */
export function evaluateRunCheckpointLag(args: {
  readonly runId: RunId;
  readonly role: string | null;
  readonly vendor: string | null;
  readonly checkpointTimestamps: readonly number[];
  readonly now: number;
  readonly config: WatchdogConfig;
  /**
   * Most recent event ts_wall. Used to distinguish "no events yet" from
   * "events but no checkpoints." If no events at all, the run is still
   * booting and we don't fire.
   */
  readonly lastEventTs: number | null;
}): Observation | null {
  const { runId, role, vendor, checkpointTimestamps, now, config, lastEventTs } = args;

  // No events at all → run is still booting; don't fire.
  if (lastEventTs === null) return null;

  const count = checkpointTimestamps.length;
  const floor = config.checkpointLagFloorMs;
  const minSample = config.checkpointMinSampleSize;

  // Reference "last activity" for the lag window. If there have been
  // checkpoints, measure from the most recent one; otherwise fall back
  // to the most recent event (any kind). PLAN §6 talks specifically
  // about checkpoint_lag, but a run that has received events recently
  // — just not a checkpoint — should still get a shot at the lag rule
  // from whichever activity we can see. The confidence tier already
  // guards against noisy trips.
  const referenceTs = count === 0 ? lastEventTs : (checkpointTimestamps[count - 1] ?? lastEventTs);
  const gap = now - referenceTs;

  // If fewer than `minSample` checkpoints, we cannot compute a median.
  // The confidence is `"unknown"` regardless of whether the floor was
  // breached — but we only EMIT when the floor is breached, so the
  // hint log carries signal without ever counting toward agreement.
  if (count < minSample) {
    if (gap < floor) return null;
    const confidence: Confidence = "unknown";
    return {
      signal: "checkpoint_lag",
      runId,
      vendor,
      role,
      confidence,
      at: now,
      reason: `No checkpoint in ${gap}ms (floor=${floor}ms, only ${count} prior checkpoints)`,
      detail: {
        gapMs: gap,
        floorMs: floor,
        priorCheckpoints: count,
        referenceTs,
      },
    };
  }

  // We have ≥ `minSample` checkpoints. Compute inter-checkpoint
  // intervals and the rolling median.
  const intervals: number[] = [];
  for (let i = 1; i < count; i++) {
    const prev = checkpointTimestamps[i - 1];
    const cur = checkpointTimestamps[i];
    if (typeof prev !== "number" || typeof cur !== "number") continue;
    intervals.push(cur - prev);
  }
  const med = median(intervals);
  const threshold = Math.max(floor, 3 * med);

  if (gap < threshold) return null;

  return {
    signal: "checkpoint_lag",
    runId,
    vendor,
    role,
    confidence: "medium",
    at: now,
    reason: `No checkpoint in ${gap}ms (threshold=${threshold}ms, median=${med}ms, sample=${count})`,
    detail: {
      gapMs: gap,
      thresholdMs: threshold,
      medianMs: med,
      priorCheckpoints: count,
      referenceTs,
    },
  };
}

/**
 * Evaluate `checkpoint_lag` across every active run in the database.
 *
 * Only runs with `status NOT IN ('completed', 'failed')` are
 * considered — a finished run can't lag. Observations are returned;
 * the caller decides whether to ingest into the agreement buffer.
 */
export function evaluateCheckpointLag(args: {
  readonly db: ReadOnlyWatchdogDatabase;
  readonly now: number;
  readonly config: WatchdogConfig;
}): readonly Observation[] {
  const { db, now, config } = args;
  const runRows = db.prepare(RUN_META_SQL).all() as RunMetaRow[];
  const out: Observation[] = [];
  for (const run of runRows) {
    const cpRows = db.prepare(CHECKPOINT_TS_SQL).all(run.run_id) as CheckpointTsRow[];
    const timestamps = cpRows.map((r) => r.ts_wall);
    const lastRow = db.prepare(LAST_EVENT_TS_SQL).get(run.run_id) as
      | { ts_wall: number | null }
      | undefined;
    const lastEventTs = lastRow?.ts_wall ?? null;
    const obs = evaluateRunCheckpointLag({
      runId: run.run_id as RunId,
      role: run.role,
      vendor: run.vendor,
      checkpointTimestamps: timestamps,
      now,
      config,
      lastEventTs,
    });
    if (obs) out.push(obs);
  }
  return out;
}
