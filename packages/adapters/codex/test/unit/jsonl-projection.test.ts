/**
 * JSONL projection unit tests.
 *
 * Each Codex JSONL event kind → expected normalized event(s). The
 * projector is pure w.r.t. SDK instances, so these tests construct a
 * `CorrelationState` directly and feed it events from fixture literals.
 *
 * Key invariants under test:
 * - `turn.started` produces ZERO top-level events (PLAN.md § 1).
 * - `item.completed:agent_message` → `assistant_message` with stopReason.
 * - `item.started:command_execution` → `tool_call`; the matching
 *   `item.completed` → `tool_result` with parentEventId linkage.
 * - `item.completed:file_change` with ok=completed → `tool_result` +
 *   `patch_applied` (two events from one vendor event).
 * - `turn.completed` → `usage` + `cost` + `turn_end` (three events).
 * - `thread.started` emits exactly one `session_start` with source=spawn.
 * - Reasoning items surface as the `reasoning` kind (post-Phase 0.B).
 */

import { CorrelationState, validateEvent } from "@shamu/adapters-base";
import { newRunId } from "@shamu/shared/ids";
import { describe, expect, it } from "vitest";
import {
  createProjectionState,
  projectCodexEvent,
  toolNameForItem,
} from "../../src/jsonl-projection.ts";

function makeCorr() {
  return new CorrelationState({
    runId: newRunId(),
    sessionId: null,
    vendor: "codex",
  });
}

describe("projectCodexEvent: thread.started", () => {
  it("emits exactly one session_start with source=spawn", () => {
    const corr = makeCorr();
    const state = createProjectionState();
    const events = projectCodexEvent({ type: "thread.started", thread_id: "thr_xyz" }, corr, state);
    expect(events.length).toBe(1);
    const ev = events[0];
    expect(ev?.kind).toBe("session_start");
    if (ev?.kind !== "session_start") throw new Error("expected session_start");
    expect(ev.source).toBe("spawn");
    expect(state.threadId).toBe("thr_xyz");
    // Schema validation passes without a normalization step.
    expect(() => validateEvent(ev)).not.toThrow();
  });

  it("second thread.started does NOT emit another session_start", () => {
    const corr = makeCorr();
    const state = createProjectionState();
    projectCodexEvent({ type: "thread.started", thread_id: "thr_xyz" }, corr, state);
    const events = projectCodexEvent({ type: "thread.started", thread_id: "thr_xyz" }, corr, state);
    expect(events.length).toBe(0);
  });
});

describe("projectCodexEvent: turn.started", () => {
  it("suppresses turn.started — no top-level event is emitted", () => {
    const corr = makeCorr();
    const state = createProjectionState();
    // Need an open thread/turn context first.
    projectCodexEvent({ type: "thread.started", thread_id: "thr_1" }, corr, state);
    const events = projectCodexEvent({ type: "turn.started" }, corr, state);
    expect(events).toEqual([]);
    expect(state.turnOpen).toBe(true);
  });
});

describe("projectCodexEvent: item.completed agent_message", () => {
  it("emits assistant_message with the item text + stopReason=end_turn", () => {
    const corr = makeCorr();
    const state = createProjectionState();
    projectCodexEvent({ type: "thread.started", thread_id: "thr_1" }, corr, state);
    projectCodexEvent({ type: "turn.started" }, corr, state);
    const events = projectCodexEvent(
      {
        type: "item.completed",
        item: { id: "i1", type: "agent_message", text: "hello world" },
      },
      corr,
      state,
    );
    expect(events.length).toBe(1);
    const ev = events[0];
    if (ev?.kind !== "assistant_message") throw new Error("expected assistant_message");
    expect(ev.text).toBe("hello world");
    expect(ev.stopReason).toBe("end_turn");
    expect(() => validateEvent(ev)).not.toThrow();
  });
});

