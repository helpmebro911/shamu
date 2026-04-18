/**
 * Snapshot test — locks the normalized event stream shape for one
 * canonical scripted turn.
 *
 * Regenerate with `UPDATE_SNAPSHOTS=1 bun test` at this package root.
 * The snapshot is stored under `test/snapshots/canonical-turn.json` and
 * is the regression baseline Track 2.C will lean on for vendor-stream
 * comparisons.
 *
 * Determinism: we inject pinned ULID + clock factories into the adapter
 * so the event ids and timestamps are stable run-to-run.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ThreadEvent } from "@openai/codex-sdk";
import type { AgentEvent, AgentHandle, MonotonicClock } from "@shamu/adapters-base";
import type { EventId, ToolCallId, TurnId } from "@shamu/shared/ids";
import { runId as asRunId } from "@shamu/shared/ids";
import { describe, expect, it } from "vitest";
import { CodexAdapter, type CodexLike } from "../src/index.ts";
import { FakeCodex, FakeThread } from "./fake-thread.ts";

const SNAPSHOT_PATH = join(import.meta.dirname ?? __dirname, "snapshots", "canonical-turn.json");

function pinnedEventIdFactory(): () => EventId {
  let n = 0;
  // 26-char Crockford base32 string. We pad a counter up the low bits so
  // ids differ without requiring any randomness.
  const base = "01BX5ZZKBKACTAV9WEVGEMMVR"; // 25 chars, valid Crockford
  return () => {
    n += 1;
    const suffix = n.toString(32).toUpperCase().padStart(1, "0");
    // Replace the last char with the counter so ids stay distinct.
    return `${base}${suffix[suffix.length - 1] ?? "0"}` as EventId;
  };
}

function pinnedTurnIdFactory(): () => TurnId {
  let n = 0;
  return () => `turn_${String(++n).padStart(6, "0")}` as TurnId;
}

function pinnedToolCallIdFactory(): () => ToolCallId {
  // Real ToolCallIds are ULIDs. For snapshot stability we generate a
  // deterministic sequence that still passes the `.min(1)` schema rule.
  let n = 0;
  return () => `tc_${String(++n).padStart(6, "0")}` as ToolCallId;
}

function pinnedClock(): MonotonicClock {
  let n = 0;
  return () => ({ monotonic: ++n, wall: 1_700_000_000_000 + n });
}

const canonicalScript = (_input: string): ThreadEvent[] => [
  { type: "thread.started", thread_id: "thr_canonical_0001" },
  { type: "turn.started" },
  {
    type: "item.completed",
    item: { id: "r0", type: "reasoning", text: "Plan the reply." },
  },
  {
    type: "item.started",
    item: {
      id: "cmd_0",
      type: "command_execution",
      command: "ls",
      aggregated_output: "",
      status: "in_progress",
    },
  },
  {
    type: "item.completed",
    item: {
      id: "cmd_0",
      type: "command_execution",
      command: "ls",
      aggregated_output: "README.md\nsrc",
      exit_code: 0,
      status: "completed",
    },
  },
  {
    type: "item.completed",
    item: { id: "m0", type: "agent_message", text: "Two entries in root." },
  },
  {
    type: "turn.completed",
    usage: { input_tokens: 40, cached_input_tokens: 10, output_tokens: 20 },
  },
];

/** Strip fields whose exact value doesn't matter for regression. */
function stripVolatile(ev: AgentEvent): Record<string, unknown> {
  // We pin the clock + eventId factories, so timestamps and ids ARE stable
  // across runs; we keep them in the snapshot. The only thing that needs
  // trimming is `runId`, which the adapter receives from the caller and is
  // a fresh ULID each run.
  const copy = { ...ev } as Record<string, unknown>;
  copy.runId = "<PINNED-RUN-ID>";
  return copy;
}

async function captureCanonicalStream(): Promise<AgentEvent[]> {
  const adapter = new CodexAdapter({
    clock: pinnedClock(),
    newEventId: pinnedEventIdFactory(),
    newTurnId: pinnedTurnIdFactory(),
    newToolCallId: pinnedToolCallIdFactory(),
    codexFactory: (_sdkOpts): CodexLike =>
      new FakeCodex(() => new FakeThread({ scripts: [canonicalScript] })),
  });
  const handle: AgentHandle = await adapter.spawn({
    cwd: "/tmp",
    runId: asRunId("PINNED-RUN"),
    vendorCliPath: "/fake/codex",
  });
  await handle.send({ text: "canonical" });
  const events: AgentEvent[] = [];
  const iter = handle.events[Symbol.asyncIterator]();
  const budget = Date.now() + 2_000;
  while (Date.now() < budget) {
    const next = await iter.next();
    if (next.done) break;
    events.push(next.value);
    if (next.value.kind === "turn_end") break;
  }
  await handle.shutdown("snapshot-done");
  return events;
}

describe("Codex adapter: canonical-turn snapshot", () => {
  it("locks the normalized stream shape for one scripted turn", async () => {
    const events = await captureCanonicalStream();
    const normalized = events.map(stripVolatile);

    if (process.env.UPDATE_SNAPSHOTS === "1" || !existsSync(SNAPSHOT_PATH)) {
      mkdirSync(dirname(SNAPSHOT_PATH), { recursive: true });
      writeFileSync(SNAPSHOT_PATH, `${JSON.stringify(normalized, null, 2)}\n`);
    }
    const expected = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8"));
    expect(normalized).toEqual(expected);
  });

  it("covers the key projection cases: session_start, reasoning, tool_call+result, assistant_message, usage, cost, turn_end", async () => {
    const events = await captureCanonicalStream();
    const kinds = events.map((e) => e.kind);
    // turn.started is explicitly NOT in this list — confirms suppression.
    expect(kinds).toContain("session_start");
    expect(kinds).toContain("reasoning");
    expect(kinds).toContain("tool_call");
    expect(kinds).toContain("tool_result");
    expect(kinds).toContain("assistant_message");
    expect(kinds).toContain("usage");
    expect(kinds).toContain("cost");
    expect(kinds).toContain("turn_end");
    expect(kinds).not.toContain("turn_start");
  });
});
