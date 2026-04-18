/**
 * Typed query helpers for the audit chain.
 *
 * Each row's `row_hmac` is computed as:
 *
 *   HMAC(audit_secret, seq || '\n' || prev_hmac || '\n' || canonicalJson(entry))
 *
 * The separator bytes and canonical-JSON contract make the HMAC
 * deterministic and tamper-evident. `canonicalJson` sorts object keys so
 * whitespace / key-order drift doesn't break verification.
 *
 * The audit_secret lives in the OS keychain under
 * `(service: "shamu", account: "audit-hmac-secret")`. If it's missing on
 * first boot, we generate a 32-byte random value, write it, and continue.
 * Subsequent runs read the existing value.
 */

import { createHash, createHmac, randomBytes } from "node:crypto";
import type { AuditEvent } from "@shamu/shared/audit";
import type { CredentialStore } from "@shamu/shared/credentials";
import { AuditChainError } from "@shamu/shared/errors";
import { type AuditEventId, auditEventId, newAuditEventId } from "@shamu/shared/ids";
import { err, ok, type Result } from "@shamu/shared/result";
import type { ShamuDatabase } from "../db.ts";

const AUDIT_SECRET_SERVICE = "shamu";
const AUDIT_SECRET_ACCOUNT = "audit-hmac-secret";

const ROW_SEP = "\n";
const GENESIS_HMAC = "0".repeat(64); // 32 bytes hex zero — chain seed

export interface AuditRow {
  readonly auditEventId: AuditEventId;
  readonly seq: number;
  readonly actor: string;
  readonly action: string;
  readonly entity: string;
  readonly reason: string;
  readonly ts: number;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly prevHmac: string;
  readonly rowHmac: string;
}

interface RawAuditRow {
  audit_event_id: string;
  seq: number;
  actor: string;
  action: string;
  entity: string;
  reason: string;
  ts: number;
  payload_json: string;
  prev_hmac: string;
  row_hmac: string;
}

function mapRow(r: RawAuditRow): AuditRow {
  return {
    auditEventId: auditEventId(r.audit_event_id),
    seq: r.seq,
    actor: r.actor,
    action: r.action,
    entity: r.entity,
    reason: r.reason,
    ts: r.ts,
    payload: JSON.parse(r.payload_json) as Record<string, unknown>,
    prevHmac: r.prev_hmac,
    rowHmac: r.row_hmac,
  };
}

/**
 * Stable JSON encoder for HMAC input.
 *
 * Sorts object keys recursively so that two structurally-equal rows with
 * different insertion orders hash the same.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`);
  return `{${parts.join(",")}}`;
}

function hmacRow(secret: Buffer, seq: number, prevHmac: string, entryJson: string): string {
  const mac = createHmac("sha256", secret);
  mac.update(String(seq));
  mac.update(ROW_SEP);
  mac.update(prevHmac);
  mac.update(ROW_SEP);
  mac.update(entryJson);
  return mac.digest("hex");
}

function canonicalEntryJson(entry: {
  actor: string;
  action: string;
  entity: string;
  reason: string;
  ts: number;
  payload: Record<string, unknown>;
}): string {
  return canonicalJson({
    actor: entry.actor,
    action: entry.action,
    entity: entry.entity,
    payload: entry.payload,
    reason: entry.reason,
    ts: entry.ts,
  });
}

/**
 * Constant-time comparison over two hex-encoded strings. We hash both sides
 * before comparing so that early-exit timing cannot leak information.
 */
function hexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= (ha[i] ?? 0) ^ (hb[i] ?? 0);
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Secret management
// ---------------------------------------------------------------------------

/**
 * Read (or generate + store) the audit HMAC secret. Called once per process
 * and cached on the returned `AuditLog` handle. First boot produces a fresh
 * 32-byte value and writes it to the OS keychain.
 */
export async function loadOrCreateAuditSecret(store: CredentialStore): Promise<Buffer> {
  const existing = await store.get(AUDIT_SECRET_SERVICE, AUDIT_SECRET_ACCOUNT);
  if (existing !== null && existing.length > 0) {
    return Buffer.from(existing, "hex");
  }
  const fresh = randomBytes(32);
  await store.set(AUDIT_SECRET_SERVICE, AUDIT_SECRET_ACCOUNT, fresh.toString("hex"));
  return fresh;
}

// ---------------------------------------------------------------------------
// Append + verify
// ---------------------------------------------------------------------------

const SELECT_TAIL_SQL = "SELECT seq, row_hmac FROM audit_events ORDER BY seq DESC LIMIT 1";

const INSERT_SQL =
  "INSERT INTO audit_events (audit_event_id, seq, actor, action, entity, reason, ts, payload_json, prev_hmac, row_hmac) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

const SELECT_CHAIN_SQL = "SELECT * FROM audit_events WHERE seq >= ? AND seq <= ? ORDER BY seq";

const SELECT_CHAIN_UNBOUNDED_SQL = "SELECT * FROM audit_events ORDER BY seq";

export interface AuditAppendContext {
  readonly db: ShamuDatabase;
  readonly secret: Buffer;
}

/**
 * Append an audit event.
 *
 * Runs as a single transaction: read tail → compute HMAC → insert. If two
 * writers race, SQLite's single-writer lock serializes the transactions and
 * the UNIQUE constraint on `seq` catches any skew.
 */
