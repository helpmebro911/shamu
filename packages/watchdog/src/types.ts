/**
 * Public types for the watchdog package.
 *
 * PLAN.md § "Core architecture → 6. Watchdog" requires every signal to
 * publish an observation with an explicit confidence value instead of a
 * raw boolean. Agreements only promote to a `WatchdogAlert` when two
 * distinct signals produce at least `medium` confidence within the
 * agreement window. Everything else surfaces as a `WatchdogHint` so the
 * log retains signal without triggering an escalation-shaped event.
 *
 * Using a string-literal union for `Confidence` keeps the wire format
 * explicit (and TypeScript-exhaustive) rather than collapsing to a
 * numeric enum whose meaning drifts.
 */
import type { RunId } from "@shamu/shared/ids";

/**
 * Signal confidence taxonomy.
 *
 *   - `"unknown"` — the signal cannot be evaluated yet (cold start,
 *                   insufficient history, unknown vendor). Never counts
 *                   toward a two-observation agreement.
 *   - `"low"`     — signal tripped but context is thin; counts as a hint.
 *   - `"medium"`  — signal tripped with enough context to be considered
 *                   for an alert. Two of these across different signals
 *                   in the same run promote to a `WatchdogAlert`.
 *   - `"high"`    — signal tripped with strong evidence. Same agreement
 *                   rule as `"medium"`, but dashboards can surface it
 *                   louder.
 */
export type Confidence = "high" | "medium" | "low" | "unknown";

/** Signal identity — the four signals PLAN §6 calls out. */
export type SignalKind = "checkpoint_lag" | "no_write_activity" | "cost_velocity" | "tool_loop";

/**
 * A single observation emitted by a signal evaluator. The evaluator is a
 * pure function of `(events, now)` and never writes to SQLite.
 *
 * - `runId` — scopes the observation. The agreement buffer groups
 *             observations by `(runId, signal)` so a single run trips
 *             two different signals before anything escalates.
 * - `vendor` / `role` — included when available. PLAN §6 bases the
 *                       rolling-median windows on "role" once Phase 4's
 *                       flow layer assigns one; until then we use
 *                       `(vendor, roleProxy)` with `roleProxy = vendor`
 *                       as a coarse fallback.
 * - `detail` — free-form structured payload the signal chooses. Hints
 *              and alerts carry it through so downstream consumers can
 *              render "last checkpoint at <ts>" without re-querying.
 */
export interface Observation {
  readonly signal: SignalKind;
  readonly runId: RunId;
  readonly vendor: string | null;
  readonly role: string | null;
  readonly confidence: Confidence;
  /** Wall-clock ms when the signal fired (not when the event stream ended). */
  readonly at: number;
  /** Human-readable one-liner — rendered in hint/alert logs. */
  readonly reason: string;
  /** Structured payload — signal-specific. */
  readonly detail: Readonly<Record<string, unknown>>;
}

/**
 * A hint is the baseline emit for any observation that does not (yet)
 * have two-signal agreement. Singleton observations, low-confidence
 * observations, and `unknown`-confidence observations all become hints.
 *
 * Hints are intentionally cheap — they're the log-only rung below an
 * escalation so operators can still see the signal.
 */
export interface WatchdogHint {
  readonly kind: "watchdog.hint";
  readonly runId: RunId;
  readonly signal: SignalKind;
  readonly confidence: Confidence;
  readonly at: number;
  readonly reason: string;
  readonly detail: Readonly<Record<string, unknown>>;
}

/**
 * A watchdog alert — the escalation-shaped event emitted when two
 * different signals for the same run hit `medium`+ confidence inside the
 * agreement window. The alert is structurally compatible with (but does
 * not import) the supervisor's `EscalationRaised`.
 */
export interface WatchdogAlert {
  readonly kind: "watchdog.alert";
  readonly runId: RunId;
  readonly vendor: string | null;
  readonly role: string | null;
  /** The two signals that agreed. Sorted alphabetically for stability. */
  readonly signals: readonly [SignalKind, SignalKind];
  /** Max of the two observations' confidence values. */
  readonly confidence: Extract<Confidence, "medium" | "high">;
  readonly at: number;
  readonly reason: string;
  /** The raw observations that produced the alert, for evidence. */
  readonly observations: readonly [Observation, Observation];
}

/**
 * Vendor-aware write-tool allowlist. PLAN §6 specifies Claude
 * (`Edit|Write|Bash`) and Codex (`apply_patch|shell`); additional
 * adapters drop into the same shape.
 */
export type WriteToolAllowlist = Readonly<Record<string, readonly string[]>>;

/**
 * Watchdog configuration. Every field has a default chosen to match
 * PLAN §6 so callers only override what they care about.
 */
export interface WatchdogConfig {
  /** Minimum checkpoint-lag floor (ms). PLAN §6: 20 minutes. */
  readonly checkpointLagFloorMs: number;
  /** Required prior checkpoints before `checkpoint_lag` confidence !== "unknown". */
  readonly checkpointMinSampleSize: number;
  /** No-write-activity threshold (ms). PLAN §6: 15 minutes. */
  readonly noWriteActivityThresholdMs: number;
  /**
   * Per-role run count required before `cost_velocity` confidence !== "unknown".
   * PLAN §6: N=5 default.
   */
  readonly costVelocityMinSampleSize: number;
  /** Multiplier over the role's rolling-median cost that trips `cost_velocity`. */
  readonly costVelocityMultiplier: number;
  /** Consecutive-call threshold for `tool_loop`. PLAN §6: 3. */
  readonly toolLoopConsecutiveThreshold: number;
  /**
   * Agreement window (ms). Two observations for the same run must arrive
   * within this window for an alert to fire. Observations older than the
   * window age out.
   */
  readonly agreementWindowMs: number;
  /** Vendor-aware write-tool allowlist. Keys are vendor names. */
  readonly writeToolAllowlist: WriteToolAllowlist;
}

/** Default config matching PLAN §6. */
export const DEFAULT_WATCHDOG_CONFIG: WatchdogConfig = Object.freeze({
  checkpointLagFloorMs: 20 * 60 * 1000,
  checkpointMinSampleSize: 10,
  noWriteActivityThresholdMs: 15 * 60 * 1000,
  costVelocityMinSampleSize: 5,
  costVelocityMultiplier: 4,
  toolLoopConsecutiveThreshold: 3,
  agreementWindowMs: 10 * 60 * 1000,
  writeToolAllowlist: Object.freeze({
    claude: Object.freeze(["Edit", "Write", "Bash"]),
    codex: Object.freeze(["apply_patch", "shell"]),
  }) as WriteToolAllowlist,
});
