/**
 * Canonical SQLite schema.
 *
 * Every table uses:
 *   - TEXT ids (ULIDs, branded at the TS layer).
 *   - TEXT JSON payloads (SQLite has no native JSON type; the typed query
 *     helpers serialize/deserialize at the boundary).
 *   - INTEGER monotonic timestamps (`Date.now()` / `Bun.nanoseconds()`).
 *   - `STRICT` table mode so a typo in an INSERT raises immediately.
 *
 * The audit_events table is append-only, enforced via triggers.
 *
 * The schema_migrations table records applied migrations (version,
 * applied_at, checksum). The schema_lock table is the advisory lock used by
 * the migration runner: if a row with id=1 exists when a runner starts, it
 * backs off (another process is migrating).
 */

export const INITIAL_SCHEMA_SQL = `
-- Advisory lock for the migration runner. One row (id=1) means a migration
-- is in flight.
CREATE TABLE IF NOT EXISTS schema_lock (
  id         INTEGER PRIMARY KEY,
  locked_at  INTEGER NOT NULL
) STRICT;

-- Applied migration records.
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     INTEGER PRIMARY KEY,
  applied_at  INTEGER NOT NULL,
  checksum    TEXT NOT NULL
) STRICT;

-- Runs: one per supervised agent invocation.
CREATE TABLE IF NOT EXISTS runs (
  run_id      TEXT PRIMARY KEY,
  swarm_id    TEXT,
  role        TEXT,
  vendor      TEXT,
  status      TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
CREATE INDEX IF NOT EXISTS idx_runs_swarm ON runs(swarm_id);

-- Vendor session IDs for warm-resume.
CREATE TABLE IF NOT EXISTS sessions (
  session_id  TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES runs(run_id),
  vendor      TEXT NOT NULL,
  created_at  INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_sessions_run ON sessions(run_id);

-- Raw vendor event capture (post-redaction). Append-only by convention.
CREATE TABLE IF NOT EXISTS raw_events (
  event_id     TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL,
  vendor       TEXT NOT NULL,
  ts           INTEGER NOT NULL,
  payload_json TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_raw_events_run_ts ON raw_events(run_id, ts);

-- Normalized event projection. Migratable; idempotent on event_id.
CREATE TABLE IF NOT EXISTS events (
  event_id         TEXT PRIMARY KEY,
  run_id           TEXT NOT NULL,
  session_id       TEXT,
  turn_id          TEXT NOT NULL,
  parent_event_id  TEXT,
  seq              INTEGER NOT NULL,
  ts_monotonic     INTEGER NOT NULL,
  ts_wall          INTEGER NOT NULL,
  vendor           TEXT NOT NULL,
  kind             TEXT NOT NULL,
  payload_json     TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_events_run_seq ON events(run_id, seq);
CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind);

-- Workflow progress checkpoints.
CREATE TABLE IF NOT EXISTS checkpoints (
  checkpoint_id  TEXT PRIMARY KEY,
  run_id         TEXT NOT NULL,
  seq            INTEGER NOT NULL,
  summary        TEXT NOT NULL,
  ts             INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_checkpoints_run_ts ON checkpoints(run_id, ts);

-- Inter-agent mailbox. from_agent is set by the orchestrator from run
-- context; the persistence layer trusts the caller (G6 enforcement is at a
-- higher layer).
CREATE TABLE IF NOT EXISTS mailbox (
  msg_id        TEXT PRIMARY KEY,
  swarm_id      TEXT NOT NULL,
  from_agent    TEXT NOT NULL,
  to_agent      TEXT NOT NULL,
  body          TEXT NOT NULL,
  delivered_at  INTEGER NOT NULL,
  read_at       INTEGER
) STRICT;

CREATE INDEX IF NOT EXISTS idx_mailbox_to ON mailbox(to_agent, delivered_at);
CREATE INDEX IF NOT EXISTS idx_mailbox_swarm ON mailbox(swarm_id, delivered_at);

-- File-glob leases. holder_worktree_path is the executor worktree root;
-- the stale-lease reclaim check runs "git status --porcelain" there.
CREATE TABLE IF NOT EXISTS leases (
  lease_id              TEXT PRIMARY KEY,
  swarm_id              TEXT NOT NULL,
  agent                 TEXT NOT NULL,
  holder_run_id         TEXT NOT NULL,
  holder_worktree_path  TEXT NOT NULL,
  glob                  TEXT NOT NULL,
  acquired_at           INTEGER NOT NULL,
  expires_at            INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_leases_swarm ON leases(swarm_id);
CREATE INDEX IF NOT EXISTS idx_leases_agent ON leases(agent);
CREATE INDEX IF NOT EXISTS idx_leases_expiry ON leases(expires_at);

-- Linear issue correlation.
CREATE TABLE IF NOT EXISTS linear_issues (
  issue_id     TEXT PRIMARY KEY,
  identifier   TEXT,
  run_id       TEXT,
  comment_id   TEXT,
  status       TEXT,
  updated_at   INTEGER
) STRICT;

CREATE INDEX IF NOT EXISTS idx_linear_issues_run ON linear_issues(run_id);

-- agent-ci runs attached to patches.
CREATE TABLE IF NOT EXISTS ci_runs (
  ci_run_id     TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL,
  status        TEXT NOT NULL,
  summary_json  TEXT,
  started_at    INTEGER NOT NULL,
  completed_at  INTEGER
) STRICT;

CREATE INDEX IF NOT EXISTS idx_ci_runs_run ON ci_runs(run_id);

-- Resumable workflow state.
CREATE TABLE IF NOT EXISTS flow_runs (
  flow_run_id   TEXT PRIMARY KEY,
  swarm_id      TEXT NOT NULL,
  dag_version   TEXT NOT NULL,
  state_json    TEXT NOT NULL,
  resumed_from  TEXT,
  updated_at    INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_flow_runs_swarm ON flow_runs(swarm_id);

-- HMAC-chained audit log. seq is monotonic and UNIQUE; row_hmac chains from
-- prev_hmac so any retroactive mutation breaks verification.
CREATE TABLE IF NOT EXISTS audit_events (
  audit_event_id  TEXT PRIMARY KEY,
  seq             INTEGER UNIQUE NOT NULL,
  actor           TEXT NOT NULL,
  action          TEXT NOT NULL,
  entity          TEXT NOT NULL,
  reason          TEXT NOT NULL,
  ts              INTEGER NOT NULL,
  payload_json    TEXT NOT NULL,
  prev_hmac       TEXT NOT NULL,
  row_hmac        TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_audit_events_seq ON audit_events(seq);

-- Append-only triggers: any UPDATE/DELETE on audit_events raises.
CREATE TRIGGER IF NOT EXISTS audit_events_no_update
BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only');
END;

CREATE TRIGGER IF NOT EXISTS audit_events_no_delete
BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit_events is append-only');
END;
`;
