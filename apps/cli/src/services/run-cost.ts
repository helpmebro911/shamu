/**
 * Emit a compact per-run cost summary after a run completes.
 *
 * PLAN.md § 7: rollups carry confidence per aggregate. The summary shape
 * surfaces `usdTotal` (exact + estimate) plus `confidenceBreakdown` and
 * `subscriptionRuns` so the caller can reason about budget signal without
 * having to re-query.
 */

import { costQueries, type ShamuDatabase } from "@shamu/persistence";
import type { RunId } from "@shamu/shared";
import { type OutputMode, writeHuman, writeJson } from "../output.ts";

export function emitRunCostSummary(params: {
  readonly db: ShamuDatabase;
  readonly runId: RunId;
  readonly adapterName: string;
  readonly role: string | null;
  readonly mode: OutputMode;
}): void {
  const { db, runId, adapterName, role, mode } = params;
  const summary = costQueries.aggregateRunCost(db, runId);
  if (!summary) return;

  const payload = {
    kind: "run-cost",
    runId,
    adapter: adapterName,
    role,
    tokens: summary.tokens,
    cost: summary.cost,
  };
  writeJson(mode, payload);

  const { usdTotal, confidenceBreakdown, subscriptionRuns } = summary.cost;
  const c = confidenceBreakdown;
  const tokensPart =
    `in=${summary.tokens.input} out=${summary.tokens.output} ` +
    `cacheRead=${summary.tokens.cacheRead} cacheCreation=${summary.tokens.cacheCreation}`;
  const confPart = `exact=${c.exact} estimate=${c.estimate} unknown=${c.unknown}`;
  writeHuman(
    mode,
    `run-cost ${runId} adapter=${adapterName} role=${role ?? "-"} ` +
      `usd=${usdTotal.toFixed(6)} [${confPart}] subscriptionRuns=${subscriptionRuns} tokens:{${tokensPart}}`,
  );
}
