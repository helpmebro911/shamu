/**
 * `cost_velocity` signal.
 *
 * PLAN §6: "per-run cost > 4× rolling median across that role.
 * `confidence="unknown"` for first N runs per role."
 *
 * PLAN §7 is load-bearing here:
 *   - Only `cost` events with `confidence in ("exact", "estimate")`
 *     contribute to the budget. Subscription-confidence cost events
 *     carry `usd=null` and are tracked separately — they never block
 *     budgets, and for this signal they produce `"unknown"`
 *     observations (documented explicitly in PLAN §7: "subscription
 *     runs are tracked for auditability but never block").
 *   - `"unknown"` confidence with non-null usd is a degraded case (see
 *     `@shamu/persistence/queries/cost` comments); we do NOT count
 *     those dollars toward the velocity comparison either — mirroring
 *     the aggregation package's policy keeps the two in sync.
 *
 * Role bucketing — same problem as checkpoint_lag. Until Phase 4's
 * flow layer populates `events.role`, we use the run's `runs.role`
 * column (present since Phase 1) when available, else fall back to
 * `vendor` as the population key. The population is intentionally
 * coarse — a mixed-role database will lump everything into a single
 * "role=null" bucket; that's better than claiming false precision.
 *
 * Confidence tiers:
 *
 *   - `"unknown"` — fewer than `costVelocityMinSampleSize` prior runs
 *                   in the same role-bucket, OR the run under test is
 *                   subscription-confidence (no budget-bearing usd).
 *   - `"medium"`  — enough prior runs and the current run's
 *                   budget-bearing usd total exceeds
 *                   `multiplier × median_of_prior_budget_bearing_runs`.
 *   - `"high"`    — reserved; out of scope for this phase.
 *
 * We emit at most one observation per run per evaluation.
 */

import type { RunId } from "@shamu/shared/ids";
import type { ReadOnlyWatchdogDatabase } from "../store.ts";
import type { Observation, WatchdogConfig } from "../types.ts";

interface RunMetaRow {
  run_id: string;
  role: string | null;
  vendor: string | null;
  status: string;
}

interface CostEventRow {
  run_id: string;
  confidence: string | null;
  source: string | null;
  usd: number | null;
}

/**
 * Pull all (still-interesting) cost events from the DB.
 *
 * We scope to runs whose vendor/role we can reason about — a NULL
 * vendor on the runs table is legal (`packages/persistence/schema.sql`
 * declares vendor nullable) but means we can't even proxy a role.
 * We include them anyway so the caller can emit `unknown`-confidence
 * observations against active unknowns.
 */
const ALL_RUNS_SQL = "SELECT run_id, role, vendor, status FROM runs";
const ALL_COST_SQL =
  "SELECT run_id, json_extract(payload_json, '$.confidence') AS confidence, json_extract(payload_json, '$.source') AS source, json_extract(payload_json, '$.usd') AS usd FROM events WHERE kind = 'cost'";

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] as number;
  const lo = sorted[mid - 1] as number;
  const hi = sorted[mid] as number;
  return (lo + hi) / 2;
}

/**
 * Build the per-run cost summary from raw cost rows.
 *
 * Rules (match `@shamu/persistence/queries/cost`):
 *   - Budget-bearing usd = sum of non-null usd where confidence is
 *     "exact" or "estimate". Anything else contributes null.
 *   - "subscription" confidence runs are flagged separately — they
 *     trip `unknown` in the cost_velocity signal.
 */
interface RunCostTally {
  readonly runId: string;
  readonly budgetBearingUsd: number | null;
  readonly subscriptionOnly: boolean;
}

function tallyRuns(rows: readonly CostEventRow[]): ReadonlyMap<string, RunCostTally> {
  const perRun = new Map<
    string,
    {
      usd: number;
      anyBudgetBearing: boolean;
      anyNonSubscription: boolean;
      anySubscription: boolean;
    }
  >();
  for (const row of rows) {
    const bucket = perRun.get(row.run_id) ?? {
      usd: 0,
      anyBudgetBearing: false,
      anyNonSubscription: false,
      anySubscription: false,
    };
    const c = row.confidence;
    const s = row.source;
    const usd = typeof row.usd === "number" ? row.usd : null;
    const isSubscription = s === "subscription";
    if (isSubscription) bucket.anySubscription = true;
    else bucket.anyNonSubscription = true;
    if (usd !== null && (c === "exact" || c === "estimate")) {
      bucket.usd += usd;
      bucket.anyBudgetBearing = true;
    }
    perRun.set(row.run_id, bucket);
  }
  const out = new Map<string, RunCostTally>();
  for (const [runId, b] of perRun.entries()) {
    out.set(runId, {
      runId,
      budgetBearingUsd: b.anyBudgetBearing ? b.usd : null,
      subscriptionOnly: b.anySubscription && !b.anyNonSubscription,
    });
  }
  return out;
}

/**
 * Build the population for a single role bucket. PRIOR runs only —
 * we don't include the run under test in its own median (otherwise
 * the comparison would be self-referential on a single-element
 * bucket).
 */
