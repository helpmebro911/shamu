// A tiny standalone program for `bun build --compile`.
// Exercises: bun:sqlite in WAL mode, spawning a subprocess, parsing stdout.
// Exits 0 on success.

import { Database } from "bun:sqlite";
import { spawn } from "bun";
import { dirname, join } from "node:path";
import { unlinkSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const start = performance.now();

// 1) SQLite WAL write + read.
const dbPath = join(tmpdir(), `shamu-standalone-${process.pid}.db`);
for (const ext of ["", "-shm", "-wal"]) {
  if (existsSync(dbPath + ext)) unlinkSync(dbPath + ext);
}
const db = new Database(dbPath, { create: true });
db.exec("PRAGMA journal_mode = WAL");
db.exec("CREATE TABLE IF NOT EXISTS ping (id INTEGER PRIMARY KEY, msg TEXT)");
const insert = db.prepare("INSERT INTO ping (msg) VALUES (?)");
for (let i = 0; i < 100; i++) insert.run(`msg-${i}`);
const row = db.query("SELECT COUNT(*) AS c FROM ping").get() as { c: number };
if (row.c !== 100) {
  console.error("standalone: unexpected row count", row);
  process.exit(1);
}
db.close();
for (const ext of ["", "-shm", "-wal"]) {
  if (existsSync(dbPath + ext)) unlinkSync(dbPath + ext);
}

// 2) Spawn a subprocess (`echo hello`) and collect stdout.
const echo = spawn({ cmd: ["/bin/echo", "hello-from-standalone"], stdout: "pipe" });
const out = await new Response(echo.stdout).text();
await echo.exited;
if (!out.includes("hello-from-standalone")) {
  console.error("standalone: subprocess output unexpected:", JSON.stringify(out));
  process.exit(1);
}

const ms = performance.now() - start;
console.log(
  JSON.stringify({
    ok: true,
    pingRowCount: row.c,
    subprocess: out.trim(),
    coldStartMs: Math.round(ms * 10) / 10,
  })
);
