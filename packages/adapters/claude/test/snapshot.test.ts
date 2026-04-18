/**
 * Snapshot test — locks the normalized event stream shape for one
 * canonical scripted turn against the Claude adapter.
 *
 * Regenerate with `UPDATE_SNAPSHOTS=1 bun test` at this package root.
 * The snapshot is stored under `test/snapshots/canonical-turn.json`; this
 * is the cross-vendor regression baseline Track 2.C pins so a projection
 * regression in `hooks.ts` trips loudly.
 *
 * Determinism notes:
 *   - We inject pinned ULID + clock factories so eventIds + timestamps are
 *     stable run-to-run.
 *   - The Claude adapter does not currently expose `newTurnId` /
 *     `newToolCallId` factories (the Codex adapter does). We strip those
 *     two volatile fields from the normalized snapshot rather than
 *     extending the adapter surface just for tests. The snapshot preserves
 *     every other projection detail, which is what the regression test
 *     actually guards.
 *
 * No real Claude SDK contact: the test uses the same driver-double pattern
 * as `test/contract.test.ts` and `test/unit/adapter.test.ts`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentEvent, AgentHandle, MonotonicClock } from "@shamu/adapters-base";
import type { EventId } from "@shamu/shared/ids";
import { runId as asRunId } from "@shamu/shared/ids";
import { describe, expect, it } from "vitest";
import {
  ClaudeAdapter,
  type ClaudeDriver,
  type ClaudeDriverFactory,
  type ClaudeRaw,
} from "../src/index.ts";

const SNAPSHOT_PATH = join(import.meta.dirname ?? __dirname, "snapshots", "canonical-turn.json");

function pinnedEventIdFactory(): () => EventId {
  // Deterministic 26-char Crockford base32 stream. Matches the Codex
  // snapshot's approach so regen workflow is identical.
  let n = 0;
  const base = "01BX5ZZKBKACTAV9WEVGEMMVR"; // 25 chars, valid Crockford
  return () => {
    n += 1;
    const suffix = n.toString(32).toUpperCase();
    return `${base}${suffix[suffix.length - 1] ?? "0"}` as EventId;
  };
}

function pinnedClock(): MonotonicClock {
  let n = 0;
  return () => ({ monotonic: ++n, wall: 1_700_000_000_000 + n });
}

/**
 * Canonical scripted Claude stream. Exercises the important projection
 * branches: session bind via system:init, assistant text (including a
 * thinking block for the `reasoning` kind), a tool_use + tool_result pair,
 * and a terminal result carrying usage + cost.
 */
const canonicalScript: ClaudeRaw[] = [
  { type: "system", subtype: "init", session_id: "sess-canonical" },
  {
    type: "assistant",
    message: {
      stop_reason: "end_turn",
      content: [{ type: "thinking", thinking: "Plan the reply." }],
    },
  },
  {
    type: "assistant",
    message: {
      stop_reason: "end_turn",
      content: [
        {
          type: "tool_use",
          id: "toolcall_read_readme",
          name: "Read",
          input: { file_path: "README.md" },
        },
      ],
    },
  },
  {
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolcall_read_readme",
          content: "README.md\nsrc",
        },
      ],
    },
  },
  {
    type: "assistant",
    message: {
      stop_reason: "end_turn",
      content: [{ type: "text", text: "Two entries in root." }],
    },
  },
  {
    type: "result",
    subtype: "success",
    duration_ms: 5,
    total_cost_usd: 0.0021,
    usage: {
      input_tokens: 30,
      output_tokens: 20,
      cache_read_input_tokens: 10,
      cache_creation_input_tokens: 0,
    },
  },
];

function makeDriver(script: ReadonlyArray<ClaudeRaw>): ClaudeDriver {
  return {
    session: null,
    async startQuery() {
      return {
        [Symbol.asyncIterator]: () => {
          let i = 0;
          return {
            next: async () => {
              if (i >= script.length)
                return { value: undefined as unknown as ClaudeRaw, done: true };
              const value = script[i] as ClaudeRaw;
              i += 1;
              return { value, done: false };
            },
          } as AsyncIterator<ClaudeRaw>;
        },
        interrupt: async () => {},
        setModel: async () => {},
        setPermissionMode: async () => {},
      };
    },
    async sendOnSession() {
      return {
        [Symbol.asyncIterator]: () => {
          let i = 0;
          return {
            next: async () => {
              if (i >= script.length)
                return { value: undefined as unknown as ClaudeRaw, done: true };
              const value = script[i] as ClaudeRaw;
              i += 1;
              return { value, done: false };
            },
          } as AsyncIterator<ClaudeRaw>;
        },
      };
    },
  };
}

/**
 * Strip the fields we can't pin deterministically (runId is a per-run
 * ULID; turnId + toolCallId are minted by shared default factories that
 * the Claude adapter doesn't currently expose hooks for). Everything else
 * stays — a projection regression in `hooks.ts` still shifts the snapshot.
 */
function stripVolatile(ev: AgentEvent): Record<string, unknown> {
  const copy = { ...ev } as Record<string, unknown>;
  copy.runId = "<PINNED-RUN-ID>";
  copy.turnId = "<PINNED-TURN-ID>";
  if ("toolCallId" in copy) copy.toolCallId = "<PINNED-TOOL-CALL-ID>";
  // `parentEventId` on tool_result points to the matching tool_call. We
  // mask the pointer (eventIds ARE pinned, so the reference is stable) to
  // keep the snapshot readable against the "<PINNED-*>" placeholders rather
  // than embedding a raw ULID in the fixture.
  if (typeof copy.parentEventId === "string") {
    copy.parentEventId = "<PINNED-PARENT-EVENT-ID>";
  }
  // The `session_start` event carries a freshly-minted shamu-local ULID
  // until `system:init` rebinds the vendor id; subsequent events carry the
  // vendor-supplied id from the script. Mask both so snapshot stays stable
  // without requiring a `newSessionId` factory override.
  if (typeof copy.sessionId === "string") {
    copy.sessionId = "<PINNED-SESSION-ID>";
  }
  return copy;
}

async function captureCanonicalStream(): Promise<AgentEvent[]> {
  const factory: ClaudeDriverFactory = async () => makeDriver(canonicalScript);
  const adapter = new ClaudeAdapter({
    clock: pinnedClock(),
    newEventId: pinnedEventIdFactory(),
    driverFactory: factory,
  });
  const handle: AgentHandle = await adapter.spawn({
    cwd: "/tmp",
    runId: asRunId("PINNED-RUN"),
  });
  try {
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
    return events;
  } finally {
    await handle.shutdown("snapshot-done");
  }
}

describe("Claude adapter: canonical-turn snapshot", () => {
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
    expect(kinds).toContain("session_start");
    expect(kinds).toContain("reasoning");
    expect(kinds).toContain("tool_call");
    expect(kinds).toContain("tool_result");
    expect(kinds).toContain("assistant_message");
    expect(kinds).toContain("usage");
    expect(kinds).toContain("cost");
    expect(kinds).toContain("turn_end");
  });
});
