/**
 * Typed query helpers for the `sessions` table.
 *
 * The `sessions` table maps an orchestrator-owned `runId` to the vendor-
 * assigned `sessionId` that `adapter.resume(sessionId, ...)` needs. Phase 2.C
 * wiring writes a row the first time an adapter surfaces a session id on a
 * run; `shamu resume <run-id>` reads it back to warm-resume the vendor.
 *
 * All statements are prepared against constant SQL strings — see
 * `no-dynamic-sql.test.ts` for the lint that enforces it.
 *
 * `INSERT OR IGNORE` semantics: resuming produces the same vendor session id
 * under a different run id, and if the adapter ever re-announces the same id
 * we prefer the original row (primary-key collision would otherwise raise).
 */

import type { RunId, SessionId } from "@shamu/shared/ids";
import { runId as brandRunId, sessionId as brandSessionId } from "@shamu/shared/ids";
import type { ShamuDatabase } from "../db.ts";

export interface SessionRow {
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly vendor: string;
  readonly createdAt: number;
}

export interface InsertSessionInput {
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly vendor: string;
  readonly createdAt?: number;
}

interface RawSessionRow {
  session_id: string;
  run_id: string;
  vendor: string;
  created_at: number;
}

function mapRow(r: RawSessionRow): SessionRow {
  return {
    sessionId: brandSessionId(r.session_id),
    runId: brandRunId(r.run_id),
    vendor: r.vendor,
    createdAt: r.created_at,
  };
}

const INSERT_SESSION_SQL =
  "INSERT OR IGNORE INTO sessions (session_id, run_id, vendor, created_at) VALUES (?, ?, ?, ?)";
// Latest session for a run. Phase 2.C: a single run may record multiple
// sessions if the adapter forks/resumes mid-stream; the last one wins on
// lookup.
const GET_LATEST_SESSION_BY_RUN_SQL =
  "SELECT * FROM sessions WHERE run_id = ? ORDER BY created_at DESC LIMIT 1";
const GET_SESSION_BY_ID_SQL = "SELECT * FROM sessions WHERE session_id = ?";
const LIST_SESSIONS_FOR_RUN_SQL = "SELECT * FROM sessions WHERE run_id = ? ORDER BY created_at";

export function insertSession(db: ShamuDatabase, input: InsertSessionInput): void {
  const now = input.createdAt ?? Date.now();
  db.prepare(INSERT_SESSION_SQL).run(input.sessionId, input.runId, input.vendor, now);
}

export function getSessionByRunId(db: ShamuDatabase, id: RunId): SessionRow | null {
  const row = db.prepare(GET_LATEST_SESSION_BY_RUN_SQL).get(id) as RawSessionRow | undefined;
  return row ? mapRow(row) : null;
}

export function getSessionById(db: ShamuDatabase, id: SessionId): SessionRow | null {
  const row = db.prepare(GET_SESSION_BY_ID_SQL).get(id) as RawSessionRow | undefined;
  return row ? mapRow(row) : null;
}

export function listSessionsForRun(db: ShamuDatabase, id: RunId): readonly SessionRow[] {
  const rows = db.prepare(LIST_SESSIONS_FOR_RUN_SQL).all(id) as RawSessionRow[];
  return rows.map(mapRow);
}
