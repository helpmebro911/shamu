/**
 * Typed query helpers for the `events` + `raw_events` tables.
 *
 * Events table is idempotent on `event_id` — `INSERT OR IGNORE` so replays
 * of `raw_events` through the projector are safe.
 */

import type { AgentEvent } from "@shamu/shared/events";
import { parseAgentEvent } from "@shamu/shared/events";
import type { EventId, RunId } from "@shamu/shared/ids";
import { eventId as brandEventId, runId as brandRunId } from "@shamu/shared/ids";
import type { ShamuDatabase } from "../db.ts";

export interface InsertRawEventInput {
  readonly eventId: EventId;
  readonly runId: RunId;
  readonly vendor: string;
  readonly ts: number;
  readonly payload: unknown;
}

export interface RawEventRow {
  readonly eventId: EventId;
  readonly runId: RunId;
  readonly vendor: string;
  readonly ts: number;
  readonly payload: unknown;
}

interface RawRawEventRow {
  event_id: string;
  run_id: string;
  vendor: string;
  ts: number;
  payload_json: string;
}

interface RawEventsRow {
  event_id: string;
  run_id: string;
  session_id: string | null;
  turn_id: string;
  parent_event_id: string | null;
  seq: number;
  ts_monotonic: number;
  ts_wall: number;
  vendor: string;
  kind: string;
  payload_json: string;
}

const INSERT_RAW_SQL =
  "INSERT OR IGNORE INTO raw_events (event_id, run_id, vendor, ts, payload_json) VALUES (?, ?, ?, ?, ?)";

const INSERT_EVENT_SQL =
  "INSERT OR IGNORE INTO events (event_id, run_id, session_id, turn_id, parent_event_id, seq, ts_monotonic, ts_wall, vendor, kind, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

const GET_EVENTS_BY_RUN_SQL = "SELECT * FROM events WHERE run_id = ? ORDER BY seq";

const TAIL_EVENTS_SQL = "SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?";

export function insertRawEvent(db: ShamuDatabase, input: InsertRawEventInput): void {
  db.prepare(INSERT_RAW_SQL).run(
    input.eventId,
    input.runId,
    input.vendor,
    input.ts,
    JSON.stringify(input.payload),
  );
}

/**
 * Insert a normalized agent event. The payload (everything not in the
 * envelope) is stored as JSON under `payload_json`.
 */
export function insertEvent(db: ShamuDatabase, event: AgentEvent): void {
  // Split into envelope and kind-specific payload. We persist the kind-
  // specific fields + the `kind` tag as JSON so the projector can replay
  // without schema changes for new kinds.
  const { eventId, runId, sessionId, turnId, parentEventId, seq, tsMonotonic, tsWall, vendor } =
    event;
  const payload: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(event)) {
    if (
      k === "eventId" ||
      k === "runId" ||
      k === "sessionId" ||
      k === "turnId" ||
      k === "parentEventId" ||
      k === "seq" ||
      k === "tsMonotonic" ||
      k === "tsWall" ||
      k === "vendor" ||
      k === "rawRef" ||
      k === "kind"
    ) {
      continue;
    }
    payload[k] = v;
  }
  db.prepare(INSERT_EVENT_SQL).run(
    eventId,
    runId,
    sessionId,
    turnId,
    parentEventId,
    seq,
    tsMonotonic,
    tsWall,
    vendor,
    event.kind,
    JSON.stringify(payload),
  );
}

function reconstructEvent(row: RawEventsRow): AgentEvent {
  const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
  return parseAgentEvent({
    ...payload,
    kind: row.kind,
    eventId: row.event_id,
    runId: row.run_id,
    sessionId: row.session_id,
    turnId: row.turn_id,
    parentEventId: row.parent_event_id,
    seq: row.seq,
    tsMonotonic: row.ts_monotonic,
    tsWall: row.ts_wall,
    vendor: row.vendor,
    rawRef: null,
  });
}

export function getEventsByRun(db: ShamuDatabase, id: RunId): readonly AgentEvent[] {
  const rows = db.prepare(GET_EVENTS_BY_RUN_SQL).all(id) as RawEventsRow[];
  return rows.map(reconstructEvent);
}

export function tailEvents(
  db: ShamuDatabase,
  sinceSeq: number,
  limit = 100,
): readonly AgentEvent[] {
  const rows = db.prepare(TAIL_EVENTS_SQL).all(sinceSeq, limit) as RawEventsRow[];
  return rows.map(reconstructEvent);
}

const SELECT_RAW_EVENT_BY_ID_SQL = "SELECT * FROM raw_events WHERE event_id = ?";

export function getRawEvent(db: ShamuDatabase, id: EventId): RawEventRow | null {
  const row = db.prepare(SELECT_RAW_EVENT_BY_ID_SQL).get(id) as RawRawEventRow | undefined;
  if (!row) return null;
  return {
    eventId: brandEventId(row.event_id),
    runId: brandRunId(row.run_id),
    vendor: row.vendor,
    ts: row.ts,
    payload: JSON.parse(row.payload_json),
  };
}
