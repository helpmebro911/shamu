// Node.js equivalent of the Bun consumer, using child_process.spawn + readline.
// Usage: node --experimental-strip-types src/jsonl-consumer-node.ts <count> [jitterMs] [slowConsumerMs]

import { spawn } from "node:child_process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const count = Number(process.argv[2] ?? 1000);
const jitterMs = Number(process.argv[3] ?? 0);
const slowConsumerMs = Number(process.argv[4] ?? 0);

const hrtimeOrigin = process.hrtime.bigint();
const wallOrigin = BigInt(Date.now()) * 1_000_000n;
function nowNs(): bigint {
  return wallOrigin + (process.hrtime.bigint() - hrtimeOrigin);
}

function memoryMb(): number {
  const m = process.memoryUsage();
  return Math.round((m.rss / 1024 / 1024) * 10) / 10;
}

async function main() {
  const producerPath = fileURLToPath(new URL("./jsonl-producer.ts", import.meta.url));
  const runStart = nowNs();

  const proc = spawn(process.execPath, ["--experimental-strip-types", producerPath, String(count), String(jitterMs)], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  const latencies: number[] = [];
  let received = 0;
  let lastSeq = -1;
  let gaps = 0;
  let maxRss = 0;

  const memTimer = setInterval(() => {
    const rss = process.memoryUsage().rss;
    if (rss > maxRss) maxRss = rss;
  }, 50);

  // Drain stderr so it doesn't pile up
  proc.stderr.on("data", (d) => process.stderr.write(d));

  // Attach close listener eagerly so we don't miss the event if the child
  // exits before the for-await loop finishes.
  let childExitCode: number | null = null;
  const childClosed = new Promise<number>((resolve) => {
    proc.on("close", (code) => {
      childExitCode = code ?? 0;
      resolve(childExitCode);
    });
  });

  const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    const recvNs = nowNs();
    let ev: { seq: number; emittedNs: string; kind: string; payload: string };
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    const emittedNs = BigInt(ev.emittedNs);
    const latNs = Number(recvNs - emittedNs);
    latencies.push(latNs / 1000);
    if (ev.seq !== lastSeq + 1) gaps++;
    lastSeq = ev.seq;
    received++;
    if (slowConsumerMs > 0 && received % 1000 === 0) {
      await new Promise((r) => setTimeout(r, slowConsumerMs));
    }
  }

  clearInterval(memTimer);

  const exitCode: number = childExitCode ?? (await childClosed);

  const runEnd = nowNs();
  const wallMs = Number(runEnd - runStart) / 1_000_000;

  latencies.sort((a, b) => a - b);
  const p = (q: number) =>
    latencies.length === 0
      ? 0
      : latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * q))];
  const maxRssMb = Math.round((maxRss / 1024 / 1024) * 10) / 10;

  const result = {
    runtime: "node",
    nodeVersion: process.version,
    expected: count,
    received,
    gaps,
    wallMs: Math.round(wallMs * 10) / 10,
    p50Us: Math.round(p(0.5)),
    p95Us: Math.round(p(0.95)),
    p99Us: Math.round(p(0.99)),
    maxUs: Math.round(latencies[latencies.length - 1] ?? 0),
    throughputPerSec: Math.round(received / (wallMs / 1000)),
    rssMb: memoryMb(),
    maxRssMb,
    jitterMs,
    slowConsumerMs,
    exitCode,
  };

  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error("consumer error:", err);
  process.exit(1);
});
