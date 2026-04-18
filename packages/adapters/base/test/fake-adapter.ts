/**
 * FakeAdapter — the minimal implementation of `AgentAdapter` that lets the
 * contract suite exercise every required row. Lives in `test/` (not `src/`)
 * because it's a testing double; the pure-in-memory echo adapter is 1.E,
 * not this.
 *
 * Design:
 * - Events are emitted via a `queueMicrotask`-driven generator so the
 *   scenario's `for await` sees them in a realistic interleave. No actual
 *   subprocess.
 * - `send()` scripts the event stream based on the prompt text. "Say 'hello'"
 *   produces a vanilla session/assistant/turn sequence; the tool-call prompt
 *   inserts a matching tool_call/tool_result pair; interrupt turns stay open
 *   until `interrupt()` fires; the planted-secret turn runs the secret
 *   through a redactor before emission.
 * - `shutdown()` resolves the events iterable. `kill` / orphan checks are
 *   not relevant because nothing is spawned.
 */

import {
  type EventId,
  newRunId,
  newSessionId,
  newToolCallId,
  type RunId,
  type SessionId,
  type ToolCallId,
} from "@shamu/shared/ids";
import { Redactor } from "@shamu/shared/redactor";
import { PLANTED_SECRET } from "../src/contract/fixtures.ts";
import {
  type AgentAdapter,
  type AgentEvent,
  type AgentHandle,
  type Capabilities,
  CorrelationState,
  freezeCapabilities,
  type HandleHeartbeat,
  type PermissionMode,
  type SpawnOpts,
  type UserTurn,
} from "../src/index.ts";

export const FAKE_CAPABILITIES: Capabilities = freezeCapabilities({
  resume: true,
  fork: false,
  interrupt: "cooperative",
  permissionModes: ["default", "acceptEdits"],
  mcp: "none",
  customTools: false,
  patchVisibility: "events",
  usageReporting: "per-turn",
  costReporting: "native",
  sandboxing: "process",
  streaming: "events",
});

interface QueueItem {
  kind: "event" | "close";
  event?: AgentEvent;
}

class EventQueue {
  private readonly waiters: Array<(value: IteratorResult<AgentEvent>) => void> = [];
  private readonly pending: QueueItem[] = [];
  private closed = false;

  push(ev: AgentEvent): void {
    if (this.waiters.length > 0) {
      const w = this.waiters.shift();
      if (w) {
        w({ value: ev, done: false });
        return;
      }
    }
    this.pending.push({ kind: "event", event: ev });
  }

  close(): void {
    this.closed = true;
    while (this.waiters.length > 0) {
      const w = this.waiters.shift();
      if (w) w({ value: undefined, done: true });
    }
    this.pending.push({ kind: "close" });
  }

  async *iterate(): AsyncIterableIterator<AgentEvent> {
    while (true) {
      if (this.pending.length > 0) {
        const next = this.pending.shift();
        if (!next) continue;
        if (next.kind === "close") return;
        if (next.event) yield next.event;
        continue;
      }
      if (this.closed) return;
      const ev = await new Promise<IteratorResult<AgentEvent>>((resolve) => {
        this.waiters.push(resolve);
      });
      if (ev.done) return;
      yield ev.value;
    }
  }
}

class FakeHandle implements AgentHandle {
  public readonly runId: RunId;
  private _sessionId: SessionId | null;
  private readonly queue = new EventQueue();
  private readonly corr: CorrelationState;
  private lastEventAt = Date.now();
  private currentModel: string;
  private interrupted = false;
  private closed = false;
  private readonly redactor: Redactor;

  constructor(sessionId: SessionId | null, vendor: string, opts: SpawnOpts) {
    this.runId = newRunId();
    this._sessionId = sessionId;
    this.currentModel = opts.model ?? "fake-default-model";
    this.corr = new CorrelationState({
      runId: this.runId,
      sessionId,
      vendor,
    });
    this.redactor = new Redactor();
    // `session_start` is emitted by the FIRST send() — not here — so it
    // lives inside a turn (every event carries a turnId; emitting a
    // session_start with no active turn requires its own startTurn, which
    // then doesn't match the subsequent assistant_* events' turn). A real
    // vendor adapter would do the same: session_start rides inside the
    // first turn's envelope sequence.
    this.sessionSource = sessionId ? "resume" : "spawn";
  }

  private readonly sessionSource: "spawn" | "resume" | "fork";
  private sessionStartEmitted = false;

  get sessionId(): SessionId | null {
    return this._sessionId;
  }
  get events(): AsyncIterable<AgentEvent> {
    return this.queue.iterate();
  }

  private emit(event: AgentEvent): void {
    this.lastEventAt = Date.now();
    this.queue.push(event);
  }

  private emitSessionStartIfNeeded(): void {
    if (this.sessionStartEmitted) return;
    this.sessionStartEmitted = true;
    if (!this._sessionId) {
      this._sessionId = newSessionId();
      this.corr.bindSession(this._sessionId);
    }
    this.emit({
      ...this.corr.envelope(),
      kind: "session_start",
      source: this.sessionSource,
    });
  }

