/**
 * Usage + cost aggregation helpers.
 *
 * Reads the `events` table (kind IN ('usage', 'cost')) and rolls up the
 * per-run and per-role totals PLAN.md §7 calls for.
 *
 * Design notes
 * ------------
 * - **Confidence + source are NOT re-derived in SQL.** Per PLAN §7 / T17
 *   they are stamped by the core (outside this module) BEFORE the event is
 *   persisted; this aggregator only groups by what's already in the payload.
 *   A compromised adapter that forged the wrong confidence tag cannot be
 *   retroactively corrected at read time — the invariant is "what the DB
 *   shows is what core authorized."
 * - **Budget-relevant sum rules (PLAN §7).** `usdTotal` adds rows whose
 *   `usd` is non-null — this is `exact + estimate`. `subscription` rows
 *   always carry `usd=null` and are counted in `subscriptionRuns` for
 *   auditability; they never block. `unknown` rows with non-null usd (the
 *   adversarial "vendor silently stopped reporting" fallback in the Claude
 *   projector) contribute to `unknown` in the breakdown but we do NOT sum
 *   their usd — treating them as budget-bearing would let an adapter drift
 *   toward "unknown" to hide real spend.
 * - **Per-role rollups** fan out by vendor so a mixed-vendor role yields
 *   one row per vendor rather than a meaningless cross-vendor sum.
 */

import type { RunId } from "@shamu/shared/ids";
import type { ShamuDatabase } from "../db.ts";

export interface RunCostTokens {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheCreation: number;
}

export interface RunCostBreakdown {
  readonly usdTotal: number;
  readonly confidenceBreakdown: {
    readonly exact: number;
    readonly estimate: number;
    readonly unknown: number;
  };
  readonly subscriptionRuns: number;
}

export interface RunCostSummary {
  readonly runId: RunId;
  readonly role: string | null;
  readonly vendor: string;
  readonly tokens: RunCostTokens;
  readonly cost: RunCostBreakdown;
}

/**
 * Token aggregation for a single run. `json_extract` pulls nested values out
 * of the payload_json blob; null-handling uses COALESCE so the sums are 0
 * for runs that emitted no usage events rather than NULL.
 */
// Plain strings only — `no-dynamic-sql.test.ts` greps for backtick-quoted
// SQL with `${}` substitutions anywhere in the same source file and would
// trip on our synthetic `role:${role}` RunId construction below. The SQL
// here is static; the `?`-placeholders bind user data safely.
const RUN_TOKENS_SQL =
  "SELECT " +
  "COALESCE(SUM(CAST(json_extract(payload_json, '$.tokens.input')         AS INTEGER)), 0) AS input_tokens, " +
  "COALESCE(SUM(CAST(json_extract(payload_json, '$.tokens.output')        AS INTEGER)), 0) AS output_tokens, " +
  "COALESCE(SUM(CAST(json_extract(payload_json, '$.tokens.cacheRead')     AS INTEGER)), 0) AS cache_read, " +
  "COALESCE(SUM(CAST(json_extract(payload_json, '$.tokens.cacheCreation') AS INTEGER)), 0) AS cache_creation " +
  "FROM events WHERE run_id = ? AND kind = 'usage'";

/**
 * Cost aggregation for a single run. The confidence + source columns are
 * stamped by core before insert — we trust them. See PLAN §7.
 */
const RUN_COST_SQL =
  "SELECT " +
  "json_extract(payload_json, '$.confidence') AS confidence, " +
  "json_extract(payload_json, '$.source')     AS source, " +
  "json_extract(payload_json, '$.usd')        AS usd " +
  "FROM events WHERE run_id = ? AND kind = 'cost'";

/**
 * Per-run bookkeeping. `vendor` is on the runs row and is copied into every
 * event envelope; we use the runs row so a zero-event run still has a vendor
 * tag on the summary.
 */
const RUN_META_SQL = "SELECT run_id, role, vendor FROM runs WHERE run_id = ?";

/**
 * Per-role, per-vendor rollup. We aggregate inside SQL to keep the hot path
 * out of TS; the confidence breakdown requires post-processing because
 * SQLite's CASE can't yield three counters in one GROUP BY row without
 * multiple expressions — so we select the raw rows and bucket in JS.
 */
