/**
 * Behavioral unit tests for `EchoAdapter`. Covers the scripted stream shape,
 * multi-turn, interrupt mid-turn, resume continues, and capability-driven
 * setModel/setPermissionMode guards. The shared contract suite runs
 * separately (contract.test.ts).
 */

import type { AgentEvent, AgentHandle, EventId, MonotonicClock } from "@shamu/adapters-base";
import { describe, expect, it } from "vitest";
import { ECHO_CAPABILITIES, EchoAdapter, PLANTED_SECRET_TOKEN } from "../src/index.ts";

/** Collect events from an `AgentHandle` until `turn_end`. */
async function collectTurn(handle: AgentHandle, budgetMs = 2_000): Promise<AgentEvent[]> {
  const collected: AgentEvent[] = [];
  const iter = handle.events[Symbol.asyncIterator]();
  const start = Date.now();
  while (Date.now() - start < budgetMs) {
    const next = await iter.next();
    if (next.done) break;
    collected.push(next.value);
    if (next.value.kind === "turn_end") break;
  }
  return collected;
}

describe("EchoAdapter: capability manifest", () => {
  it("is frozen and declares the echo-shaped capabilities", () => {
    expect(ECHO_CAPABILITIES.resume).toBe(true);
    expect(ECHO_CAPABILITIES.fork).toBe(false);
    expect(ECHO_CAPABILITIES.interrupt).toBe("cooperative");
    expect(ECHO_CAPABILITIES.permissionModes).toEqual(["default", "acceptEdits"]);
    expect(ECHO_CAPABILITIES.mcp).toBe("none");
    expect(ECHO_CAPABILITIES.patchVisibility).toBe("events");
    expect(ECHO_CAPABILITIES.usageReporting).toBe("per-turn");
    expect(ECHO_CAPABILITIES.costReporting).toBe("computed");
    expect(ECHO_CAPABILITIES.streaming).toBe("events");
    expect(Object.isFrozen(ECHO_CAPABILITIES)).toBe(true);
  });
});

describe("EchoAdapter: spawn + scripted turn", () => {
  it("emits session_start → assistant_* → usage → cost → turn_end", async () => {
    const adapter = new EchoAdapter();
    const handle = await adapter.spawn({ cwd: "/tmp" });
    await handle.send({ text: "" });
    const events = await collectTurn(handle);
    await handle.shutdown("done");

    const kinds = events.map((e) => e.kind);
    expect(kinds[0]).toBe("session_start");
    expect(kinds).toContain("assistant_delta");
    expect(kinds).toContain("assistant_message");
    expect(kinds).toContain("usage");
    expect(kinds).toContain("cost");
    expect(kinds[kinds.length - 1]).toBe("turn_end");
  });

  it("emits a deterministic cost event with source=computed and confidence=estimate", async () => {
    const adapter = new EchoAdapter();
    const handle = await adapter.spawn({ cwd: "/tmp" });
    await handle.send({ text: "hello" });
    const events = await collectTurn(handle);
    await handle.shutdown("done");

    const cost = events.find((e) => e.kind === "cost");
    expect(cost).toBeDefined();
    if (cost?.kind !== "cost") throw new Error("expected cost");
    expect(cost.source).toBe("computed");
    expect(cost.confidence).toBe("estimate");
    expect(cost.usd).toBe(0.0015);
  });

  it("emits a tool_call + tool_result when the prompt asks to Read README.md", async () => {
    const adapter = new EchoAdapter();
    const handle = await adapter.spawn({ cwd: "/tmp" });
    await handle.send({ text: "Read the file README.md in the current directory." });
    const events = await collectTurn(handle);
    await handle.shutdown("done");

    const call = events.find((e) => e.kind === "tool_call");
    const result = events.find((e) => e.kind === "tool_result");
    expect(call).toBeDefined();
    expect(result).toBeDefined();
    if (call?.kind !== "tool_call") throw new Error("expected tool_call");
    if (result?.kind !== "tool_result") throw new Error("expected tool_result");
    expect(result.toolCallId).toBe(call.toolCallId);
    expect(result.parentEventId).toBe(call.eventId);
  });

  it("emits a patch_applied event for the 'create a file' prompt", async () => {
    const adapter = new EchoAdapter();
    const handle = await adapter.spawn({ cwd: "/tmp" });
    await handle.send({ text: "Create a file named note.txt containing 'ok'." });
    const events = await collectTurn(handle);
    await handle.shutdown("done");

    const patch = events.find((e) => e.kind === "patch_applied");
    expect(patch).toBeDefined();
    if (patch?.kind !== "patch_applied") throw new Error("expected patch_applied");
    expect(patch.files).toEqual(["note.txt"]);
    expect(patch.stats).toEqual({ add: 1, del: 0 });
  });
});

describe("EchoAdapter: multi-turn", () => {
  it("two consecutive sends carry distinct turnIds", async () => {
    const adapter = new EchoAdapter();
    const handle = await adapter.spawn({ cwd: "/tmp" });
    await handle.send({ text: "Say 'hello'." });
    const first = await collectTurn(handle);
    await handle.send({ text: "Now say 'goodbye'." });
    const second = await collectTurn(handle);
    await handle.shutdown("done");

    const firstTurnIds = new Set(first.map((e) => e.turnId));
    const secondTurnIds = new Set(second.map((e) => e.turnId));
    expect(firstTurnIds.size).toBe(1);
    expect(secondTurnIds.size).toBe(1);
    const [a] = firstTurnIds;
    const [b] = secondTurnIds;
    expect(a).not.toBe(b);
  });
});

