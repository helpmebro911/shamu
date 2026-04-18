/**
 * `CorrelationState` — envelope assembly for per-run event emission.
 *
 * Every adapter must produce events with stable correlation metadata:
 * unique ULID `eventId`, monotonic `seq`, monotonic `tsMonotonic`, a
 * `turnId` that groups events within a vendor turn, and a `parentEventId`
 * that threads `tool_result → tool_call` / `error → trigger` chains.
 *
 * Rather than having every adapter reinvent this, we expose a tiny state
 * machine they instantiate once per run. Properties:
 *
 * - **Monotonic sequence.** `nextSeq()` is strictly increasing and starts at
 *   0. Callers that re-emit historical events (replay) should use a second
 *   instance or `setSeq(n)` before each batch.
 * - **Monotonic timestamp.** Takes a `clock` dependency; default is
 *   `process.hrtime.bigint()` rebased to ms. Never returns a value less than
 *   the last one emitted — so `tsMonotonic` is safe to compare.
 * - **Turn threading.** `startTurn()` either allocates a new `TurnId` or
 *   reuses a caller-supplied one (e.g., when resuming a vendor session).
 *   `endTurn()` marks the current turn closed — subsequent `envelope()`
 *   calls without a `startTurn()` after a close raise.
 * - **Parent linkage.** Helpers `rememberToolCall(toolCallId, eventId)` +
 *   `parentForToolResult(toolCallId)` cover the contract suite's most
 *   common pairing. Adapters with additional parent edges (e.g., Claude's
 *   `PostToolUse` hooks referencing a prior `tool_call`) can call
 *   `envelope({ parentEventId })` directly.
 */

import type { EventEnvelope, RawEventRef } from "@shamu/shared/events";
import {
  type EventId,
  newEventId,
  newTurnId,
  type RunId,
  type SessionId,
  type ToolCallId,
  type TurnId,
} from "@shamu/shared/ids";

export type MonotonicClock = () => { monotonic: number; wall: number };

/**
 * Default clock. `process.hrtime.bigint()` returns nanoseconds from a host-
 * specific origin; we divide by 1e6 to get monotonic milliseconds. Wall-clock
 * is `Date.now()`.
 *
 * `tsMonotonic` is a number (Zod schema uses `z.number().int()`); we cap the
 * resolution at milliseconds so we stay inside the safe-integer range for
 * decades of uptime.
 */
export const defaultClock: MonotonicClock = () => {
  const hrtimeAvailable =
    typeof process !== "undefined" && typeof process.hrtime?.bigint === "function";
  const monotonic = hrtimeAvailable ? Number(process.hrtime.bigint() / 1_000_000n) : Date.now(); // fallback
  return { monotonic, wall: Date.now() };
};

export interface CorrelationStateOptions {
  readonly runId: RunId;
  readonly sessionId?: SessionId | null;
  readonly vendor: string;
  readonly clock?: MonotonicClock;
  /** Override the ULID factory; the contract suite pins a deterministic one. */
  readonly newEventId?: () => EventId;
  readonly newTurnId?: () => TurnId;
}

export interface EnvelopeInput {
  readonly turnId?: TurnId;
  readonly parentEventId?: EventId | null;
  readonly rawRef?: RawEventRef | null;
}

export class CorrelationState {
  public readonly runId: RunId;
  public readonly vendor: string;
  private _sessionId: SessionId | null;
  private seq = 0;
  private lastMonotonic = Number.NEGATIVE_INFINITY;
  private lastWall = 0;
  private currentTurnId: TurnId | null = null;
  private turnClosed = false;
  private readonly clock: MonotonicClock;
  private readonly eventIdFactory: () => EventId;
  private readonly turnIdFactory: () => TurnId;
  private readonly toolCallParents = new Map<ToolCallId, EventId>();

  constructor(opts: CorrelationStateOptions) {
    this.runId = opts.runId;
    this.vendor = opts.vendor;
    this._sessionId = opts.sessionId ?? null;
    this.clock = opts.clock ?? defaultClock;
    this.eventIdFactory = opts.newEventId ?? newEventId;
    this.turnIdFactory = opts.newTurnId ?? newTurnId;
  }

  get sessionId(): SessionId | null {
    return this._sessionId;
  }

  /** Called by the adapter when the vendor emits `session_start`. */
  bindSession(sessionId: SessionId | null): void {
    this._sessionId = sessionId;
  }

  /**
   * Start a new turn. If `turnId` is supplied (e.g., when the vendor has an
   * existing turn id we should mirror), that id is reused; otherwise a fresh
   * ULID is generated.
   */
  startTurn(turnId?: TurnId): TurnId {
    this.currentTurnId = turnId ?? this.turnIdFactory();
    this.turnClosed = false;
    return this.currentTurnId;
  }

  /** Close the current turn. The next envelope requires `startTurn` first. */
  endTurn(): void {
    this.turnClosed = true;
  }

  /**
   * Remember the event id that published a tool call so results can link back.
   *
   * Accepts a plain string because the `EventEnvelope.eventId` field is a
   * ULID-validated string at the schema level (branded ids are a compile-
   * time nicety from `@shamu/shared/ids` — not enforced at runtime). This
   * keeps call sites ergonomic: `rememberToolCall(id, envelope.eventId)`.
   */
  rememberToolCall(toolCallId: ToolCallId, eventId: EventId | string): void {
    this.toolCallParents.set(toolCallId, eventId as EventId);
  }

  /** Retrieve the remembered event id for a tool call, or null if unknown. */
  parentForToolResult(toolCallId: ToolCallId): EventId | null {
    return this.toolCallParents.get(toolCallId) ?? null;
  }

  /** Peek the next seq without consuming it. Tests use this for assertions. */
  peekSeq(): number {
    return this.seq;
  }

  /**
   * Produce a fresh `EventEnvelope`. Callers compose it with a kind-specific
   * payload (`{ ...env, kind: "tool_call", ... }`) to form the full
   * `AgentEvent`.
   *
   * Rules:
   * - If `input.turnId` is omitted we use `currentTurnId`; throws when the
   *   current turn is closed and no explicit `turnId` is supplied.
   * - `seq` is pre-incremented BEFORE the return value is built, so two
   *   envelopes produced in the same microtask are still distinct.
   * - `tsMonotonic` is clamped to be >= the last value we emitted.
   */
  envelope(input: EnvelopeInput = {}): EventEnvelope {
    const turnId = input.turnId ?? this.currentTurnId;
    if (!turnId) {
      throw new Error(
        "CorrelationState.envelope() called without an active turn; call startTurn() first",
      );
    }
    if (this.turnClosed && !input.turnId) {
      throw new Error(
        "CorrelationState.envelope() called after endTurn(); restart a turn before emitting",
      );
    }
    const { monotonic, wall } = this.clock();
    const tsMonotonic = monotonic < this.lastMonotonic ? this.lastMonotonic : monotonic;
    const tsWall = wall < this.lastWall ? this.lastWall : wall;
    this.lastMonotonic = tsMonotonic;
    this.lastWall = tsWall;

    this.seq += 1;
    return {
      eventId: this.eventIdFactory(),
      runId: this.runId,
      sessionId: this._sessionId,
      turnId,
      parentEventId: input.parentEventId ?? null,
      seq: this.seq,
      tsMonotonic,
      tsWall,
      vendor: this.vendor,
      rawRef: input.rawRef ?? null,
    };
  }
}
