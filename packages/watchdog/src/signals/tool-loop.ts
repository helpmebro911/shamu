/**
 * `tool_loop` signal.
 *
 * PLAN §6: "same `(tool, canonicalized_args_hash)` ≥ 3× consecutively.
 * Canonicalization redacts secrets and normalizes whitespace before
 * hashing."
 *
 * Strategy:
 *   - Walk `tool_call` events for each active run in seq order.
 *   - For each call, compute `(tool, sha256(canonicalizeArgs(args)))`.
 *   - Detect any run of `≥ toolLoopConsecutiveThreshold` identical
 *     pairs.
 *   - The observation carries the tool, the hash, and the count.
 *
 * Confidence tiers:
 *
 *   - `"medium"` on the first qualifying run of consecutive identical
 *     calls — strong enough for agreement.
 *   - `"high"`   when the run is 2× the threshold or longer. This is
 *     one signal where we genuinely can gain confidence with length;
 *     a 6-call identical loop is not noise.
 *   - `"low"`    unused.
 *   - `"unknown"` unused — by the time we hit the threshold, we have
 *     real evidence.
 *
 * Dedup: once a run has fired a loop observation for a given
 * `(tool, hash)` at a given final-seq, we do NOT re-emit the same
 * observation on subsequent ticks. The agreement buffer's alerted-pair
 * suppression is separate — it only prevents DOUBLE-alerting, not
 * double-hinting. Dedup here avoids a stuck loop lighting up every
 * tick. We key dedup on `(runId, tool, hash, finalSeq)`.
 */

import { createHash } from "node:crypto";
import type { RunId } from "@shamu/shared/ids";
import { canonicalizeArgs } from "../canonicalize.ts";
import type { ReadOnlyWatchdogDatabase } from "../store.ts";
import type { Confidence, Observation, WatchdogConfig } from "../types.ts";

interface RunMetaRow {
  run_id: string;
  role: string | null;
  vendor: string | null;
  status: string;
}

interface ToolCallRow {
  seq: number;
  ts_wall: number;
  payload_json: string;
}

const RUN_META_SQL =
  "SELECT run_id, role, vendor, status FROM runs WHERE status NOT IN ('completed', 'failed')";

const TOOL_CALLS_SQL =
  "SELECT seq, ts_wall, payload_json FROM events WHERE run_id = ? AND kind = 'tool_call' ORDER BY seq";

/**
 * Parsed tool call carrying only what we need for the loop check.
 */
