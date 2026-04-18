import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "@shamu/shared/events";
import { newEventId, newRunId, newTurnId, runId } from "@shamu/shared/ids";
import { openDatabase, type ShamuDatabase } from "../db.ts";
import { getEventsByRun, getRawEvent, insertEvent, insertRawEvent, tailEvents } from "./events.ts";

describe("events queries", () => {
  let dir: string;
  let db: ShamuDatabase;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "shamu-events-"));
    db = openDatabase(join(dir, "db.sqlite"));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function makeEvent(seq: number, override?: Partial<AgentEvent>): AgentEvent {
    const runId = override?.runId ?? newRunId();
    const turnId = override?.turnId ?? newTurnId();
    return {
      eventId: newEventId(),
      runId,
      sessionId: null,
      turnId,
      parentEventId: null,
      seq,
      tsMonotonic: seq * 1000,
      tsWall: 1_700_000_000_000 + seq,
      vendor: "echo",
      rawRef: null,
      kind: "checkpoint",
      summary: `checkpoint-${seq}`,
      ...(override ?? {}),
    } as AgentEvent;
  }

  it("inserts + reads events by run", () => {
    const runId = newRunId();
    for (let i = 0; i < 3; i++) {
      insertEvent(db, makeEvent(i, { runId }));
    }
    const rows = getEventsByRun(db, runId);
    expect(rows).toHaveLength(3);
    expect(rows[0]?.kind).toBe("checkpoint");
    if (rows[0]?.kind === "checkpoint") {
      expect(rows[0].summary).toBe("checkpoint-0");
    }
  });

  it("is idempotent on event_id (replay-safe)", () => {
    const e = makeEvent(0);
    insertEvent(db, e);
    insertEvent(db, e);
    insertEvent(db, e);
    const rows = getEventsByRun(db, runId(e.runId));
    expect(rows).toHaveLength(1);
  });

  it("tails events from a sinceSeq", () => {
    const runId = newRunId();
    for (let i = 0; i < 5; i++) insertEvent(db, makeEvent(i, { runId }));
    const tail = tailEvents(db, 2, 10);
    expect(tail).toHaveLength(2); // seq 3, 4
    expect(tail[0]?.seq).toBe(3);
    expect(tail[1]?.seq).toBe(4);
  });

  it("round-trips a tool_call event payload", () => {
    const e = makeEvent(0, {
      kind: "tool_call",
      toolCallId: "tc1",
      tool: "Read",
      args: { path: "a.ts", offset: 0 },
    } as Partial<AgentEvent>);
    insertEvent(db, e);
    const [row] = getEventsByRun(db, runId(e.runId));
    expect(row?.kind).toBe("tool_call");
    if (row?.kind === "tool_call") {
      expect(row.tool).toBe("Read");
      expect(row.args).toEqual({ path: "a.ts", offset: 0 });
    }
  });

  it("round-trips a raw event", () => {
    const id = newEventId();
    const runId = newRunId();
    insertRawEvent(db, { eventId: id, runId, vendor: "claude", ts: 1, payload: { foo: "bar" } });
    const row = getRawEvent(db, id);
    expect(row?.payload).toEqual({ foo: "bar" });
    expect(row?.vendor).toBe("claude");
  });
});