  async send(message: UserTurn): Promise<void> {
    if (this.closed) throw new Error("FakeHandle: send after shutdown");
    // Every send starts its own turn. The first send's turn also carries
    // the `session_start` event (emitted lazily so it shares the turnId).
    this.corr.startTurn();

    const text = this.redactor.redact(message.text);
    queueMicrotask(() => this.runScriptedTurn(text, message));
  }

  private runScriptedTurn(rawText: string, _message: UserTurn): void {
    // Emit session_start on the first send — it rides inside the current
    // turn's envelope sequence, preserving the invariant that every event
    // belongs to exactly one turn.
    this.emitSessionStartIfNeeded();

    // Secret redaction: feed the planted secret through the redactor if
    // we spot it. The redactor scrubs the substring but we also want to
    // ensure the stream doesn't leak it.
    const textForStream = rawText.includes(PLANTED_SECRET)
      ? this.redactor.redact(rawText)
      : rawText;

    if (rawText.toLowerCase().includes("definitely-does-not-exist")) {
      this.emit({
        ...this.corr.envelope(),
        kind: "error",
        fatal: true,
        errorCode: "tool_not_found",
        message: "Adapter simulated fatal error for forced-fail scenario.",
        retriable: false,
      });
      this.closeTurn("error");
      return;
    }

    // Always emit a minimum useful stream: assistant_delta, assistant_message,
    // optional tool_call/tool_result, usage, cost, patch_applied, turn_end.
    this.emit({
      ...this.corr.envelope(),
      kind: "assistant_delta",
      text: textForStream.slice(0, 32),
    });
    this.emit({
      ...this.corr.envelope(),
      kind: "assistant_message",
      text: textForStream,
      stopReason: "end_turn",
    });

    // Tool call scenario: prompt mentions "Read the file README.md".
    if (/Read .+README\.md/i.test(rawText)) {
      this.emitToolCallAndResult();
    }

    // Patch scenario: prompt mentions creating a file.
    if (/Create a file/i.test(rawText)) {
      this.emit({
        ...this.corr.envelope(),
        kind: "patch_applied",
        files: ["note.txt"],
        stats: { add: 1, del: 0 },
      });
    }

    // Long / slow turn → park after the first delta; `interrupt()` unsticks.
    if (/Count slowly/i.test(rawText)) {
      // Park. `interrupt()` finishes the turn.
      return;
    }

    this.emitUsageAndCost();
    this.closeTurn("end_turn");
  }

  private emitToolCallAndResult(): void {
    const id = newToolCallId();
    const callEnv = this.corr.envelope();
    this.corr.rememberToolCall(id, callEnv.eventId as EventId);
    this.emit({
      ...callEnv,
      kind: "tool_call",
      toolCallId: id as ToolCallId,
      tool: "Read",
      args: { file_path: "README.md" },
    });
    this.emit({
      ...this.corr.envelope({
        parentEventId: this.corr.parentForToolResult(id),
      }),
      kind: "tool_result",
      toolCallId: id as ToolCallId,
      ok: true,
      summary: "README body goes here.",
      bytes: 22,
    });
  }

  private emitUsageAndCost(): void {
    this.emit({
      ...this.corr.envelope(),
      kind: "usage",
      model: this.currentModel,
      tokens: { input: 10, output: 20 },
      cache: { hits: 0, misses: 1 },
    });
    this.emit({
      ...this.corr.envelope(),
      kind: "cost",
      usd: 0.01,
      confidence: "exact",
      source: "vendor",
    });
  }

  private closeTurn(stopReason: string): void {
    this.emit({
      ...this.corr.envelope(),
      kind: "turn_end",
      stopReason,
      durationMs: 1,
    });
    this.corr.endTurn();
  }

  async interrupt(_reason?: string): Promise<void> {
    if (this.closed || this.interrupted) return;
    this.interrupted = true;
    this.emit({
      ...this.corr.envelope(),
      kind: "interrupt",
      requestedBy: "user",
      delivered: true,
    });
    // Flush the parked long-turn path.
    this.emitUsageAndCost();
    this.closeTurn("interrupted");
  }

  async setModel(model: string): Promise<void> {
    this.currentModel = model;
  }

  async setPermissionMode(_mode: PermissionMode): Promise<void> {
    // The fake doesn't actually enforce permission modes; the scenario
    // only asserts the call doesn't throw for declared-supported modes.
  }

  async shutdown(reason: string): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // session_end is best-effort: if the current turn is closed we'd need
    // a fresh turn to emit it; the adapter contract allows the iterable
    // to complete without a terminal session_end, so we just close the
    // queue. `reason` is retained on the captured payload for adapters
    // that want a terminal breadcrumb in the future.
    void reason;
    this.queue.close();
  }

  heartbeat(): HandleHeartbeat {
    return { lastEventAt: this.lastEventAt, seq: this.corr.peekSeq() };
  }
}

export class FakeAdapter implements AgentAdapter {
  public readonly vendor = "fake";
  public readonly capabilities = FAKE_CAPABILITIES;

  async spawn(opts: SpawnOpts): Promise<AgentHandle> {
    return new FakeHandle(null, this.vendor, opts);
  }

  async resume(sessionId: SessionId, opts: SpawnOpts): Promise<AgentHandle> {
    return new FakeHandle(sessionId, this.vendor, opts);
  }
}
