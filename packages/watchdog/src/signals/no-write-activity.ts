/**
 * `no_write_activity` signal.
 *
 * PLAN §6: "no `tool_call` matching the role's **vendor-aware
 * write-tool allowlist** (`Edit|Write|Bash` for Claude;
 * `apply_patch`/`shell` for Codex; per-adapter) in 15 min, and no
 * `turn_end`."
 *
 * Interpretation:
 *   - "Write tool allowlist" is vendor-scoped (per Capability, per
 *     adapter). The watchdog config carries a
 *     `{ [vendor]: readonly string[] }` map.
 *   - The 15-minute window measures FROM the most recent qualifying
 *     event (any qualifying `tool_call`, OR any `turn_end`). If
 *     either has fired inside the window, the run is "active enough"
 *     and we don't trip.
 *   - The window is measured against `now`. If the most recent event
 *     is already older than the threshold AND the run is still active
 *     (not `completed`/`failed`), the run is silently stuck.
 *
 * Confidence tiers:
 *
 *   - `"unknown"` — vendor is null, or the vendor has no allowlist in
 *                   config. We literally can't say whether the run is
 *                   inactive; fall through to a hint.
 *   - `"low"`     — brand-new run with NO prior qualifying tool_call.
 *                   The run may just not have hit its first write
 *                   yet; PLAN §6 explicitly wants us to be cautious
 *                   here. Emit a hint, don't count as agreement.
 *   - `"medium"`  — the run HAS produced at least one qualifying
 *                   write in its history, and the threshold has
 *                   elapsed since the last one (and no `turn_end` in
 *                   the window). Strong enough for agreement.
 *   - `"high"`    — unused in this signal; same rationale as
 *                   checkpoint_lag.
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

interface EventRow {
  kind: string;
  ts_wall: number;
  payload_json: string;
}

const RUN_META_SQL =
  "SELECT run_id, role, vendor, status FROM runs WHERE status NOT IN ('completed', 'failed')";

/**
 * All tool_call + turn_end events for a run, ordered by seq ascending.
 * We do NOT filter on `kind IN (...)` with the allowlist in SQL
 * because the allowlist is per-vendor, and SQL parameter binding for
 * IN-lists is awkward. Pulling the two kinds into memory and
 * filtering in TS is fine — active runs have modest event counts per
 * tick.
 */
const RUN_EVENTS_SQL =
  "SELECT kind, ts_wall, payload_json FROM events WHERE run_id = ? AND kind IN ('tool_call', 'turn_end') ORDER BY seq";

function extractToolName(payloadJson: string): string | null {
  try {
    const parsed = JSON.parse(payloadJson) as { tool?: unknown };
    if (typeof parsed.tool === "string") return parsed.tool;
    return null;
  } catch {
    return null;
  }
}

/**
 * Compute the `no_write_activity` observation for a single run.
 *
 * Pure: everything it needs is passed in. The database-aware wrapper
 * {@link evaluateNoWriteActivity} produces the inputs.
 */
