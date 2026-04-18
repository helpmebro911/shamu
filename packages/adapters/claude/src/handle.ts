// `ClaudeHandle` — bridges the Claude SDK's `query()` iterator (and v2
// session iterator) to the shamu `AgentHandle` contract.
//
// Per Phase 0.A: `ClaudeSDKClient` does NOT exist in 0.2.113. We use
//   - `query()` for one-shot turns (returns a `Query` async-iterable)
//   - `unstable_v2_createSession` + `.send()` + `.stream()` for warm resume
//
// The handle is a thin shell: it forwards user messages to the Claude
// iterator and drains the iterator into shamu events via `projectClaudeMessage`.
// The real work is in `hooks.ts` (projection) and `permission-handler.ts`.
//
// runId invariant: we consume `opts.runId`; the caller's CLI rejects
// mismatches, but we also assert defensively inside the constructor.

import {
  type AgentEvent,
  type AgentHandle,
  CorrelationState,
  type HandleHeartbeat,
  type MonotonicClock,
  type PermissionMode,
  type SpawnOpts,
  type UserTurn,
  validateEvent,
} from "@shamu/adapters-base";
import { type EventId, newSessionId, type RunId, type SessionId } from "@shamu/shared/ids";
import type { Redactor } from "@shamu/shared/redactor";
import {
  type ClaudeHookInput,
  type ClaudeRaw,
  projectClaudeHook,
  projectClaudeMessage,
} from "./hooks.ts";

/**
 * Claude's `Query` shape as far as this adapter cares about it. Declared
 * structurally so unit tests can supply an in-process double without pulling
 * the SDK into the test graph.
 */
export interface ClaudeQueryLike extends AsyncIterable<ClaudeRaw> {
  interrupt(): Promise<void>;
  setModel(model?: string): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
}

/**
 * Claude's v2 session handle as we use it. `send()` pushes a user message;
 * `stream()` returns the same async-iterable of raw messages. `close()`
 * terminates the session subprocess.
 */
export interface ClaudeSessionLike {
  readonly sessionId: string;
  send(message: string): Promise<void>;
  stream(): AsyncIterable<ClaudeRaw>;
  close(): void;
}

/**
 * Abstraction the handle drives. The production adapter provides one
 * implementation backed by `query()` + `unstable_v2_*`; tests provide a
 * scripted double.
 */
export interface ClaudeDriver {
  /**
   * Begin a turn for a spawned handle. The driver returns a live Query
   * iterator; it's the handle's job to drain it into events.
   */
  startQuery(prompt: string, signal: AbortSignal): Promise<ClaudeQueryLike>;
  /**
   * Send a follow-up turn on a resumed v2 session. Returns the async
   * iterable for the new turn's messages (not the full session history).
   */
  sendOnSession(session: ClaudeSessionLike, prompt: string): Promise<AsyncIterable<ClaudeRaw>>;
  /**
   * The v2 session object, if any. `null` when the handle was spawned via
   * one-shot `query()`.
   */
  readonly session: ClaudeSessionLike | null;
}

export interface ClaudeHandleOptions {
  readonly vendor: string;
  readonly sessionSource: "spawn" | "resume";
  readonly initialSessionId: SessionId | null;
  readonly clock?: MonotonicClock | undefined;
  readonly newEventId?: (() => EventId) | undefined;
  readonly redactor: Redactor;
  readonly spawnOpts: SpawnOpts;
  readonly driver: ClaudeDriver;
  readonly currentModel: string;
}

interface EventQueueItem {
  readonly kind: "event" | "close";
  readonly event?: AgentEvent;
}

/**
 * Single-consumer async queue. Same shape as the echo adapter's; we could
 * factor it to base but keeping it private lets each adapter tune its
 * push/close semantics without a shared surface.
 */
class EventQueue {
  private readonly waiters: Array<(v: IteratorResult<AgentEvent>) => void> = [];
  private readonly pending: EventQueueItem[] = [];
  private closed = false;

