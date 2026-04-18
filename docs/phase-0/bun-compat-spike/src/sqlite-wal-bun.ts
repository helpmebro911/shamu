// SQLite WAL concurrency test under Bun using bun:sqlite.
// Spawns 1 writer + N reader subprocesses; writer inserts events at a target rate;
// readers continuously query. Measures write p50/p99, read p50/p99, detects
// corruption. Results: JSON to stdout.
//
// Usage: bun src/sqlite-wal-bun.ts <writeRatePerSec> <durationSec> <readers>
//
// Default: 100 writes/s, 60s, 10 readers.
//
// Role dispatch via WORKER_ROLE env: "writer" | "reader" | undefined (orchestrator).

import { Database } from "bun:sqlite";
import { spawn } from "bun";
import { unlinkSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const role = process.env.WORKER_ROLE;
const dbPath = process.env.DB_PATH || join(dirname(fileURLToPath(import.meta.url)), "..", "results", "wal-bun.db");

if (role === "writer") {
  await writerLoop();
} else if (role === "reader") {
  await readerLoop();
} else {
  await orchestrator();
}

function hrtimeMs(): number {
  return Number(process.hrtime.bigint()) / 1_000_000;
}

function openDb(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  return db;
}

function ensureSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      seq INTEGER NOT NULL,
      ts_ns INTEGER NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id, seq);
  `);
}

async function orchestrator() {
  const writeRate = Number(process.argv[2] ?? 100);
  const durationSec = Number(process.argv[3] ?? 60);
  const readerCount = Number(process.argv[4] ?? 10);

  // Reset database
  for (const ext of ["", "-shm", "-wal"]) {
    if (existsSync(dbPath + ext)) unlinkSync(dbPath + ext);
  }
  // Create schema
  const bootstrap = openDb(dbPath);
  ensureSchema(bootstrap);
  bootstrap.close();

  const selfPath = fileURLToPath(import.meta.url);
  const writer = spawn({
    cmd: ["bun", selfPath, String(writeRate), String(durationSec), String(readerCount)],
    env: { ...process.env, WORKER_ROLE: "writer", DB_PATH: dbPath },
    stdout: "pipe",
    stderr: "inherit",
  });
  const readers = Array.from({ length: readerCount }, (_, i) =>
    spawn({
      cmd: ["bun", selfPath, String(writeRate), String(durationSec), String(readerCount)],
      env: { ...process.env, WORKER_ROLE: "reader", DB_PATH: dbPath, READER_ID: String(i) },
      stdout: "pipe",
      stderr: "inherit",
    })
  );

  async function collect(proc: ReturnType<typeof spawn>): Promise<any> {
    // proc.stdout is a ReadableStream in Bun when stdout: "pipe" is set.
    const stream = proc.stdout as unknown as ReadableStream<Uint8Array>;
    const text = await new Response(stream).text();
    await proc.exited;
    try {
      return JSON.parse(text.trim().split("\n").pop() || "{}");
    } catch {
      return { error: "parse-failed", raw: text };
    }
  }

  const [writerResult, ...readerResults] = await Promise.all([
    collect(writer),
    ...readers.map(collect),
  ]);

  // Verify integrity from orchestrator's perspective
  const db = openDb(dbPath);
  const count = db.query("SELECT COUNT(*) as c FROM events").get() as { c: number };
  const max = db.query("SELECT MAX(seq) as m FROM events WHERE run_id = 'spike'").get() as { m: number | null };
  const integrity = db.query("PRAGMA integrity_check").get() as { integrity_check: string };
  db.close();

  console.log(
    JSON.stringify(
      {
        runtime: "bun",
        bunVersion: typeof Bun !== "undefined" ? Bun.version : undefined,
        writeRate,
        durationSec,
        readerCount,
        writer: writerResult,
        readers: readerResults,
        finalRowCount: count.c,
        finalMaxSeq: max.m,
        integrity: integrity.integrity_check,
      },
      null,
      2
    )
  );
}

async function writerLoop() {
  const writeRate = Number(process.argv[2] ?? 100);
  const durationSec = Number(process.argv[3] ?? 60);
  const db = openDb(dbPath);
  ensureSchema(db);
  const insert = db.prepare("INSERT INTO events (run_id, kind, seq, ts_ns, payload) VALUES (?, ?, ?, ?, ?)");

  const intervalMs = 1000 / writeRate;
  const deadline = hrtimeMs() + durationSec * 1000;
  const latencies: number[] = [];
  let seq = 0;
  let errors = 0;
  let nextTick = hrtimeMs();

  while (hrtimeMs() < deadline) {
    const now = hrtimeMs();
    if (now < nextTick) {
      const wait = nextTick - now;
      await new Promise((r) => setTimeout(r, Math.max(0, Math.min(wait, 50))));
      continue;
    }
    nextTick += intervalMs;
    const t0 = hrtimeMs();
    try {
      insert.run("spike", "tick", seq++, BigInt(Date.now()) * 1_000_000n, `payload-${seq}`);
      latencies.push(hrtimeMs() - t0);
    } catch (e) {
      errors++;
    }
  }
  db.close();

  latencies.sort((a, b) => a - b);
  const p = (q: number) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * q))];
  const actualRate = seq / durationSec;

  console.log(
    JSON.stringify({
      role: "writer",
      targetRate: writeRate,
      actualRate: Math.round(actualRate * 10) / 10,
      writesAttempted: seq,
      errors,
      writeMsP50: Math.round((p(0.5) ?? 0) * 1000) / 1000,
      writeMsP95: Math.round((p(0.95) ?? 0) * 1000) / 1000,
      writeMsP99: Math.round((p(0.99) ?? 0) * 1000) / 1000,
      writeMsMax: Math.round((latencies[latencies.length - 1] ?? 0) * 1000) / 1000,
    })
  );
}

async function readerLoop() {
  const durationSec = Number(process.argv[3] ?? 60);
  const db = openDb(dbPath);
  ensureSchema(db);
  const countQ = db.prepare("SELECT COUNT(*) as c FROM events WHERE run_id = 'spike'");
  const recentQ = db.prepare("SELECT id, seq FROM events WHERE run_id = 'spike' ORDER BY id DESC LIMIT 50");

  const deadline = hrtimeMs() + durationSec * 1000;
  const latencies: number[] = [];
  let reads = 0;
  let errors = 0;
  let maxSeqSeen = -1;
  let seqRegressions = 0;

  while (hrtimeMs() < deadline) {
    const t0 = hrtimeMs();
    try {
      const c = countQ.get() as { c: number };
      const rows = recentQ.all() as { id: number; seq: number }[];
      latencies.push(hrtimeMs() - t0);
      if (rows.length > 0) {
        const localMax = rows[0].seq;
        if (localMax < maxSeqSeen) seqRegressions++;
        if (localMax > maxSeqSeen) maxSeqSeen = localMax;
      }
      reads++;
    } catch (e) {
      errors++;
    }
    // tiny yield so we don't peg the CPU
    await new Promise((r) => setImmediate(r));
  }
  db.close();

  latencies.sort((a, b) => a - b);
  const p = (q: number) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * q))];
  console.log(
    JSON.stringify({
      role: "reader",
      reads,
      errors,
      maxSeqSeen,
      seqRegressions,
      readMsP50: Math.round((p(0.5) ?? 0) * 1000) / 1000,
      readMsP95: Math.round((p(0.95) ?? 0) * 1000) / 1000,
      readMsP99: Math.round((p(0.99) ?? 0) * 1000) / 1000,
      readMsMax: Math.round((latencies[latencies.length - 1] ?? 0) * 1000) / 1000,
    })
  );
}
