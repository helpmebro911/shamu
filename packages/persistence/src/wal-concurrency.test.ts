/**
 * WAL concurrency smoke test.
 *
 * Lifted from Phase 0.A (`docs/phase-0/bun-compat-spike/src/sqlite-wal-bun.ts`).
 * Opens N reader connections + 1 writer, pumps inserts for a short window,
 * verifies:
 *   - no errors raised on any connection
 *   - `PRAGMA integrity_check = ok`
 *   - reader max(seq) never regresses
 *
 * Kept small (1 second, 3 readers) so it fits in the default vitest
 * timeout without slowing every local run. The 0.A spike has the big
 * 60-second / 10-reader variant if someone wants the full stress.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newRunId } from "@shamu/shared/ids";
import { openDatabase, type ShamuDatabase } from "./db.ts";
import { insertEvent } from "./queries/events.ts";

describe("WAL concurrency smoke", () => {
  let dir: string;
  let dbPath: string;
  let writer: ShamuDatabase;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "shamu-wal-smoke-"));
    dbPath = join(dir, "db.sqlite");
    writer = openDatabase(dbPath);
  });

  afterEach(() => {
    writer.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("3 readers + 1 writer see consistent seq progression", async () => {
    const readers = Array.from({ length: 3 }, () => openDatabase(dbPath, { skipMigrations: true }));
    try {
      const runId = newRunId();
      let nextSeq = 0;
      let maxSeqSeen = -1;
      let seqRegressions = 0;
      let writerErrors = 0;
      let readerErrors = 0;

      const writeUntil = Date.now() + 500; // half-second pump — enough for contention
      const readUntil = writeUntil + 100;

      const readerLoops = readers.map(async (db) => {
        while (Date.now() < readUntil) {
          try {
            const row = db
              .prepare("SELECT MAX(seq) as m FROM events WHERE run_id = ?")
              .get(runId) as { m: number | null };
            const local = row.m ?? -1;
            if (local < maxSeqSeen) seqRegressions++;
            if (local > maxSeqSeen) maxSeqSeen = local;
            await new Promise((r) => setImmediate(r));
          } catch {
            readerErrors++;
          }
        }
      });

      const writerLoop = (async () => {
        while (Date.now() < writeUntil) {
          try {
            insertEvent(writer, {
              eventId:
                `${"0".repeat(10)}${nextSeq.toString(32).toUpperCase().padStart(16, "0")}` as never,
              runId,
              sessionId: null,
              turnId: runId as unknown as never,
              parentEventId: null,
              seq: nextSeq++,
              tsMonotonic: nextSeq,
              tsWall: Date.now(),
              vendor: "smoke",
              rawRef: null,
              kind: "checkpoint",
              summary: "tick",
            } as never);
          } catch {
            writerErrors++;
          }
          // Tiny yield so readers can interleave.
          await new Promise((r) => setImmediate(r));
        }
      })();

      await Promise.all([writerLoop, ...readerLoops]);

      expect(writerErrors).toBe(0);
      expect(readerErrors).toBe(0);
      expect(seqRegressions).toBe(0);
      const integrity = writer.prepare("PRAGMA integrity_check").get() as {
        integrity_check: string;
      };
      expect(integrity.integrity_check).toBe("ok");

      const finalCount = writer
        .prepare("SELECT COUNT(*) as c FROM events WHERE run_id = ?")
        .get(runId) as { c: number };
      expect(finalCount.c).toBeGreaterThan(0);
    } finally {
      for (const r of readers) r.close();
    }
  });
});
