// JSONL consumer under Bun. Spawns the producer with Bun.spawn and reads stdout
// as a line-delimited stream, measuring delivery latency.
// Usage: bun src/jsonl-consumer-bun.ts <count> [jitterMs] [slowConsumerMs]
//  slowConsumerMs: if >0, consumer sleeps this many ms every 1000 events to simulate backpressure.

import { spawn } from "bun";

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
  const producerPath = new URL("./jsonl-producer.ts", import.meta.url).pathname;
  const runStart = nowNs();

  const proc = spawn({
    cmd: ["bun", producerPath, String(count), String(jitterMs)],
    stdout: "pipe",
    stderr: "pipe",
  });

  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const latencies: number[] = []; // microseconds
  let received = 0;
  let lastSeq = -1;
  let gaps = 0;
  let maxRss = 0;

  // Track memory periodically
  const memTimer = setInterval(() => {
    const rss = process.memoryUsage().rss;
    if (rss > maxRss) maxRss = rss;
  }, 50);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
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
        latencies.push(latNs / 1000); // microseconds
        if (ev.seq !== lastSeq + 1) gaps++;
        lastSeq = ev.seq;
        received++;

        if (slowConsumerMs > 0 && received % 1000 === 0) {
          await new Promise((r) => setTimeout(r, slowConsumerMs));
        }
      }
    }
  } finally {
    clearInterval(memTimer);
    reader.releaseLock();
  }

  await proc.exited;
  const runEnd = nowNs();
  const wallMs = Number(runEnd - runStart) / 1_000_000;

  // Stats
  latencies.sort((a, b) => a - b);
  const p = (q: number) =>
    latencies.length === 0
      ? 0
      : latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * q))];
  const maxRssMb = Math.round((maxRss / 1024 / 1024) * 10) / 10;

  const result = {
    runtime: "bun",
    bunVersion: typeof Bun !== "undefined" ? Bun.version : undefined,
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
    exitCode: proc.exitCode,
  };

  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error("consumer error:", err);
  process.exit(1);
});