export function appendAudit(ctx: AuditAppendContext, entry: AuditEvent): AuditRow {
  return ctx.db.transaction(() => {
    const tail = ctx.db.prepare(SELECT_TAIL_SQL).get() as
      | { seq: number; row_hmac: string }
      | undefined;
    const nextSeq = (tail?.seq ?? -1) + 1;
    const prevHmac = tail?.row_hmac ?? GENESIS_HMAC;
    const canonicalPayload = entry.payload ?? {};
    const canonical = canonicalEntryJson({
      actor: entry.actor,
      action: entry.action,
      entity: entry.entity,
      reason: entry.reason,
      ts: entry.ts,
      payload: canonicalPayload,
    });
    const rowHmac = hmacRow(ctx.secret, nextSeq, prevHmac, canonical);
    const id = newAuditEventId();
    ctx.db
      .prepare(INSERT_SQL)
      .run(
        id,
        nextSeq,
        entry.actor,
        entry.action,
        entry.entity,
        entry.reason,
        entry.ts,
        JSON.stringify(canonicalPayload),
        prevHmac,
        rowHmac,
      );
    return {
      auditEventId: id,
      seq: nextSeq,
      actor: entry.actor,
      action: entry.action,
      entity: entry.entity,
      reason: entry.reason,
      ts: entry.ts,
      payload: canonicalPayload,
      prevHmac,
      rowHmac,
    };
  });
}

/**
 * Walk the chain from `fromSeq` to `toSeq` inclusive (defaults: the whole
 * chain). Returns `Ok(void)` if every row's prev_hmac matches the previous
 * row's row_hmac AND every row_hmac is a valid HMAC for its contents.
 * Otherwise returns `Err(AuditChainError)` pointing at the first bad seq.
 */
export function verifyAuditChain(
  ctx: AuditAppendContext,
  fromSeq?: number,
  toSeq?: number,
): Result<void, AuditChainError> {
  const rows = (
    fromSeq === undefined && toSeq === undefined
      ? ctx.db.prepare(SELECT_CHAIN_UNBOUNDED_SQL).all()
      : ctx.db.prepare(SELECT_CHAIN_SQL).all(fromSeq ?? 0, toSeq ?? Number.MAX_SAFE_INTEGER)
  ) as RawAuditRow[];

  if (rows.length === 0) return ok(undefined);

  // Establish starting prev_hmac. If the requested range starts at seq=0,
  // prev must be GENESIS. Otherwise, fetch the row at (firstSeq - 1) to
  // anchor the chain.
  const first = rows[0];
  if (!first) return ok(undefined);
  let expectedPrev: string;
  if (first.seq === 0) {
    expectedPrev = GENESIS_HMAC;
  } else {
    const anchor = ctx.db
      .prepare("SELECT row_hmac FROM audit_events WHERE seq = ?")
      .get(first.seq - 1) as { row_hmac: string } | undefined;
    if (!anchor) {
      return err(
        new AuditChainError(
          `Anchor row at seq ${first.seq - 1} missing; cannot verify chain starting at ${first.seq}`,
          first.seq,
        ),
      );
    }
    expectedPrev = anchor.row_hmac;
  }

  let lastSeq = first.seq - 1;
  for (const raw of rows) {
    if (raw.seq !== lastSeq + 1) {
      return err(new AuditChainError(`Seq gap: expected ${lastSeq + 1}, got ${raw.seq}`, raw.seq));
    }
    if (!hexEqual(raw.prev_hmac, expectedPrev)) {
      return err(
        new AuditChainError(
          `prev_hmac mismatch at seq ${raw.seq}: expected ${expectedPrev}, stored ${raw.prev_hmac}`,
          raw.seq,
        ),
      );
    }
    const payload = JSON.parse(raw.payload_json) as Record<string, unknown>;
    const canonical = canonicalEntryJson({
      actor: raw.actor,
      action: raw.action,
      entity: raw.entity,
      reason: raw.reason,
      ts: raw.ts,
      payload,
    });
    const expectedRow = hmacRow(ctx.secret, raw.seq, raw.prev_hmac, canonical);
    if (!hexEqual(expectedRow, raw.row_hmac)) {
      return err(
        new AuditChainError(
          `row_hmac mismatch at seq ${raw.seq}; content may have been tampered`,
          raw.seq,
        ),
      );
    }
    expectedPrev = raw.row_hmac;
    lastSeq = raw.seq;
  }
  return ok(undefined);
}

/**
 * Read rows in a given range (or all). Useful for inspecting / exporting.
 */
export function listAudit(
  ctx: AuditAppendContext,
  fromSeq?: number,
  toSeq?: number,
): readonly AuditRow[] {
  const rows = (
    fromSeq === undefined && toSeq === undefined
      ? ctx.db.prepare(SELECT_CHAIN_UNBOUNDED_SQL).all()
      : ctx.db.prepare(SELECT_CHAIN_SQL).all(fromSeq ?? 0, toSeq ?? Number.MAX_SAFE_INTEGER)
  ) as RawAuditRow[];
  return rows.map(mapRow);
}

// Re-export helpers for consumers building their own append contexts.
export { canonicalEntryJson, canonicalJson, GENESIS_HMAC, hmacRow };
export type AuditVerifyResult = Result<void, AuditChainError>;