function medianForRole(
  tallies: ReadonlyMap<string, RunCostTally>,
  runMetas: ReadonlyMap<string, RunMetaRow>,
  roleKey: string,
  excludeRunId: string,
): { usds: readonly number[]; median: number } {
  const usds: number[] = [];
  for (const [runId, tally] of tallies.entries()) {
    if (runId === excludeRunId) continue;
    const meta = runMetas.get(runId);
    if (!meta) continue;
    const key = roleKeyOf(meta);
    if (key !== roleKey) continue;
    if (tally.budgetBearingUsd === null) continue;
    usds.push(tally.budgetBearingUsd);
  }
  return { usds, median: median(usds) };
}

/**
 * Compute the role-bucket key for a run. Prefer `role`; fall back to
 * `vendor`. Runs without either key land in the synthetic
 * `"__unknown__"` bucket — PLAN §6 puts a sample-size floor on this
 * signal anyway, so such runs will always be `unknown` confidence.
 */
function roleKeyOf(meta: Pick<RunMetaRow, "role" | "vendor">): string {
  if (meta.role) return `role:${meta.role}`;
  if (meta.vendor) return `vendor:${meta.vendor}`;
  return "__unknown__";
}

/**
 * Evaluate the `cost_velocity` signal for every run in the DB. Returns
 * observations for runs whose current tally trips the rule (or, for
 * informational trips on short populations, `unknown`-confidence
 * observations with a sufficiently above-floor tally).
 */
export function evaluateCostVelocity(args: {
  readonly db: ReadOnlyWatchdogDatabase;
  readonly now: number;
  readonly config: WatchdogConfig;
}): readonly Observation[] {
  const { db, now, config } = args;
  const runRows = db.prepare(ALL_RUNS_SQL).all() as RunMetaRow[];
  const runMetas = new Map<string, RunMetaRow>();
  for (const r of runRows) runMetas.set(r.run_id, r);
  const costRows = db.prepare(ALL_COST_SQL).all() as CostEventRow[];
  const tallies = tallyRuns(costRows);

  const out: Observation[] = [];
  for (const [runId, tally] of tallies.entries()) {
    const meta = runMetas.get(runId);
    if (!meta) continue;
    // Finished runs still get evaluated — a finished run whose bill
    // came in high AFTER completion is still worth flagging. The main
    // loop caller may choose to skip if desired.
    const key = roleKeyOf(meta);

    // Subscription-only runs: `"unknown"` confidence hint. We emit so
    // operators see signal on them, but never count toward agreement.
    if (tally.subscriptionOnly) {
      out.push({
        signal: "cost_velocity",
        runId: runId as RunId,
        vendor: meta.vendor,
        role: meta.role,
        confidence: "unknown",
        at: now,
        reason: `Subscription-only cost for run ${runId}; not budget-bearing`,
        detail: {
          roleKey: key,
          subscriptionOnly: true,
          multiplier: config.costVelocityMultiplier,
        },
      });
      continue;
    }

    if (tally.budgetBearingUsd === null || tally.budgetBearingUsd <= 0) continue;

    const { usds, median: med } = medianForRole(tallies, runMetas, key, runId);
    if (usds.length < config.costVelocityMinSampleSize) {
      // Not enough priors to compute a velocity. Only emit an
      // observation if the run is unusually expensive in absolute
      // terms (more than 4× the greatest prior observation, say) —
      // otherwise we'd drown the log with hints for every first few
      // runs in a new role bucket. A simple gate: emit `unknown`
      // only if there IS a prior population and the current run beats
      // the max prior by the multiplier.
      if (usds.length === 0) continue;
      const priorMax = Math.max(...usds);
      if (tally.budgetBearingUsd <= priorMax * config.costVelocityMultiplier) continue;
      out.push({
        signal: "cost_velocity",
        runId: runId as RunId,
        vendor: meta.vendor,
        role: meta.role,
        confidence: "unknown",
        at: now,
        reason: `Run cost ${tally.budgetBearingUsd} exceeds ${config.costVelocityMultiplier}× prior max ${priorMax} (sample=${usds.length}, need ≥ ${config.costVelocityMinSampleSize})`,
        detail: {
          roleKey: key,
          runUsd: tally.budgetBearingUsd,
          priorSampleSize: usds.length,
          priorMaxUsd: priorMax,
          multiplier: config.costVelocityMultiplier,
        },
      });
      continue;
    }

    if (tally.budgetBearingUsd > config.costVelocityMultiplier * med) {
      out.push({
        signal: "cost_velocity",
        runId: runId as RunId,
        vendor: meta.vendor,
        role: meta.role,
        confidence: "medium",
        at: now,
        reason: `Run cost ${tally.budgetBearingUsd} > ${config.costVelocityMultiplier}× median ${med} (sample=${usds.length})`,
        detail: {
          roleKey: key,
          runUsd: tally.budgetBearingUsd,
          priorMedianUsd: med,
          priorSampleSize: usds.length,
          multiplier: config.costVelocityMultiplier,
        },
      });
    }
  }
  return out;
}