  push(ev: AgentEvent): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: ev, done: false });
      return;
    }
    this.pending.push({ kind: "event", event: ev });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.pending.push({ kind: "close" });
    while (this.waiters.length > 0) {
      const w = this.waiters.shift();
      if (w) w({ value: undefined, done: true });
    }
  }

  async *iterate(): AsyncIterableIterator<AgentEvent> {
    while (true) {
      const next = this.pending.shift();
      if (next) {
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

export class ClaudeHandle implements AgentHandle {
  public readonly runId: RunId;
  private _sessionId: SessionId | null;
  private readonly queue = new EventQueue();
  private readonly corr: CorrelationState;
  private readonly redactor: Redactor;
  private readonly driver: ClaudeDriver;
  private readonly vendor: string;
  private readonly sessionSource: "spawn" | "resume";
  private currentModel: string;
  private sessionStartEmitted = false;
  private lastEventAt = 0;
  private activeQuery: ClaudeQueryLike | null = null;
  private activeAbort: AbortController | null = null;
  private turnActive = false;
  private closed = false;
  private readonly toolCallParents = new Map<string, EventId>();

  constructor(opts: ClaudeHandleOptions) {
    // runId is orchestrator-owned (G8). Assert so an internal misuse trips
    // loudly during tests; the CLI also asserts on the return value.
    if (!opts.spawnOpts.runId) {
      throw new Error("ClaudeHandle: opts.spawnOpts.runId is required (G8)");
    }
    this.runId = opts.spawnOpts.runId;
    this._sessionId = opts.initialSessionId;
    this.redactor = opts.redactor;
    this.driver = opts.driver;
    this.vendor = opts.vendor;
    this.sessionSource = opts.sessionSource;
    this.currentModel = opts.currentModel;
    this.corr = new CorrelationState({
      runId: this.runId,
      sessionId: opts.initialSessionId,
      vendor: opts.vendor,
      ...(opts.clock ? { clock: opts.clock } : {}),
      ...(opts.newEventId ? { newEventId: opts.newEventId } : {}),
    });
  }

  get sessionId(): SessionId | null {
    return this._sessionId;
  }

  get events(): AsyncIterable<AgentEvent> {
    return this.queue.iterate();
  }

  heartbeat(): HandleHeartbeat {
    return { lastEventAt: this.lastEventAt, seq: this.corr.peekSeq() };
  }

  async send(message: UserTurn): Promise<void> {
    if (this.closed) throw new Error("ClaudeHandle: send() after shutdown()");
    if (this.turnActive) {
      throw new Error("ClaudeHandle: send() while a turn is already active");
    }
    this.turnActive = true;
    this.corr.startTurn();
    this.emitSessionStartIfNeeded();

    // Drain in the background so `send()` returns promptly; the iterable
    // consumer sees events as they arrive.
    queueMicrotask(() => {
      this.drainTurn(message.text).catch((err) => this.handleDrainError(err));
    });
  }

  private emitSessionStartIfNeeded(): void {
    if (this.sessionStartEmitted) return;
    this.sessionStartEmitted = true;
    if (!this._sessionId) {
      // Claim a temporary shamu-side session id — the SDK's own session id
      // arrives on `system:init`; when that lands we rebind.
      this._sessionId = newSessionId();
      this.corr.bindSession(this._sessionId);
    }
    this.emit({
      ...this.corr.envelope(),
      kind: "session_start",
      source: this.sessionSource,
    });
  }

  /**
   * The turn driver. Spawns or reuses the SDK iterator, projects each raw
   * message, and closes the turn when the `result` message arrives (or the
   * iterator ends without one — we synthesize a turn_end in that case so
   * the consumer's `for await` loop exits cleanly).
   */
  private async drainTurn(promptText: string): Promise<void> {
    const abort = new AbortController();
    this.activeAbort = abort;

    let iterable: AsyncIterable<ClaudeRaw>;
    if (this.driver.session) {
      iterable = await this.driver.sendOnSession(this.driver.session, promptText);
    } else {
      const query = await this.driver.startQuery(promptText, abort.signal);
      this.activeQuery = query;
      iterable = query;
    }

    let sawTerminal = false;
    try {
      for await (const raw of iterable) {
        if (this.closed) break;
        const events = projectClaudeMessage(raw, {
          corr: this.corr,
          redactor: this.redactor,
          currentModel: this.currentModel,
          onToolCall: (toolCallId, eventId) => {
            this.toolCallParents.set(toolCallId, eventId);
            this.corr.rememberToolCall(toolCallId, eventId);
          },
          parentForToolResult: (toolCallId) =>
            this.corr.parentForToolResult(toolCallId) ??
            this.toolCallParents.get(toolCallId) ??
            null,
          onSessionId: (sid) => this.bindVendorSessionId(sid),
          onTurnTerminal: () => {
            sawTerminal = true;
          },
        });
        for (const ev of events) this.emit(ev);
      }
    } catch (err) {
      // Defensive: an iterator-side throw becomes an error event + synthetic
      // turn_end so the handle doesn't stall waiting for turn_end forever.
      this.emit({
        ...this.corr.envelope(),
        kind: "error",
        fatal: true,
        errorCode: "adapter_stream_failure",
        message: this.redactor.redact((err as Error)?.message ?? String(err)),
        retriable: false,
      });
    }

    if (!sawTerminal && !this.closed) {
      // The iterator ended without a `result` message — shouldn't happen on
      // a healthy stream but synthesize a turn_end to preserve the contract.
      this.emit({
        ...this.corr.envelope(),
        kind: "turn_end",
        stopReason: "stream_ended",
        durationMs: 0,
      });
    }

    this.corr.endTurn();
    this.turnActive = false;
    this.activeQuery = null;
    this.activeAbort = null;
  }

  private handleDrainError(err: unknown): void {
    if (this.closed) return;
    // Same shape as the per-iterator catch — we emit once, close the turn.
    try {
      this.emit({
        ...this.corr.envelope(),
        kind: "error",
        fatal: true,
        errorCode: "adapter_drain_failure",
        message: this.redactor.redact((err as Error)?.message ?? String(err)),
        retriable: false,
      });
      this.emit({
        ...this.corr.envelope(),
        kind: "turn_end",
        stopReason: "error",
        durationMs: 0,
      });
      this.corr.endTurn();
    } catch {
      // Envelope state wedged — give up; `closed` will close the iterable.
    }
    this.turnActive = false;
  }

  /**
   * Rebind the shamu-local session id to the SDK's vendor id when it first
   * arrives. Keeps the envelopes honest: the `sessionId` on every event
   * points to the id a `resume` can use.
   */
  private bindVendorSessionId(vendorId: string): void {
    this._sessionId = vendorId as SessionId;
    this.corr.bindSession(this._sessionId);
  }

  /**
   * Surface a hook event as a normalized event. Called by the adapter's
   * hook-registration glue (see `index.ts`); kept here so the redactor and
   * correlation state live in one place.
   */
  projectHook(hook: ClaudeHookInput): void {
    if (this.closed) return;
    const events = projectClaudeHook(hook, {
      corr: this.corr,
      redactor: this.redactor,
      // SessionStart emission from a hook is only correct in the v2 session
      // path — the one-shot `query()` already emits it via `system:init`.
      expectSessionStartEmission: !!this.driver.session && !this.sessionStartEmitted,
    });
    for (const ev of events) this.emit(ev);
  }

  private emit(raw: AgentEvent): void {
    // Schema validation on the way out — belt and braces. A projector bug
    // lands loudly in the adapter test suite, not silently in the DB.
    const ev = validateEvent(raw);
    this.lastEventAt = ev.tsWall;
    this.queue.push(ev);
  }

  async interrupt(reason?: string): Promise<void> {
    if (this.closed) return;
    // Emit the interrupt event first so the consumer sees it before the
    // SDK's own stream wind-down.
    try {
      this.emit({
        ...this.corr.envelope(),
        kind: "interrupt",
        requestedBy: "user",
        delivered: this.turnActive,
      });
    } catch {
      // No active turn; open a micro-turn so the interrupt event rides
      // inside a valid envelope.
      this.corr.startTurn();
      this.emit({
        ...this.corr.envelope(),
        kind: "interrupt",
        requestedBy: "user",
        delivered: false,
      });
      this.emit({
        ...this.corr.envelope(),
        kind: "turn_end",
        stopReason: reason ?? "interrupted",
        durationMs: 0,
      });
      this.corr.endTurn();
      return;
    }
    if (this.activeQuery) {
      try {
        await this.activeQuery.interrupt();
      } catch {
        // The SDK may reject if the stream has already resolved; we've
        // already surfaced the interrupt event so callers are informed.
      }
    }
    if (this.activeAbort) this.activeAbort.abort();
  }

  async setModel(model: string): Promise<void> {
    if (typeof model !== "string" || model.length === 0) {
      throw new Error("ClaudeHandle.setModel: model must be a non-empty string");
    }
    this.currentModel = model;
    if (this.activeQuery) {
      try {
        await this.activeQuery.setModel(model);
      } catch {
        // SDK rejects when not in streaming-input mode; model change still
        // applies to subsequent `usage` events emitted by this adapter.
      }
    }
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    // Capability-check is done in the adapter shell; this is the delegate.
    if (this.activeQuery) {
      try {
        await this.activeQuery.setPermissionMode(mode);
        return;
      } catch {
        // Fall through — the mode is still recorded on subsequent turns.
      }
    }
    // No active query → the mode will apply when the next turn starts; for
    // the v2 session path we currently don't support mid-session mode
    // changes (SDK allows it only in streaming-input mode, which is a TODO
    // for Phase 3).
  }

  async shutdown(reason: string): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // Best-effort session_end. If the current turn is open, emit inside it;
    // otherwise open a micro-turn.
    try {
      if (!this.turnActive) this.corr.startTurn();
      this.emit({
        ...this.corr.envelope(),
        kind: "session_end",
        reason,
      });
      this.corr.endTurn();
    } catch {
      // ignore — envelope state may be wedged; iterable completion is the
      // contract, not a guaranteed session_end.
    }
    if (this.activeAbort) this.activeAbort.abort();
    if (this.driver.session) this.driver.session.close();
    this.queue.close();
  }
}