describe("projectCodexEvent: command_execution pairing", () => {
  it("started → tool_call; completed → tool_result with parentEventId linkage", () => {
    const corr = makeCorr();
    const state = createProjectionState();
    projectCodexEvent({ type: "thread.started", thread_id: "thr_1" }, corr, state);
    projectCodexEvent({ type: "turn.started" }, corr, state);

    const call = projectCodexEvent(
      {
        type: "item.started",
        item: {
          id: "cmd_1",
          type: "command_execution",
          command: "ls -la",
          aggregated_output: "",
          status: "in_progress",
        },
      },
      corr,
      state,
    );
    expect(call.length).toBe(1);
    const callEv = call[0];
    if (callEv?.kind !== "tool_call") throw new Error("expected tool_call");
    expect(callEv.tool).toBe("shell");
    expect((callEv.args as { command: string }).command).toBe("ls -la");

    const result = projectCodexEvent(
      {
        type: "item.completed",
        item: {
          id: "cmd_1",
          type: "command_execution",
          command: "ls -la",
          aggregated_output: "README.md\nsrc\n",
          exit_code: 0,
          status: "completed",
        },
      },
      corr,
      state,
    );
    expect(result.length).toBe(1);
    const resultEv = result[0];
    if (resultEv?.kind !== "tool_result") throw new Error("expected tool_result");
    expect(resultEv.toolCallId).toBe(callEv.toolCallId);
    expect(resultEv.parentEventId).toBe(callEv.eventId);
    expect(resultEv.ok).toBe(true);
    expect(resultEv.summary).toContain("README.md");
  });

  it("failed command_execution surfaces ok=false on tool_result", () => {
    const corr = makeCorr();
    const state = createProjectionState();
    projectCodexEvent({ type: "thread.started", thread_id: "thr_1" }, corr, state);
    projectCodexEvent({ type: "turn.started" }, corr, state);
    projectCodexEvent(
      {
        type: "item.started",
        item: {
          id: "cmd_f",
          type: "command_execution",
          command: "false",
          aggregated_output: "",
          status: "in_progress",
        },
      },
      corr,
      state,
    );
    const result = projectCodexEvent(
      {
        type: "item.completed",
        item: {
          id: "cmd_f",
          type: "command_execution",
          command: "false",
          aggregated_output: "",
          exit_code: 1,
          status: "failed",
        },
      },
      corr,
      state,
    );
    const resultEv = result[0];
    if (resultEv?.kind !== "tool_result") throw new Error("expected tool_result");
    expect(resultEv.ok).toBe(false);
  });
});

describe("projectCodexEvent: file_change", () => {
  it("completed success → tool_result + patch_applied (two events)", () => {
    const corr = makeCorr();
    const state = createProjectionState();
    projectCodexEvent({ type: "thread.started", thread_id: "thr_1" }, corr, state);
    projectCodexEvent({ type: "turn.started" }, corr, state);
    const events = projectCodexEvent(
      {
        type: "item.completed",
        item: {
          id: "fc_1",
          type: "file_change",
          changes: [
            { path: "src/a.ts", kind: "add" },
            { path: "src/b.ts", kind: "update" },
          ],
          status: "completed",
        },
      },
      corr,
      state,
    );
    expect(events.length).toBe(2);
    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual(["tool_result", "patch_applied"]);
    const patch = events[1];
    if (patch?.kind !== "patch_applied") throw new Error("expected patch_applied");
    expect(patch.files).toEqual(["src/a.ts", "src/b.ts"]);
    // Line stats are 0/0 until we can derive them from the worktree diff.
    expect(typeof patch.stats.add).toBe("number");
    expect(typeof patch.stats.del).toBe("number");
  });

  it("failed file_change → tool_result only, no patch_applied", () => {
    const corr = makeCorr();
    const state = createProjectionState();
    projectCodexEvent({ type: "thread.started", thread_id: "thr_1" }, corr, state);
    projectCodexEvent({ type: "turn.started" }, corr, state);
    const events = projectCodexEvent(
      {
        type: "item.completed",
        item: {
          id: "fc_1",
          type: "file_change",
          changes: [{ path: "src/a.ts", kind: "add" }],
          status: "failed",
        },
      },
      corr,
      state,
    );
    expect(events.length).toBe(1);
    expect(events[0]?.kind).toBe("tool_result");
  });
});