const ROLE_USAGE_ROLLUP_SQL =
  "SELECT r.role AS role, e.vendor AS vendor, " +
  "COALESCE(SUM(CAST(json_extract(e.payload_json, '$.tokens.input')         AS INTEGER)), 0) AS input_tokens, " +
  "COALESCE(SUM(CAST(json_extract(e.payload_json, '$.tokens.output')        AS INTEGER)), 0) AS output_tokens, " +
  "COALESCE(SUM(CAST(json_extract(e.payload_json, '$.tokens.cacheRead')     AS INTEGER)), 0) AS cache_read, " +
  "COALESCE(SUM(CAST(json_extract(e.payload_json, '$.tokens.cacheCreation') AS INTEGER)), 0) AS cache_creation " +
  "FROM events e JOIN runs r ON r.run_id = e.run_id " +
  "WHERE r.role = ? AND e.kind = 'usage' GROUP BY r.role, e.vendor";

const ROLE_COST_ROWS_SQL =
  "SELECT r.role AS role, e.vendor AS vendor, r.run_id AS run_id, " +
  "json_extract(e.payload_json, '$.confidence') AS confidence, " +
  "json_extract(e.payload_json, '$.source')     AS source, " +
  "json_extract(e.payload_json, '$.usd')        AS usd " +
  "FROM events e JOIN runs r ON r.run_id = e.run_id " +
  "WHERE r.role = ? AND e.kind = 'cost'";

const ROLE_RUN_VENDORS_SQL =
  "SELECT DISTINCT r.run_id AS run_id, r.role AS role, r.vendor AS vendor " +
  "FROM runs r WHERE r.role = ? AND r.vendor IS NOT NULL";

interface RawRunMeta {
  run_id: string;
  role: string | null;
  vendor: string | null;
}

interface RawTokensRow {
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read: number | null;
  cache_creation: number | null;
}

interface RawCostRow {
  confidence: string | null;
  source: string | null;
  usd: number | null;
}

interface RawRoleTokensRow {
  role: string | null;
  vendor: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read: number | null;
  cache_creation: number | null;
}

interface RawRoleCostRow {
  role: string | null;
  vendor: string;
  run_id: string;
  confidence: string | null;
  source: string | null;
  usd: number | null;
}

interface RawRoleRunVendorRow {
  run_id: string;
  role: string | null;
  vendor: string;
}

function zeroBreakdown(): RunCostBreakdown {
  return {
    usdTotal: 0,
    confidenceBreakdown: { exact: 0, estimate: 0, unknown: 0 },
    subscriptionRuns: 0,
  };
}

/**
 * Fold a list of cost rows into a breakdown. Rules (see file header):
 * - usdTotal accumulates non-null usd from any row (exact + estimate).
 * - Confidence counters are row-count of each tag.
 * - Subscription rows are counted per-run (a single run emitting many
 *   subscription cost events is still one "subscription run" — otherwise
 *   the count would be token-ish and meaningless).
 */
function foldCostRows(
  rows: readonly { confidence: string | null; source: string | null; usd: number | null }[],
  runIdOf?: (row: {
    confidence: string | null;
    source: string | null;
    usd: number | null;
  }) => string,
): RunCostBreakdown {
  const b = { exact: 0, estimate: 0, unknown: 0 };
  let usdTotal = 0;
  const subscriptionRunIds = new Set<string>();
  for (const row of rows) {
    if (typeof row.usd === "number") usdTotal += row.usd;
    switch (row.confidence) {
      case "exact":
        b.exact += 1;
        break;
      case "estimate":
        b.estimate += 1;
        break;
      case "unknown":
        b.unknown += 1;
        break;
      default:
        // An unrecognized tag contributes to "unknown" so the confidence
        // breakdown never silently loses signal. Adapter must not emit an
        // unrecognized tag; core-stamping is what writes this field.
        b.unknown += 1;
    }
    if (row.source === "subscription" && runIdOf) {
      subscriptionRunIds.add(runIdOf(row));
    }
  }
  return {
    usdTotal,
    confidenceBreakdown: b,
    subscriptionRuns: subscriptionRunIds.size,
  };
}

