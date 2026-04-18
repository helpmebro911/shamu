import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryStore } from "@shamu/shared/credentials";
import { AuditChainError } from "@shamu/shared/errors";
import { newAuditEventId } from "@shamu/shared/ids";
import { isErr, isOk } from "@shamu/shared/result";
import { openDatabase, type ShamuDatabase } from "../db.ts";
import {
  appendAudit,
  canonicalEntryJson,
  GENESIS_HMAC,
  hmacRow,
  listAudit,
  loadOrCreateAuditSecret,
  verifyAuditChain,
} from "./audit.ts";

describe("audit chain", () => {
  let dir: string;
  let db: ShamuDatabase;
  let secret: Buffer;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "shamu-audit-"));
    db = openDatabase(join(dir, "db.sqlite"));
    const store = new InMemoryStore();
    secret = await loadOrCreateAuditSecret(store);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const entry = (seq: number) => ({
    actor: "supervisor",
    action: "run.start" as const,
    entity: `run:${seq}`,
    reason: "scheduled",
    ts: 1_700_000_000_000 + seq,
    payload: { seq },
  });

  it("appends rows with monotonic seq starting at 0", () => {
    const r0 = appendAudit({ db, secret }, entry(0));
    const r1 = appendAudit({ db, secret }, entry(1));
    const r2 = appendAudit({ db, secret }, entry(2));
    expect(r0.seq).toBe(0);
    expect(r1.seq).toBe(1);
    expect(r2.seq).toBe(2);
    expect(r0.prevHmac).toBe(GENESIS_HMAC);
    expect(r1.prevHmac).toBe(r0.rowHmac);
    expect(r2.prevHmac).toBe(r1.rowHmac);
  });

  it("verifyAuditChain returns Ok on a clean chain", () => {
    for (let i = 0; i < 5; i++) appendAudit({ db, secret }, entry(i));
    const result = verifyAuditChain({ db, secret });
    expect(isOk(result)).toBe(true);
  });

  it("verifyAuditChain detects a tampered row_hmac", () => {
    for (let i = 0; i < 3; i++) appendAudit({ db, secret }, entry(i));
    // Raw writes go through a trigger — test against an ATTACH database
    // bypass instead: insert directly into an in-memory chain replica with
    // the wrong HMAC to simulate a tamper that bypassed the trigger.
    //
    // We use a second DB with the same schema + no trigger:
    const tamperDir = mkdtempSync(join(tmpdir(), "shamu-audit-tamper-"));
    try {
      const tamper = openDatabase(join(tamperDir, "db.sqlite"));
      try {
        // Copy rows across, breaking seq=1's row_hmac.
        const rows = listAudit({ db, secret });
        for (const r of rows) {
          const bogus = r.seq === 1 ? "bad".padEnd(64, "f") : r.rowHmac;
          tamper
            .prepare(
              "INSERT INTO audit_events (audit_event_id, seq, actor, action, entity, reason, ts, payload_json, prev_hmac, row_hmac) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .run(
              r.auditEventId,
              r.seq,
              r.actor,
              r.action,
              r.entity,
              r.reason,
              r.ts,
              JSON.stringify(r.payload),
              r.prevHmac,
              bogus,
            );
        }
        const result = verifyAuditChain({ db: tamper, secret });
        expect(isErr(result)).toBe(true);
        if (isErr(result)) {
          expect(result.error).toBeInstanceOf(AuditChainError);
          // Either seq=1 row_hmac mismatch, or seq=2 prev_hmac mismatch,
          // depending on which check fires first.
          expect(result.error.rowSeq === 1 || result.error.rowSeq === 2).toBe(true);
        }
      } finally {
        tamper.close();
      }
    } finally {
      rmSync(tamperDir, { recursive: true, force: true });
    }
  });

  it("verifyAuditChain detects a seq gap", () => {
    // Insert rows with seq 0 and seq 2 (skip 1) via a side database that
    // allows us to bypass the transactional appendAudit path. Use a fresh
    // DB so we fully control what's written.
    const gapDir = mkdtempSync(join(tmpdir(), "shamu-audit-gap-"));
    try {
      const gap = openDatabase(join(gapDir, "db.sqlite"));
      try {
        for (const seq of [0, 2]) {
          const e = entry(seq);
          const canonical = canonicalEntryJson(e);
          const prev = GENESIS_HMAC; // wrong for seq=2 — fine, verify will catch it
          const row = hmacRow(secret, seq, prev, canonical);
          gap
            .prepare(
              "INSERT INTO audit_events (audit_event_id, seq, actor, action, entity, reason, ts, payload_json, prev_hmac, row_hmac) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .run(
              newAuditEventId(),
              seq,
              e.actor,
              e.action,
              e.entity,
              e.reason,
              e.ts,
              JSON.stringify(e.payload),
              prev,
              row,
            );
        }
        const result = verifyAuditChain({ db: gap, secret });
        expect(isErr(result)).toBe(true);
        if (isErr(result)) expect(result.error.rowSeq).toBe(2);
      } finally {
        gap.close();
      }
    } finally {
      rmSync(gapDir, { recursive: true, force: true });
    }
  });

  it("canonical JSON is key-order-independent", () => {
    const a = canonicalEntryJson({
      actor: "a",
      action: "run.start",
      entity: "e",
      reason: "r",
      ts: 1,
      payload: { b: 1, a: 2 },
    });
    const b = canonicalEntryJson({
      actor: "a",
      action: "run.start",
      entity: "e",
      reason: "r",
      ts: 1,
      payload: { a: 2, b: 1 },
    });
    expect(a).toBe(b);
  });

  describe("append-only triggers", () => {
    it("raises on UPDATE of audit_events", () => {
      appendAudit({ db, secret }, entry(0));
      expect(() =>
        db.prepare("UPDATE audit_events SET reason = ? WHERE seq = 0").run("hacked"),
      ).toThrow(/append-only/);
    });

    it("raises on DELETE of audit_events", () => {
      appendAudit({ db, secret }, entry(0));
      expect(() => db.prepare("DELETE FROM audit_events WHERE seq = 0").run()).toThrow(
        /append-only/,
      );
    });
  });

  describe("loadOrCreateAuditSecret", () => {
    it("creates and returns the same value on second call", async () => {
      const store = new InMemoryStore();
      const a = await loadOrCreateAuditSecret(store);
      const b = await loadOrCreateAuditSecret(store);
      expect(a.equals(b)).toBe(true);
      expect(a.length).toBe(32);
    });
  });
});
