import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newEventId, newRunId, newTurnId } from "@shamu/shared/ids";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentEvent } from "../src/events.ts";
import {
  jsonlLinesFromPath,
  MemoryReplaySink,
  ReplayValidationError,
  recordAdapter,
  replayFromJsonl,
  safeReplayFromJsonl,
} from "../src/replay.ts";

function mkEvent(overrides: Partial<AgentEvent> = {}): AgentEvent {
  return {
    eventId: newEventId(),
    runId: newRunId(),
    sessionId: null,
    turnId: newTurnId(),
    parentEventId: null,
    seq: 1,
    tsMonotonic: 1,
    tsWall: 1_700_000_000_000,
    vendor: "fake",
    rawRef: null,
    kind: "session_start",
    source: "spawn",
    ...overrides,
  } as AgentEvent;
}

describe("replayFromJsonl", () => {
  it("parses a valid JSONL stream", async () => {
    const events: AgentEvent[] = [
      mkEvent({ seq: 1 }),
      mkEvent({
        seq: 2,
        kind: "turn_end",
        stopReason: "end",
        durationMs: 10,
      } as Partial<AgentEvent>),
    ];
    const source = toLineSource(events.map((e) => JSON.stringify(e)));
    const out: AgentEvent[] = [];
    for await (const ev of replayFromJsonl(source)) out.push(ev);
    expect(out).toHaveLength(2);
    expect(out[0]?.kind).toBe("session_start");
    expect(out[1]?.kind).toBe("turn_end");
  });

  it("throws ReplayValidationError on bad JSON", async () => {
    const source = toLineSource(["{ not valid }"]);
    const consume = async () => {
      for await (const _ of replayFromJsonl(source)) {
        // noop
      }
    };
    await expect(consume()).rejects.toBeInstanceOf(ReplayValidationError);
  });

  it("throws ReplayValidationError on invalid event shape", async () => {
    const source = toLineSource([JSON.stringify({ bogus: true })]);
    const consume = async () => {
      for await (const _ of replayFromJsonl(source)) {
        // noop
      }
    };
    await expect(consume()).rejects.toBeInstanceOf(ReplayValidationError);
  });

  it("skips blank lines", async () => {
    const ev = mkEvent();
    const source = toLineSource(["", "  ", JSON.stringify(ev), ""]);
    const out: AgentEvent[] = [];
    for await (const x of replayFromJsonl(source)) out.push(x);
    expect(out).toHaveLength(1);
  });
});

describe("safeReplayFromJsonl", () => {
  it("collects both valid events and errors without throwing", async () => {
    const good = mkEvent();
    const source = toLineSource([JSON.stringify(good), "garbage", JSON.stringify({ nope: true })]);
    const result = await safeReplayFromJsonl(source);
    expect(result.events).toHaveLength(1);
    expect(result.errors).toHaveLength(2);
  });
});

describe("recordAdapter + MemoryReplaySink", () => {
  it("writes every event to the sink and re-yields", async () => {
    const events: AgentEvent[] = [
      mkEvent({ seq: 1 }),
      mkEvent({
        seq: 2,
        kind: "turn_end",
        stopReason: "end",
        durationMs: 10,
      } as Partial<AgentEvent>),
    ];
    const handle = { events: toAsync(events) };
    const sink = new MemoryReplaySink();
    const out: AgentEvent[] = [];
    for await (const ev of recordAdapter(handle, sink)) out.push(ev);
    expect(out).toHaveLength(2);
    expect(sink.lines).toHaveLength(2);
    const replayed = await sink.replay();
    expect(replayed.map((e) => e.kind)).toEqual(["session_start", "turn_end"]);
  });

  it("propagates sink.write rejections", async () => {
    const events: AgentEvent[] = [mkEvent()];
    const handle = { events: toAsync(events) };
    const sink = {
      write: async () => {
        throw new Error("sink full");
      },
    };
    const consume = async () => {
      for await (const _ of recordAdapter(handle, sink)) {
        // noop
      }
    };
    await expect(consume()).rejects.toThrow("sink full");
  });
});

describe("jsonlLinesFromPath", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "shamu-jsonl-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("reads the file line by line", async () => {
    const path = join(tmp, "a.jsonl");
    writeFileSync(path, "one\ntwo\nthree\n");
    const out: string[] = [];
    for await (const line of jsonlLinesFromPath(path)) out.push(line);
    expect(out).toEqual(["one", "two", "three"]);
  });

  it("yields a trailing partial line (no newline)", async () => {
    const path = join(tmp, "a.jsonl");
    writeFileSync(path, "one\ntwo-no-newline");
    const out: string[] = [];
    for await (const line of jsonlLinesFromPath(path)) out.push(line);
    expect(out).toEqual(["one", "two-no-newline"]);
  });
});

async function* toLineSource(lines: string[]): AsyncIterable<string> {
  for (const line of lines) yield line;
}

async function* toAsync<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) yield item;
}