describe("projectCodexEvent: turn.completed", () => {
  it("emits usage + cost + turn_end (three events in order)", () => {
    const corr = makeCorr();
    const state = createProjectionState();
    projectCodexEvent({ type: "thread.started", thread_id: "thr_1" }, corr, state);
    projectCodexEvent({ type: "turn.started" }, corr, state);
    const events = projectCodexEvent(
      {
        type: "turn.completed",
        usage: {
          input_tokens: 100,
          cached_input_tokens: 30,
          output_tokens: 50,
        },
      },
      corr,
      state,
    );
    expect(events.length).toBe(3);
    expect(events.map((e) => e.kind)).toEqual(["usage", "cost", "turn_end"]);

    const usage = events[0];
    if (usage?.kind !== "usage") throw new Error("expected usage");
    expect(usage.tokens.input).toBe(100);
    expect(usage.tokens.output).toBe(50);
    expect(usage.tokens.cacheRead).toBe(30);
    expect(usage.cache.hits).toBe(30);
    expect(usage.cache.misses).toBe(70);

    const cost = events[1];
    if (cost?.kind !== "cost") throw new Error("expected cost");
    expect(cost.usd).toBeNull();
    expect(cost.confidence).toBe("unknown");
    expect(cost.source).toBe("subscription");

    const end = events[2];
    if (end?.kind !== "turn_end") throw new Error("expected turn_end");
    expect(end.stopReason).toBe("completed");

    // After turn.completed, turnOpen is false and next event needs a new
    // turn to hang off of.
    expect(state.turnOpen).toBe(false);
  });
});

describe("projectCodexEvent: turn.failed", () => {
  it("emits error + turn_end with fatal=true", () => {
    const corr = makeCorr();
    const state = createProjectionState();
    projectCodexEvent({ type: "thread.started", thread_id: "thr_1" }, corr, state);
    projectCodexEvent({ type: "turn.started" }, corr, state);
    const events = projectCodexEvent(
      { type: "turn.failed", error: { message: "rate-limit exceeded" } },
      corr,
      state,
    );
    const err = events[0];
    if (err?.kind !== "error") throw new Error("expected error");
    expect(err.fatal).toBe(true);
    expect(err.message).toBe("rate-limit exceeded");
    expect(err.errorCode).toBe("turn_failed");
    expect(err.retriable).toBe(false);
    expect(events[1]?.kind).toBe("turn_end");
  });
});

describe("projectCodexEvent: reasoning", () => {
  it("emits reasoning on item.completed", () => {
    const corr = makeCorr();
    const state = createProjectionState();
    projectCodexEvent({ type: "thread.started", thread_id: "thr_1" }, corr, state);
    projectCodexEvent({ type: "turn.started" }, corr, state);
    const events = projectCodexEvent(
      {
        type: "item.completed",
        item: { id: "r1", type: "reasoning", text: "Planning the change." },
      },
      corr,
      state,
    );
    expect(events.length).toBe(1);
    const r = events[0];
    if (r?.kind !== "reasoning") throw new Error("expected reasoning");
    expect(r.text).toBe("Planning the change.");
  });
});

describe("projectCodexEvent: error (thread-level)", () => {
  it("emits a fatal error event", () => {
    const corr = makeCorr();
    const state = createProjectionState();
    projectCodexEvent({ type: "thread.started", thread_id: "thr_1" }, corr, state);
    projectCodexEvent({ type: "turn.started" }, corr, state);
    const events = projectCodexEvent(
      { type: "error", message: "stream closed unexpectedly" },
      corr,
      state,
    );
    const err = events[0];
    if (err?.kind !== "error") throw new Error("expected error");
    expect(err.fatal).toBe(true);
    expect(err.errorCode).toBe("stream_error");
  });
});

