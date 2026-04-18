/**
 * Agreement buffer — promotes two matching observations into an alert.
 *
 * PLAN §6 is the contract:
 *
 *   > Alerts require **two observations at confidence ≥ medium** to
 *   > agree. Single-signal and unknown-confidence trips are logged as
 *   > `watchdog.hint`, never as escalations. This is the defense
 *   > against the documented "silence detector" amplification loops.
 *
 * We implement that rule here as a small in-memory buffer keyed by
 * `runId`. Within a configurable window, if two DIFFERENT signals fire
 * for the same run and both are at confidence `medium` or `high`, the
 * buffer yields a `WatchdogAlert`. Every observation that doesn't
 * promote emits a `WatchdogHint` so operators still see the signal.
 *
 * Key implementation choices:
 *
 *   - Observations are stored in a per-run map keyed by signal. Two
 *     observations for the SAME signal (e.g. tool_loop firing twice)
 *     do not agree; we require distinct signals. This matches the PLAN
 *     rationale: the whole point of the rule is cross-signal
 *     corroboration.
 *   - Replacing an older observation with a newer one for the same
 *     signal is allowed. The newer observation carries better context
 *     (freshest fire time); we keep only the latest per-signal per-run.
 *   - Stale observations are dropped lazily on each `ingest` call and
 *     on an explicit `sweep(now)` so a long-lived buffer doesn't hold
 *     unbounded memory for runs that finished.
 *   - Once an alert is emitted for a run, we mark that pair `(signalA,
 *     signalB)` as "already alerted" and suppress re-firing until
 *     either observation ages out — otherwise a stuck run would alert
 *     every tick.
 *
 * The buffer is deliberately small and stateless-shaped: a single
 * `ingest` call takes an observation and returns every event it wants
 * to emit (hint or alert). The watchdog main loop forwards those to
 * the emitter. This keeps `runWatchdog` pure (no reaching into buffer
 * internals).
 */

import type { RunId } from "@shamu/shared/ids";
import type { Confidence, Observation, SignalKind, WatchdogAlert, WatchdogHint } from "./types.ts";

/** Result of ingesting a single observation. */
export interface IngestResult {
  readonly hint: WatchdogHint | null;
  readonly alert: WatchdogAlert | null;
}

/**
 * Signals that can contribute to an agreement (≥ medium confidence).
 */
function countsTowardAgreement(c: Confidence): c is "medium" | "high" {
  return c === "medium" || c === "high";
}

/** Pick the stronger of two confidences for an alert's summary. */
function strongerConfidence(a: Confidence, b: Confidence): "medium" | "high" {
  if (!countsTowardAgreement(a) || !countsTowardAgreement(b)) {
    // Unreachable: caller only invokes this when both observations
    // already cleared the `countsTowardAgreement` gate. Defensive
    // fallback to `"medium"` rather than throwing — the caller
    // shouldn't have to wrap in try/catch.
    return "medium";
  }
  if (a === "high" || b === "high") return "high";
  return "medium";
}

/** Sort two signal kinds alphabetically for stable alert keys. */
function sortedPair(a: SignalKind, b: SignalKind): readonly [SignalKind, SignalKind] {
  return a < b ? [a, b] : [b, a];
}

interface RunBucket {
  /** Latest observation per signal for this run. */
  readonly perSignal: Map<SignalKind, Observation>;
  /**
   * Pairs we've already alerted on, keyed by `"a|b"` with a,b sorted.
   * Cleared lazily when contributing observations age out.
   */
  readonly alertedPairs: Set<string>;
}

/** Options for {@link AgreementBuffer}. */
export interface AgreementBufferOptions {
  /**
   * Max age of a stored observation in ms. Observations older than
   * this at ingest time are dropped. Match `WatchdogConfig.agreementWindowMs`.
   */
  readonly windowMs: number;
}

function pairKey(a: SignalKind, b: SignalKind): string {
  const [x, y] = sortedPair(a, b);
  return `${x}|${y}`;
}

function toHint(obs: Observation): WatchdogHint {
  return {
    kind: "watchdog.hint",
    runId: obs.runId,
    signal: obs.signal,
    confidence: obs.confidence,
    at: obs.at,
    reason: obs.reason,
    detail: obs.detail,
  };
}