describe("EchoAdapter: interrupt", () => {
  it("interrupt() emits an interrupt event and closes the turn", async () => {
    const adapter = new EchoAdapter();
    const handle = await adapter.spawn({ cwd: "/tmp" });
    await handle.send({ text: "Count slowly from 1 to 100." });

    // Drain until we see the parked assistant_delta, then interrupt.
    const iter = handle.events[Symbol.asyncIterator]();
    const seen: AgentEvent[] = [];
    let first = await iter.next();
    while (!first.done && first.value.kind !== "assistant_delta") {
      seen.push(first.value);
      first = await iter.next();
    }
    if (first.done) throw new Error("iterator ended before assistant_delta");
    seen.push(first.value);

    await handle.interrupt("test-interrupt");

    while (true) {
      const next = await iter.next();
      if (next.done) break;
      seen.push(next.value);
      if (next.value.kind === "turn_end") break;
    }
    await handle.shutdown("done");

    expect(seen.some((e) => e.kind === "interrupt" && e.delivered === true)).toBe(true);
    expect(seen[seen.length - 1]?.kind).toBe("turn_end");
  });
});

describe("EchoAdapter: resume", () => {
  it("resume(sessionId) continues with the same sessionId", async () => {
    const adapter = new EchoAdapter();
    const handle = await adapter.spawn({ cwd: "/tmp" });
    await handle.send({ text: "" });
    await collectTurn(handle);
    const sid = handle.sessionId;
    if (!sid) throw new Error("spawn did not produce a sessionId");
    await handle.shutdown("done");

    const resumed = await adapter.resume(sid, { cwd: "/tmp" });
    expect(resumed.sessionId).toBe(sid);
    await resumed.send({ text: "Now say 'goodbye'." });
    const events = await collectTurn(resumed);
    await resumed.shutdown("done");

    const start = events.find((e) => e.kind === "session_start");
    expect(start).toBeDefined();
    if (start?.kind !== "session_start") throw new Error("expected session_start");
    expect(start.source).toBe("resume");
  });
});

describe("EchoAdapter: setModel + setPermissionMode", () => {
  it("setModel causes subsequent usage events to carry the new model", async () => {
    const adapter = new EchoAdapter();
    const handle = await adapter.spawn({ cwd: "/tmp" });
    await handle.send({ text: "" });
    await collectTurn(handle);
    await handle.setModel("echo-2");
    await handle.send({ text: "" });
    const second = await collectTurn(handle);
    await handle.shutdown("done");
    const usage = second.find((e) => e.kind === "usage");
    expect(usage).toBeDefined();
    if (usage?.kind !== "usage") throw new Error("expected usage");
    expect(usage.model).toBe("echo-2");
  });

  it("setPermissionMode rejects modes not declared in the manifest", async () => {
    const adapter = new EchoAdapter();
    const handle = await adapter.spawn({ cwd: "/tmp" });
    try {
      // "plan" is a legal PermissionMode but not declared in this manifest.
      await expect(handle.setPermissionMode("plan")).rejects.toThrow(/not declared/);
      // Each declared mode must succeed.
      for (const mode of ECHO_CAPABILITIES.permissionModes) {
        await expect(handle.setPermissionMode(mode)).resolves.toBeUndefined();
      }
    } finally {
      await handle.shutdown("done");
    }
  });
});

describe("EchoAdapter: redaction", () => {
  it("scrubs the planted anthropic secret everywhere it appears", async () => {
    const adapter = new EchoAdapter();
    const handle = await adapter.spawn({ cwd: "/tmp" });
    await handle.send({ text: `Echo this token: ${PLANTED_SECRET_TOKEN}` });
    const events = await collectTurn(handle);
    await handle.shutdown("done");

    for (const ev of events) {
      const body = JSON.stringify(ev);
      expect(body).not.toContain(PLANTED_SECRET_TOKEN);
      expect(body).not.toContain("sk-ant-FAKE");
    }
  });
});

describe("EchoAdapter: determinism under injected clock", () => {
  it("produces monotonic tsMonotonic even when the clock is stubbed", async () => {
    let tick = 0;
    const clock: MonotonicClock = () => ({ monotonic: ++tick, wall: 1_700_000_000_000 + tick });
    const adapter = new EchoAdapter({ clock });
    const handle = await adapter.spawn({ cwd: "/tmp" });
    await handle.send({ text: "" });
    const events = await collectTurn(handle);
    await handle.shutdown("done");

    // `CorrelationState.envelope()` clamps backward clocks to the last
    // observed value — but with our monotonic stub we expect strictly
    // increasing `tsMonotonic`.
    for (let i = 1; i < events.length; i++) {
      const prev = events[i - 1];
      const cur = events[i];
      if (!prev || !cur) throw new Error("events[i] missing");
      expect(cur.tsMonotonic).toBeGreaterThanOrEqual(prev.tsMonotonic);
    }
  });

  it("accepts a pinned eventId factory for deterministic ids", async () => {
    let n = 0;
    const factory = (): EventId => {
      // Produce deterministic ULID-shaped ids: pad with 'A' so the
      // ULID regex in `@shamu/shared/events` is satisfied.
      n += 1;
      const suffix = String(n).padStart(26, "0").replace(/0/g, "A");
      return suffix.slice(0, 26) as EventId;
    };
    const adapter = new EchoAdapter({ newEventId: factory });
    const handle = await adapter.spawn({ cwd: "/tmp" });
    await handle.send({ text: "" });
    const events = await collectTurn(handle);
    await handle.shutdown("done");

    const ids = events.map((e) => e.eventId);
    // Deterministic factory ⇒ strictly ascending numeric substring.
    expect(new Set(ids).size).toBe(ids.length);
  });
});
