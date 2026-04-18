// Same test as sqlite-wal-bun.ts, but with Node + better-sqlite3.

import BetterSqlite3 from "better-sqlite3";
import { spawn } from "node:child_process";
import { unlinkSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const role = process.env.WORKER_ROLE;
const dbPath = process.env.DB_PATH || join(dirname(fileURLToPath(import.meta.url)), "..", "results", "wal-node.db");

function hrtimeMs(): number {
  return Number(process.hrtime.bigint()) / 1_000_000;
}

function openDb(path: string): BetterSqlite3.Database {
  const db = new BetterSqlite3(path);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
  return db;
}

function ensureSchema(db: BetterSqlite3.Database): void {
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

  for (const ext of ["", "-shm", "-wal"]) {
    if (existsSync(dbPath + ext)) unlinkSync(dbPath + ext);
  }
  const bootstrap = openDb(dbPath);
  ensureSchema(bootstrap);
  bootstrap.close();

  const selfPath = fileURLToPath(import.meta.url);

  function spawnWorker(role: "writer" | "reader", id?: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn(
        process.execPath,
        ["--experimental-strip-types", selfPath, String(writeRate), String(durationSec), String(readerCount)],
        {
          env: { ...process.env, WORKER_ROLE: role, DB_PATH: dbPath, READER_ID: String(id ?? 0) },
          stdio: ["ignore", "pipe", "inherit"],
        }
      );
      let buf = "";
      proc.stdout.on("data", (d) => (buf += d.toString()));
      proc.on("close", () => resolve(buf.trim().split("\n").pop() || "{}"));
      proc.on("error", reject);
    });
  }

  const writerP = spawnWorker("writer");
  const readerPs = Array.from({ length: readerCount }, (_, i) => spawnWorker("reader", i));
  const [writerRaw, ...readersRaw] = await Promise.all([writerP, ...readerPs]);

  const parse = (r: string) => {
    try {
      return JSON.parse(r);
    } catch {
      return { error: "parse-failed", raw: r };
    }
  };

  const db = openDb(dbPath);
  const countRow = db.prepare("SELECT COUNT(*) as c FROM events").get() as { c: number };
  const maxRow = db.prepare("SELECT MAX(seq) as m FROM events WHERE run_id = 'spike'").get() as { m: number | null };
  const integrity = db.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
  db.close();

  console.log(
    JSON.stringify(
      {
        runtime: "node",
        nodeVersion: process.version,
        writeRate,
        durationSec,
        readerCount,
        writer: parse(writerRaw),
        readers: readersRaw.map(parse),
        finalRowCount: countRow.c,
        finalMaxSeq: maxRow.m,
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
    } catch {
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
      countQ.get();
      const rows = recentQ.all() as { id: number; seq: number }[];
      latencies.push(hrtimeMs() - t0);
      if (rows.length > 0) {
        const localMax = rows[0].seq;
        if (localMax < maxSeqSeen) seqRegressions++;
        if (localMax > maxSeqSeen) maxSeqSeen = localMax;
      }
      reads++;
    } catch {
      errors++;
    }
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

if (role === "writer") await writerLoop();
else if (role === "reader") await readerLoop();
else await orchestrator();