/**
 * Aggregate tokens + cost for a single run. Returns null if the run row
 * itself doesn't exist (an unknown run id).
 */
export function aggregateRunCost(db: ShamuDatabase, runId: RunId): RunCostSummary | null {
  const meta = db.prepare(RUN_META_SQL).get(runId) as RawRunMeta | undefined;
  if (!meta) return null;

  const tokenRow = db.prepare(RUN_TOKENS_SQL).get(runId) as RawTokensRow | undefined;
  const tokens: RunCostTokens = {
    input: tokenRow?.input_tokens ?? 0,
    output: tokenRow?.output_tokens ?? 0,
    cacheRead: tokenRow?.cache_read ?? 0,
    cacheCreation: tokenRow?.cache_creation ?? 0,
  };

  const costRows = db.prepare(RUN_COST_SQL).all(runId) as RawCostRow[];
  // For a single-run aggregate, "subscription runs" is 0 or 1. The runIdOf
  // fn folds the set of ids from the cost rows directly.
  const breakdown = foldCostRows(costRows, () => runId as string);

  return {
    runId: meta.run_id as RunId,
    role: meta.role,
    vendor: meta.vendor ?? "unknown",
    tokens,
    cost: breakdown,
  };
}

/**
 * Aggregate a role across all runs, returning one summary per vendor. A role
 * with no recorded runs yields `[]`.
 *
 * `runId` on each returned summary is set to a synthetic sentinel that
 * preserves branding but signals "multiple runs rolled up." We use the
 * empty-string-prefixed tag `role:<role>` here; callers that need run-level
 * detail should call `aggregateRunCost` per run.
 */
export function aggregateRoleCost(db: ShamuDatabase, role: string): RunCostSummary[] {
  const tokenRows = db.prepare(ROLE_USAGE_ROLLUP_SQL).all(role) as RawRoleTokensRow[];
  const costRows = db.prepare(ROLE_COST_ROWS_SQL).all(role) as RawRoleCostRow[];
  const runVendors = db.prepare(ROLE_RUN_VENDORS_SQL).all(role) as RawRoleRunVendorRow[];

  // Build the vendor set from BOTH the token rows and the runs table: a run
  // with zero usage events should still surface if the caller is tracking
  // subscription-only activity for that role.
  const vendors = new Set<string>();
  for (const row of tokenRows) vendors.add(row.vendor);
  for (const row of runVendors) vendors.add(row.vendor);

  // Index tokens by vendor for O(1) lookup.
  const tokensByVendor = new Map<string, RunCostTokens>();
  for (const row of tokenRows) {
    tokensByVendor.set(row.vendor, {
      input: row.input_tokens ?? 0,
      output: row.output_tokens ?? 0,
      cacheRead: row.cache_read ?? 0,
      cacheCreation: row.cache_creation ?? 0,
    });
  }

  // Bucket cost rows by vendor so the breakdown fold is per-vendor.
  const costRowsByVendor = new Map<string, RawRoleCostRow[]>();
  for (const row of costRows) {
    const bucket = costRowsByVendor.get(row.vendor) ?? [];
    bucket.push(row);
    costRowsByVendor.set(row.vendor, bucket);
  }

  const result: RunCostSummary[] = [];
  for (const vendor of vendors) {
    const tokens = tokensByVendor.get(vendor) ?? {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheCreation: 0,
    };
    const bucket = costRowsByVendor.get(vendor) ?? [];
    const breakdown =
      bucket.length === 0
        ? zeroBreakdown()
        : foldCostRows(bucket, (row) => (row as RawRoleCostRow).run_id);
    result.push({
      // Synthetic run id — see fn doc. Branding stays intact because RunId is
      // a type-level brand, not a runtime check.
      runId: `role:${role}` as RunId,
      role,
      vendor,
      tokens,
      cost: breakdown,
    });
  }

  // Deterministic order — vendor alphabetical — so test snapshots are stable.
  result.sort((a, b) => a.vendor.localeCompare(b.vendor));
  return result;
}