describe("projectCodexEvent: correlation ids thread through", () => {
  it("all projected events in a turn share the same turnId", () => {
    const corr = makeCorr();
    const state = createProjectionState();
    const out: string[] = [];
    const push = (evs: { turnId: string }[]) => {
      for (const e of evs) out.push(e.turnId);
    };
    push(projectCodexEvent({ type: "thread.started", thread_id: "thr_1" }, corr, state));
    push(projectCodexEvent({ type: "turn.started" }, corr, state));
    push(
      projectCodexEvent(
        {
          type: "item.completed",
          item: { id: "i0", type: "agent_message", text: "x" },
        },
        corr,
        state,
      ),
    );
    push(
      projectCodexEvent(
        {
          type: "turn.completed",
          usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
        },
        corr,
        state,
      ),
    );
    expect(new Set(out).size).toBe(1);
  });

  it("second turn gets a fresh turnId", () => {
    const corr = makeCorr();
    const state = createProjectionState();
    const turnIds = new Set<string>();
    for (const ev of projectCodexEvent({ type: "thread.started", thread_id: "thr_1" }, corr, state))
      turnIds.add(ev.turnId);
    for (const ev of projectCodexEvent({ type: "turn.started" }, corr, state))
      turnIds.add(ev.turnId);
    for (const ev of projectCodexEvent(
      {
        type: "turn.completed",
        usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
      },
      corr,
      state,
    ))
      turnIds.add(ev.turnId);

    const firstTurnIds = new Set(turnIds);
    turnIds.clear();

    for (const ev of projectCodexEvent({ type: "turn.started" }, corr, state))
      turnIds.add(ev.turnId);
    for (const ev of projectCodexEvent(
      {
        type: "item.completed",
        item: { id: "i1", type: "agent_message", text: "hi" },
      },
      corr,
      state,
    ))
      turnIds.add(ev.turnId);
    for (const ev of projectCodexEvent(
      {
        type: "turn.completed",
        usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
      },
      corr,
      state,
    ))
      turnIds.add(ev.turnId);

    const secondTurnIds = new Set(turnIds);

    // Disjoint.
    const intersection = [...firstTurnIds].filter((id) => secondTurnIds.has(id));
    expect(intersection).toEqual([]);
  });
});

describe("toolNameForItem", () => {
  it("maps each ThreadItem kind to its adapter tool name", () => {
    // Exercises the switch so adding a new ThreadItem kind trips the
    // `exhaustive: never` guard.
    const cases: Array<{ item: Parameters<typeof toolNameForItem>[0]; expected: string }> = [
      {
        item: {
          id: "c",
          type: "command_execution",
          command: "",
          aggregated_output: "",
          status: "completed",
        },
        expected: "shell",
      },
      {
        item: {
          id: "f",
          type: "file_change",
          changes: [],
          status: "completed",
        },
        expected: "apply_patch",
      },
      {
        item: {
          id: "m",
          type: "mcp_tool_call",
          server: "s",
          tool: "t",
          arguments: {},
          status: "completed",
        },
        expected: "mcp:s.t",
      },
      {
        item: { id: "w", type: "web_search", query: "q" },
        expected: "web_search",
      },
      { item: { id: "t", type: "todo_list", items: [] }, expected: "todo_list" },
      { item: { id: "a", type: "agent_message", text: "" }, expected: "agent_message" },
      { item: { id: "r", type: "reasoning", text: "" }, expected: "reasoning" },
      { item: { id: "e", type: "error", message: "" }, expected: "error" },
    ];
    for (const { item, expected } of cases) {
      expect(toolNameForItem(item)).toBe(expected);
    }
  });
});