export function evaluateRunNoWriteActivity(args: {
  readonly runId: RunId;
  readonly role: string | null;
  readonly vendor: string | null;
  readonly now: number;
  readonly config: WatchdogConfig;
  /** `tool_call` + `turn_end` events for this run, in seq order. */
  readonly events: readonly { kind: string; tsWall: number; tool: string | null }[];
  /** Timestamp of the most recent event of any kind; null if no events. */
  readonly lastEventTs: number | null;
}): Observation | null {
  const { runId, role, vendor, now, config, events, lastEventTs } = args;

  // If no events yet, the run is booting. Don't fire.
  if (lastEventTs === null) return null;

  const threshold = config.noWriteActivityThresholdMs;
  const cutoff = now - threshold;

  // Vendor unknown or missing allowlist → unknown-confidence hint.
  if (vendor === null) {
    // Still only fire if the run has been silent longer than the
    // threshold — otherwise we'd spam hints for every healthy run.
    if (lastEventTs > cutoff) return null;
    return {
      signal: "no_write_activity",
      runId,
      vendor: null,
      role,
      confidence: "unknown",
      at: now,
      reason: `No qualifying write tool_call in ${now - lastEventTs}ms (vendor unknown)`,
      detail: {
        thresholdMs: threshold,
        lastEventTs,
        vendor: null,
      },
    };
  }

  const allowlist = config.writeToolAllowlist[vendor] ?? null;
  if (allowlist === null || allowlist.length === 0) {
    if (lastEventTs > cutoff) return null;
    return {
      signal: "no_write_activity",
      runId,
      vendor,
      role,
      confidence: "unknown",
      at: now,
      reason: `No allowlist for vendor "${vendor}"; cannot classify write activity`,
      detail: {
        thresholdMs: threshold,
        lastEventTs,
        vendor,
      },
    };
  }

  const allowSet = new Set(allowlist);

  let lastQualifyingWriteTs: number | null = null;
  let lastTurnEndTs: number | null = null;
  let anyPriorWrite = false;
  for (const ev of events) {
    if (ev.kind === "tool_call") {
      if (ev.tool !== null && allowSet.has(ev.tool)) {
        anyPriorWrite = true;
        if (lastQualifyingWriteTs === null || ev.tsWall > lastQualifyingWriteTs) {
          lastQualifyingWriteTs = ev.tsWall;
        }
      }
    } else if (ev.kind === "turn_end") {
      if (lastTurnEndTs === null || ev.tsWall > lastTurnEndTs) {
        lastTurnEndTs = ev.tsWall;
      }
    }
  }

  const lastActivityTs = Math.max(lastQualifyingWriteTs ?? 0, lastTurnEndTs ?? 0);

  // If either a qualifying write OR a turn_end has fired inside the
  // window, the run is active.
  if (lastActivityTs > cutoff) return null;

  // Two tiers. No prior qualifying write at all = brand-new run case.
  if (!anyPriorWrite) {
    return {
      signal: "no_write_activity",
      runId,
      vendor,
      role,
      confidence: "low",
      at: now,
      reason: `No qualifying write tool_call has ever fired on this run (${now - lastEventTs}ms since last activity)`,
      detail: {
        thresholdMs: threshold,
        lastEventTs,
        lastQualifyingWriteTs,
        lastTurnEndTs,
        vendor,
        allowlist: [...allowlist],
      },
    };
  }

  return {
    signal: "no_write_activity",
    runId,
    vendor,
    role,
    confidence: "medium",
    at: now,
    reason: `${now - lastActivityTs}ms since last qualifying write or turn_end (threshold=${threshold}ms)`,
    detail: {
      thresholdMs: threshold,
      lastEventTs,
      lastQualifyingWriteTs,
      lastTurnEndTs,
      vendor,
      allowlist: [...allowlist],
    },
  };
}

export function evaluateNoWriteActivity(args: {
  readonly db: ReadOnlyWatchdogDatabase;
  readonly now: number;
  readonly config: WatchdogConfig;
}): readonly Observation[] {
  const { db, now, config } = args;
  const runs = db.prepare(RUN_META_SQL).all() as RunMetaRow[];
  const out: Observation[] = [];
  for (const run of runs) {
    const rows = db.prepare(RUN_EVENTS_SQL).all(run.run_id) as EventRow[];
    let lastEventTs: number | null = null;
    const events: Array<{ kind: string; tsWall: number; tool: string | null }> = [];
    for (const row of rows) {
      events.push({
        kind: row.kind,
        tsWall: row.ts_wall,
        tool: row.kind === "tool_call" ? extractToolName(row.payload_json) : null,
      });
      if (lastEventTs === null || row.ts_wall > lastEventTs) lastEventTs = row.ts_wall;
    }
    // If no tool_call/turn_end, we still need to know if the run has
    // ANY events at all (the lastEventTs check distinguishes "booting"
    // from "stuck"). Ask the DB for the absolute max.
    if (lastEventTs === null) {
      const r = db
        .prepare("SELECT MAX(ts_wall) AS ts_wall FROM events WHERE run_id = ?")
        .get(run.run_id) as { ts_wall: number | null } | undefined;
      lastEventTs = r?.ts_wall ?? null;
    }
    const obs = evaluateRunNoWriteActivity({
      runId: run.run_id as RunId,
      role: run.role,
      vendor: run.vendor,
      now,
      config,
      events,
      lastEventTs,
    });
    if (obs) out.push(obs);
  }
  return out;
}
