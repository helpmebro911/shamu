// Quick check: Bun.spawn subprocess reaping under SIGINT and SIGTERM.
// Spawns a long-sleep child, kills it with various signals, measures how
// cleanly the parent observes the exit.

import { spawn } from "bun";

async function one(
  signal: "SIGINT" | "SIGTERM" | "SIGKILL",
  cmd: string[],
  label: string
): Promise<Record<string, unknown>> {
  const start = performance.now();
  const proc = spawn({
    cmd,
    stdout: "pipe",
    stderr: "pipe",
  });
  await new Promise((r) => setTimeout(r, 100)); // let child start
  const killStart = performance.now();
  proc.kill(signal);
  const exitCode = await proc.exited;
  const killEnd = performance.now();
  return {
    label,
    signal,
    exitCode,
    reapMs: Math.round((killEnd - killStart) * 100) / 100,
    totalMs: Math.round((killEnd - start) * 100) / 100,
  };
}

const out: unknown[] = [];

// Scenario A: direct long-sleep without shell — the signal hits sleep directly.
for (const sig of ["SIGINT", "SIGTERM", "SIGKILL"] as const) {
  out.push(await one(sig, ["sleep", "30"], "direct-sleep"));
}

// Scenario B: node child with its own async handler — realistic agent CLI shape.
const nodeScript = `
  process.on('SIGINT', () => { console.log('got SIGINT'); process.exit(10); });
  process.on('SIGTERM', () => { console.log('got SIGTERM'); process.exit(11); });
  setInterval(() => {}, 1000);
`;
for (const sig of ["SIGINT", "SIGTERM", "SIGKILL"] as const) {
  out.push(await one(sig, ["node", "-e", nodeScript], "node-with-handler"));
}

// Scenario C: bun child with its own handler.
const bunScript = `
  process.on('SIGINT', () => { console.log('got SIGINT'); process.exit(10); });
  process.on('SIGTERM', () => { console.log('got SIGTERM'); process.exit(11); });
  setInterval(() => {}, 1000);
`;
for (const sig of ["SIGINT", "SIGTERM", "SIGKILL"] as const) {
  out.push(await one(sig, ["bun", "-e", bunScript], "bun-with-handler"));
}

console.log(JSON.stringify(out, null, 2));
