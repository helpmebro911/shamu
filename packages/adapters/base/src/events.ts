/**
 * Adapter-side event helpers.
 *
 * Re-exports the canonical schema and TypeScript types from
 * `@shamu/shared/events` so adapter code has a single import site, and adds a
 * small surface the adapters actually need:
 *
 * - `validateEvent(value)` — throws `ZodError` if the event doesn't match.
 * - `safeValidateEvent(value)` — Result-shaped wrapper for hot paths that want
 *   to branch instead of throw.
 * - `isEventOfKind(event, kind)` — narrowing predicate used by the contract
 *   suite's ordering assertions.
 * - `toolCallEventsMatch(call, result)` — lightweight pairing check that
 *   covers the "matching toolCallId" row of the adapter acceptance table.
 */

import {
  AGENT_EVENT_KINDS,
  type AgentEvent,
  type AgentEventKind,
  agentEventSchema,
  type EventEnvelope,
  parseAgentEvent,
  type RawEventRef,
  rawEventRefSchema,
} from "@shamu/shared/events";
import { err, ok, type Result } from "@shamu/shared/result";

export type { AgentEvent, AgentEventKind, EventEnvelope, RawEventRef };
export { AGENT_EVENT_KINDS, agentEventSchema, parseAgentEvent, rawEventRefSchema };

/**
 * Strict validator. Throws the underlying ZodError on failure — callers that
 * want a structured error should use `safeValidateEvent`.
 */
export function validateEvent(value: unknown): AgentEvent {
  return parseAgentEvent(value);
}

/**
 * Non-throwing validator. The `Error` shape is passed through so a caller can
 * surface the schema complaint verbatim in an `error` event.
 */
export function safeValidateEvent(value: unknown): Result<AgentEvent, Error> {
  const parsed = agentEventSchema.safeParse(value);
  if (parsed.success) return ok(parsed.data);
  return err(parsed.error);
}

/**
 * Narrowing predicate. Prefer over manual `event.kind === "..."` so that a
 * misspelled literal trips the kind-union exhaustiveness check.
 */
export function isEventOfKind<K extends AgentEventKind>(
  event: AgentEvent,
  kind: K,
): event is Extract<AgentEvent, { kind: K }> {
  return event.kind === kind;
}

/**
 * Pair validation used by the contract suite. A `tool_result` event is
 * considered matched to a `tool_call` iff their `toolCallId`s are equal AND
 * the result's `parentEventId` points at the call's `eventId`.
 */
export function toolCallEventsMatch(
  call: Extract<AgentEvent, { kind: "tool_call" }>,
  result: Extract<AgentEvent, { kind: "tool_result" }>,
): boolean {
  return call.toolCallId === result.toolCallId && result.parentEventId === call.eventId;
}

/**
 * Ordering invariants every adapter's event stream MUST respect. Exported so
 * the contract suite and the replay test can share one assertion path.
 */
export interface OrderingViolation {
  readonly index: number;
  readonly reason:
    | "seq_non_monotonic"
    | "turn_event_outside_turn"
    | "turn_end_without_start"
    | "ts_monotonic_decreased";
  readonly message: string;
}

/**
 * Walk an ordered event array and return every violation. Empty array ⇒ the
 * stream is well-formed.
 *
 * Rules checked:
 * - `seq` is strictly increasing within a single run.
 * - `tsMonotonic` is non-decreasing within a single run.
 * - Every event carries a `turnId`; turn membership is sticky within a turn.
 *   (We do not enforce "turnId must change between turns" because a future
 *   one-turn-only adapter is legal — but once a `turn_end` fires we expect
 *   subsequent events to carry a fresh `turnId`.)
 */
export function checkOrderingInvariants(events: readonly AgentEvent[]): OrderingViolation[] {
  const violations: OrderingViolation[] = [];
  let lastSeq = Number.NEGATIVE_INFINITY;
  let lastTsMonotonic = Number.NEGATIVE_INFINITY;
  let currentTurnId: string | null = null;
  let turnEnded = false;

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (!ev) continue;
    if (ev.seq <= lastSeq) {
      violations.push({
        index: i,
        reason: "seq_non_monotonic",
        message: `seq ${ev.seq} at index ${i} not > previous ${lastSeq}`,
      });
    }
    if (ev.tsMonotonic < lastTsMonotonic) {
      violations.push({
        index: i,
        reason: "ts_monotonic_decreased",
        message: `tsMonotonic ${ev.tsMonotonic} decreased from ${lastTsMonotonic}`,
      });
    }
    if (currentTurnId === null) {
      currentTurnId = ev.turnId;
    } else if (turnEnded) {
      if (ev.turnId === currentTurnId && ev.kind !== "session_end") {
        violations.push({
          index: i,
          reason: "turn_event_outside_turn",
          message: `event ${ev.kind} at index ${i} re-uses turnId after turn_end`,
        });
      }
      currentTurnId = ev.turnId;
      turnEnded = false;
    }
    if (ev.kind === "turn_end") {
      if (ev.turnId !== currentTurnId) {
        violations.push({
          index: i,
          reason: "turn_end_without_start",
          message: `turn_end for turnId ${ev.turnId} did not match opening turn ${currentTurnId}`,
        });
      }
      turnEnded = true;
    }
    lastSeq = ev.seq;
    lastTsMonotonic = ev.tsMonotonic;
  }
  return violations;
}