function toAlert(fresh: Observation, prior: Observation): WatchdogAlert {
  const signals = sortedPair(fresh.signal, prior.signal);
  const confidence = strongerConfidence(fresh.confidence, prior.confidence);
  // Use the most recent fire time as the alert timestamp — that's the
  // wall-clock moment the agreement actually formed.
  const at = Math.max(fresh.at, prior.at);
  const reason = `Two signals agree: ${signals[0]} + ${signals[1]}`;
  // Order observations to match `signals` so consumers can read them
  // positionally without re-sorting.
  const observations: readonly [Observation, Observation] =
    fresh.signal === signals[0] ? [fresh, prior] : [prior, fresh];
  // `role` and `vendor` come from either observation; prefer the
  // freshest non-null value.
  const role = fresh.role ?? prior.role;
  const vendor = fresh.vendor ?? prior.vendor;
  return {
    kind: "watchdog.alert",
    runId: fresh.runId,
    role,
    vendor,
    signals,
    confidence,
    at,
    reason,
    observations,
  };
}

/**
 * In-memory agreement buffer. Intended to be instantiated once per
 * watchdog loop and kept across ticks.
 */
export class AgreementBuffer {
  private readonly windowMs: number;
  private readonly perRun = new Map<RunId, RunBucket>();

  constructor(opts: AgreementBufferOptions) {
    if (!Number.isFinite(opts.windowMs) || opts.windowMs <= 0) {
      throw new TypeError("AgreementBuffer windowMs must be a positive number");
    }
    this.windowMs = opts.windowMs;
  }

  /**
   * Ingest a single observation and return the hint plus any alert
   * that fired as a consequence.
   *
   * Caller is responsible for calling `ingest` in monotonic time order
   * relative to `obs.at`; out-of-order ingests still work but the
   * aging sweep uses `obs.at` as the reference clock.
   */
  ingest(obs: Observation): IngestResult {
    this.sweepRun(obs.runId, obs.at);

    const bucket = this.getOrCreateBucket(obs.runId);
    const hint = toHint(obs);

    // If this observation is below the agreement threshold, it just
    // becomes a hint — do not store it for future agreement (PLAN §6:
    // "single-signal and unknown-confidence trips are logged as
    // watchdog.hint, never as escalations"). We still want it in the
    // per-run bucket so a later observation can see the full picture,
    // BUT it cannot unlock an alert on its own.
    if (!countsTowardAgreement(obs.confidence)) {
      // We still replace any existing observation for this signal so
      // the store reflects the most recent state. Low/unknown
      // observations never contribute to agreement even when paired.
      bucket.perSignal.set(obs.signal, obs);
      return { hint, alert: null };
    }

    // Walk existing observations and look for a ≥ medium partner from
    // a DIFFERENT signal that we haven't already alerted on.
    let alert: WatchdogAlert | null = null;
    for (const [sig, prior] of bucket.perSignal.entries()) {
      if (sig === obs.signal) continue;
      if (!countsTowardAgreement(prior.confidence)) continue;
      const key = pairKey(sig, obs.signal);
      if (bucket.alertedPairs.has(key)) continue;
      alert = toAlert(obs, prior);
      bucket.alertedPairs.add(key);
      break;
    }

    // Store/replace the fresh observation so a later different-signal
    // observation can agree with it.
    bucket.perSignal.set(obs.signal, obs);
    return { hint, alert };
  }

  /**
   * Drop observations older than `now - windowMs` across every run.
   * Runs with zero remaining observations are removed from the map.
   *
   * Exposed for the main-loop wrapper — we call it after every tick
   * so a long-running watchdog doesn't accumulate dead buckets.
   */
  sweep(now: number): void {
    for (const runId of Array.from(this.perRun.keys())) {
      this.sweepRun(runId, now);
    }
  }

  /** Current number of run buckets — tests use this for assertions. */
  sizeRuns(): number {
    return this.perRun.size;
  }

  private getOrCreateBucket(runId: RunId): RunBucket {
    const existing = this.perRun.get(runId);
    if (existing) return existing;
    const fresh: RunBucket = {
      perSignal: new Map(),
      alertedPairs: new Set(),
    };
    this.perRun.set(runId, fresh);
    return fresh;
  }

  private sweepRun(runId: RunId, now: number): void {
    const bucket = this.perRun.get(runId);
    if (!bucket) return;
    const cutoff = now - this.windowMs;
    const expiredSignals: SignalKind[] = [];
    for (const [sig, obs] of bucket.perSignal.entries()) {
      if (obs.at < cutoff) expiredSignals.push(sig);
    }
    for (const sig of expiredSignals) {
      bucket.perSignal.delete(sig);
      // Drop any alerted-pair markers mentioning this signal so a
      // future observation on the same signal can re-alert.
      for (const key of Array.from(bucket.alertedPairs)) {
        const [a, b] = key.split("|");
        if (a === sig || b === sig) bucket.alertedPairs.delete(key);
      }
    }
    if (bucket.perSignal.size === 0 && bucket.alertedPairs.size === 0) {
      this.perRun.delete(runId);
    }
  }
}