export interface NormalizedToolCall {
  readonly seq: number;
  readonly tsWall: number;
  readonly tool: string;
  readonly argsHash: string;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Parse a raw `tool_call` payload into the normalized shape the
 * detector walks. Returns `null` for malformed payloads — an event
 * that can't be parsed cannot contribute to a loop.
 */
function normalize(row: ToolCallRow): NormalizedToolCall | null {
  let parsed: { tool?: unknown; args?: unknown };
  try {
    parsed = JSON.parse(row.payload_json);
  } catch {
    return null;
  }
  if (typeof parsed.tool !== "string" || parsed.tool.length === 0) return null;
  const canonical = canonicalizeArgs(parsed.args ?? null);
  return {
    seq: row.seq,
    tsWall: row.ts_wall,
    tool: parsed.tool,
    argsHash: sha256Hex(canonical),
  };
}

/**
 * Find the latest trailing run of identical `(tool, argsHash)` in the
 * series. Returns the final index into `calls` and the run length, or
 * null if there's no trailing run of length ≥ 1.
 */
function trailingRun(
  calls: readonly NormalizedToolCall[],
): { lengthSoFar: number; startIdx: number; endIdx: number } | null {
  if (calls.length === 0) return null;
  const last = calls[calls.length - 1];
  if (!last) return null;
  let i = calls.length - 2;
  let length = 1;
  while (i >= 0) {
    const cur = calls[i];
    if (!cur) break;
    if (cur.tool === last.tool && cur.argsHash === last.argsHash) {
      length += 1;
      i -= 1;
      continue;
    }
    break;
  }
  return { lengthSoFar: length, startIdx: i + 1, endIdx: calls.length - 1 };
}

/**
 * Pure run-over-normalized-calls evaluator. Callers feed in the
 * normalized tool-call sequence for a single run and receive an
 * observation or null. Exposed for tests.
 */
export function evaluateRunToolLoop(args: {
  readonly runId: RunId;
  readonly role: string | null;
  readonly vendor: string | null;
  readonly calls: readonly NormalizedToolCall[];
  readonly now: number;
  readonly config: WatchdogConfig;
}): Observation | null {
  const { runId, role, vendor, calls, now, config } = args;
  const threshold = config.toolLoopConsecutiveThreshold;
  const run = trailingRun(calls);
  if (!run) return null;
  if (run.lengthSoFar < threshold) return null;

  const last = calls[run.endIdx];
  if (!last) return null;
  const confidence: Confidence = run.lengthSoFar >= threshold * 2 ? "high" : "medium";

  return {
    signal: "tool_loop",
    runId,
    vendor,
    role,
    confidence,
    at: now,
    reason: `tool=${last.tool} called ${run.lengthSoFar}× consecutively with identical canonicalized args (threshold=${threshold})`,
    detail: {
      tool: last.tool,
      argsHash: last.argsHash,
      consecutiveCount: run.lengthSoFar,
      firstSeq: calls[run.startIdx]?.seq ?? last.seq,
      lastSeq: last.seq,
      lastTsWall: last.tsWall,
    },
  };
}

/**
 * State carried across ticks so we don't re-emit the same loop
 * observation over and over. Keyed by `runId`, value is the
 * `(tool|hash|lastSeq)` signature of the last-emitted loop.
 *
 * The signal creates a fresh state on first use; the watchdog main
 * loop holds the state instance across ticks.
 */
export class ToolLoopDedupState {
  private readonly lastEmitted = new Map<string, string>();

  /**
   * Key a fresh observation and return true if we should emit it
   * (first time OR a new/extended loop), false otherwise.
   */
  shouldEmit(obs: Observation): boolean {
    if (obs.signal !== "tool_loop") return true;
    const detail = obs.detail as {
      tool?: unknown;
      argsHash?: unknown;
      lastSeq?: unknown;
      consecutiveCount?: unknown;
    };
    const tool = typeof detail.tool === "string" ? detail.tool : "";
    const hash = typeof detail.argsHash === "string" ? detail.argsHash : "";
    const lastSeq = typeof detail.lastSeq === "number" ? detail.lastSeq : -1;
    const key = `${obs.runId}|${tool}|${hash}`;
    const value = `${lastSeq}`;
    const prior = this.lastEmitted.get(key);
    if (prior === value) return false;
    this.lastEmitted.set(key, value);
    return true;
  }
}

/** Evaluate `tool_loop` across every active run in the DB. */
export function evaluateToolLoop(args: {
  readonly db: ReadOnlyWatchdogDatabase;
  readonly now: number;
  readonly config: WatchdogConfig;
  /**
   * Dedup state from the main loop. Optional for ad-hoc callers
   * (tests); callers that invoke this across multiple ticks MUST
   * pass a single instance, otherwise the same stuck loop will
   * re-emit every tick.
   */
  readonly dedup?: ToolLoopDedupState;
}): readonly Observation[] {
  const { db, now, config, dedup } = args;
  const runs = db.prepare(RUN_META_SQL).all() as RunMetaRow[];
  const out: Observation[] = [];
  for (const run of runs) {
    const rows = db.prepare(TOOL_CALLS_SQL).all(run.run_id) as ToolCallRow[];
    const normalized: NormalizedToolCall[] = [];
    for (const row of rows) {
      const n = normalize(row);
      if (n) normalized.push(n);
    }
    const obs = evaluateRunToolLoop({
      runId: run.run_id as RunId,
      role: run.role,
      vendor: run.vendor,
      calls: normalized,
      now,
      config,
    });
    if (!obs) continue;
    if (dedup && !dedup.shouldEmit(obs)) continue;
    out.push(obs);
  }
  return out;
}
