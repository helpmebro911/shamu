// JSONL producer: emits N events as newline-delimited JSON to stdout with optional jitter.
// Usage: bun src/jsonl-producer.ts <count> [jitterMs]
//    or: node --experimental-strip-types src/jsonl-producer.ts <count> [jitterMs]

const count = Number(process.argv[2] ?? 1000);
const jitterMs = Number(process.argv[3] ?? 0);

// We use process.stdout directly so behavior is identical across Bun/Node.
// Timestamp is captured in nanoseconds-since-origin via process.hrtime.bigint()
// BEFORE the write, so the consumer can measure wire-level latency accurately.

const hrtimeOrigin = process.hrtime.bigint();
const wallOrigin = BigInt(Date.now()) * 1_000_000n; // ns

function nowNs(): bigint {
  return wallOrigin + (process.hrtime.bigint() - hrtimeOrigin);
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((r) => setTimeout(r, ms));
}

// Backpressure-aware write: if stdout returns false, wait for `drain`.
// Works under both Node (stream) and Bun (has a .write() that always returns true
// for its writable, so the drain wait is a no-op there).
function writeWithBackpressure(chunk: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ok = process.stdout.write(chunk, (err) => {
      if (err) reject(err);
    });
    if (ok) {
      resolve();
    } else {
      // Node-only path: wait for drain.
      (process.stdout as any).once?.("drain", resolve);
      // Bun fallback if it lacks once on stdout
      if (!(process.stdout as any).once) resolve();
    }
  });
}

// Swallow EPIPE so the producer exits cleanly if the consumer closes early.
process.stdout.on?.("error", (err: any) => {
  if (err?.code === "EPIPE") process.exit(0);
});

async function main() {
  for (let i = 0; i < count; i++) {
    // Optional jitter: every ~100 events, sleep 0-jitterMs
    if (jitterMs > 0 && i > 0 && i % 100 === 0) {
      await sleep(Math.random() * jitterMs);
    }
    const event = {
      seq: i,
      emittedNs: nowNs().toString(),
      kind: "tick",
      payload: `event-${i}-` + "x".repeat(64), // ~80 bytes payload, realistic for assistant delta
    };
    await writeWithBackpressure(JSON.stringify(event) + "\n");
  }
}

main().catch((err) => {
  process.stderr.write(`producer error: ${err}\n`);
  process.exit(1);
});
