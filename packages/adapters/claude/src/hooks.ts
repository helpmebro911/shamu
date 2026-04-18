// Claude → normalized AgentEvent projection.
//
// Ported from the Phase 0.B spike (`docs/phase-0/event-schema-spike/src/
// project.ts`) and hardened for the finalized shared schema. Key delta from
// the spike:
//
//   - `error.code` → `error.errorCode` (shared Zod renames to avoid a
//     collision with `ShamuError.code`).
//   - `cache: { hitRate }` → `cache: { hits, misses }`. Claude's SDK reports
//     `cache_read_input_tokens` and `cache_creation_input_tokens`; we map
//     those directly to `{ hits: cacheRead, misses: inputOnly }`.
//   - `tokens.cacheWrite` → `tokens.cacheCreation`.
//   - `rate_limit` is now a first-class kind; no longer a gap.
//   - `reasoning` (Claude's `thinking` content block) is now a first-class
//     kind; we emit it.
//
// These projectors are side-effect-free pure functions: they take a raw
// Claude SDK message + a `CorrelationState` and return the events to emit.
// The handle wraps them with the redactor, schema validation, and queue
// push. That split lets unit tests drive the projector with hand-built raw
// payloads, no live SDK required.

import type { CorrelationState } from "@shamu/adapters-base/correlation";
import type { AgentEvent } from "@shamu/adapters-base/events";
import type { EventId, ToolCallId } from "@shamu/shared/ids";
import type { Redactor } from "@shamu/shared/redactor";

// Loosely-typed view of the SDK's message. We don't depend on the vendor's
// exported types at the projection boundary — that keeps unit tests free
// of SDK imports and insulates us from minor vendor-SDK shape drift.
export type ClaudeRaw = {
  readonly type: string;
  readonly subtype?: string;
  readonly uuid?: string;
  readonly session_id?: string;
  readonly message?: {
    readonly content?: readonly ClaudeContentBlock[];
    readonly stop_reason?: string;
  };
  readonly duration_ms?: number;
  readonly total_cost_usd?: number;
  readonly model?: string;
  readonly usage?: ClaudeUsage;
  readonly rate_limit_info?: ClaudeRateLimitInfo;
  readonly is_error?: boolean;
  readonly [extra: string]: unknown;
};

export interface ClaudeContentBlock {
  readonly type: string;
  readonly text?: string;
  readonly id?: string;
  readonly name?: string;
  readonly input?: unknown;
  readonly tool_use_id?: string;
  readonly is_error?: boolean;
  readonly content?: string | ReadonlyArray<{ readonly type?: string; readonly text?: string }>;
  readonly thinking?: string;
  readonly signature?: string;
  readonly [k: string]: unknown;
}

interface ClaudeUsage {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly cache_read_input_tokens?: number;
  readonly cache_creation_input_tokens?: number;
}

interface ClaudeRateLimitInfo {
  readonly status?: string;
  readonly resetsAt?: number;
  readonly rateLimitType?: string;
}

/**
 * Options for `projectClaudeMessage`. The redactor is non-optional — every
 * string field we emit must be routed through it (G1 from threat model).
 */
export interface ProjectOptions {
  readonly corr: CorrelationState;
  readonly redactor: Redactor;
  /** Current model (from `setModel`/spawn opts). Used on `usage`. */
  readonly currentModel: string;
  /**
   * Called on assistant tool_use blocks so the handle can remember the
   * tool-call-id → event-id linkage for later tool_result parent-edge.
   */
  readonly onToolCall: (toolCallId: ToolCallId, eventId: EventId) => void;
  /**
   * Used on tool_result blocks to look up the parent tool_call's event id.
   */
  readonly parentForToolResult: (toolCallId: ToolCallId) => EventId | null;
  /**
   * Called when we observe the SDK's `session_id` so the handle can bind it
   * to `CorrelationState` before the first envelope is produced.
   */
  readonly onSessionId?: (sessionId: string) => void;
  /**
   * Called when projecting a terminal `result` message. Lets the handle
   * know the turn has ended so it can `endTurn()` and open the next one on
   * the user's next `send()`.
   */
  readonly onTurnTerminal?: () => void;
}

/** Summary-truncation policy — matches the base `summarizeToolResult`. */
function truncateToolSummary(text: string, max = 500): string {
  if (text.length <= max) return text;
  return text.slice(0, max);
}

function byteLengthUtf8(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * Classify the vendor rate-limit scope into the shared schema's enum. Claude
 * uses `five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`,
 * `overage`. The shared schema has `minute|hour|day|five_hour|other`. We
 * collapse the seven-day variants to `day` (conservative — a week is too
 * coarse for a granular enum, but `day` signals "long window") and
 * `overage`/unknowns to `other`.
 */
function mapRateLimitScope(raw: string | undefined): AgentEvent & { kind: "rate_limit" } extends {
  scope: infer S;
}
  ? S
  : never {
  switch (raw) {
    case "five_hour":
      return "five_hour";
    case "seven_day":
    case "seven_day_opus":
    case "seven_day_sonnet":
      return "day";
    default:
      return "other";
  }
}

function mapRateLimitStatus(
  raw: string | undefined,
): AgentEvent & { kind: "rate_limit" } extends { status: infer S } ? S : never {
  switch (raw) {
    case "allowed":
      return "ok";
    case "allowed_warning":
      return "warning";
    case "rejected":
      return "exhausted";
    default:
      return "ok";
  }
}

/**
 * Project a single raw Claude SDK message into zero or more normalized
 * events. Returns an empty array for messages we intentionally drop
 * (`system:init`, `system:hook_*`, user-role echoes).
 *
 * The caller is expected to push each returned event through the shared
 * validator + queue. Keeping the projector pure means unit tests can assert
 * event shape without touching an SDK instance.
 */
export function projectClaudeMessage(raw: ClaudeRaw, opts: ProjectOptions): AgentEvent[] {
  const out: AgentEvent[] = [];
  const redact = (s: string): string => opts.redactor.redact(s);
  const redactUnknown = (value: unknown): unknown => {
    if (typeof value === "string") return redact(value);
    if (value && typeof value === "object") {
      if (Array.isArray(value)) return value.map(redactUnknown);
      const record = value as Record<string, unknown>;
      const clone: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(record)) clone[k] = redactUnknown(v);
      return clone;
    }
    return value;
  };

  const type = raw.type;
  const subtype = raw.subtype;

  // --- system:init — bind session, don't emit yet. The handle emits
  // `session_start` lazily inside the first turn so envelope invariants hold.
  if (type === "system" && subtype === "init") {
    if (typeof raw.session_id === "string" && opts.onSessionId) {
      opts.onSessionId(raw.session_id);
    }
    return out;
  }

  // --- system:hook_* — dropped (orchestrator-owned control plane).
  if (
    type === "system" &&
    (subtype === "hook_started" || subtype === "hook_response" || subtype === "hook_progress")
  ) {
    return out;
  }

  // --- rate_limit_event
  if (type === "rate_limit_event") {
    const info = raw.rate_limit_info ?? {};
    out.push({
      ...opts.corr.envelope(),
      kind: "rate_limit",
      scope: mapRateLimitScope(info.rateLimitType),
      status: mapRateLimitStatus(info.status),
      resetsAt: typeof info.resetsAt === "number" ? info.resetsAt : null,
    });
    return out;
  }

  // --- assistant content blocks
  if (type === "assistant") {
    const content = raw.message?.content ?? [];
    const stopReason = raw.message?.stop_reason ?? "end_turn";
    let anyEmitted = false;

    for (const block of content) {
      if (block.type === "text") {
        const text = typeof block.text === "string" ? redact(block.text) : "";
        out.push({
          ...opts.corr.envelope(),
          kind: "assistant_message",
          text,
          stopReason,
        });
        anyEmitted = true;
      } else if (block.type === "tool_use") {
        const id = typeof block.id === "string" && block.id.length > 0 ? block.id : "";
        const name = typeof block.name === "string" && block.name.length > 0 ? block.name : "";
        if (id.length === 0 || name.length === 0) continue;
        const envelope = opts.corr.envelope();
        const toolCallId = id as ToolCallId;
        opts.onToolCall(toolCallId, envelope.eventId as EventId);
        out.push({
          ...envelope,
          kind: "tool_call",
          toolCallId,
          tool: name,
          args: redactUnknown(block.input ?? {}),
        });
        anyEmitted = true;
      } else if (block.type === "thinking") {
        const text = redact(
          typeof block.thinking === "string"
            ? block.thinking
            : typeof block.text === "string"
              ? block.text
              : "",
        );
        const ev: AgentEvent = {
          ...opts.corr.envelope(),
          kind: "reasoning",
          text,
          ...(typeof block.signature === "string" ? { signature: block.signature } : {}),
        };
        out.push(ev);
        anyEmitted = true;
      }
      // Unknown block types are skipped silently; adding a stderr kind would
      // leak internal SDK churn into the event log.
    }

    if (!anyEmitted && content.length > 0) {
      // Content had only unrecognized blocks (e.g., only `thinking` on an
      // older schema). Emit an empty assistant_message so turn ordering is
      // preserved — the stopReason is still meaningful.
      out.push({
        ...opts.corr.envelope(),
        kind: "assistant_message",
        text: "",
        stopReason,
      });
    }
    return out;
  }

  // --- user-role messages: echo of our prompt + tool_result blocks from
  // Claude's tool-use loop. The echo is DROPPED (we already own it). The
  // tool_result blocks become `tool_result` events.
  if (type === "user") {
    const content = raw.message?.content ?? [];
    for (const block of content) {
      if (block.type !== "tool_result") continue;
      const tuid = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
      if (tuid.length === 0) continue;
      const toolCallId = tuid as ToolCallId;
      const parent = opts.parentForToolResult(toolCallId);
      const ok = block.is_error !== true;
      let rawText = "";
      if (typeof block.content === "string") {
        rawText = block.content;
      } else if (Array.isArray(block.content)) {
        rawText = block.content
          .filter((c): c is { type: "text"; text: string } => !!c && c.type === "text")
          .map((c) => (typeof c.text === "string" ? c.text : ""))
          .join("\n");
      }
      const summary = redact(truncateToolSummary(rawText));
      const bytes = byteLengthUtf8(rawText);
      out.push({
        ...opts.corr.envelope({ parentEventId: parent }),
        kind: "tool_result",
        toolCallId,
        ok,
        summary,
        bytes,
      });
    }
    return out;
  }

  // --- result — terminal. Emits usage + cost + turn_end + session_end.
  if (type === "result") {
    const durationMs = typeof raw.duration_ms === "number" ? raw.duration_ms : 0;
    const success = subtype === "success";
    const stopReason = typeof subtype === "string" ? subtype : "success";
    const model =
      typeof raw.model === "string" && raw.model.length > 0 ? raw.model : opts.currentModel;

    if (raw.usage) {
      const u = raw.usage;
      const input = typeof u.input_tokens === "number" ? u.input_tokens : 0;
      const output = typeof u.output_tokens === "number" ? u.output_tokens : 0;
      const cacheRead =
        typeof u.cache_read_input_tokens === "number" ? u.cache_read_input_tokens : 0;
      const cacheCreation =
        typeof u.cache_creation_input_tokens === "number" ? u.cache_creation_input_tokens : 0;
      out.push({
        ...opts.corr.envelope(),
        kind: "usage",
        model,
        tokens: {
          input,
          output,
          cacheRead,
          cacheCreation,
        },
        cache: {
          hits: cacheRead,
          // Claude doesn't report a "miss" counter; `input_tokens` is the
          // effective miss count (the tokens that were NOT served from
          // cache). This is a more honest mapping than the spike's
          // `hitRate` approximation.
          misses: input,
        },
      });
    }

    if (typeof raw.total_cost_usd === "number") {
      out.push({
        ...opts.corr.envelope(),
        kind: "cost",
        usd: raw.total_cost_usd,
        confidence: "exact",
        source: "vendor",
      });
    } else {
      // No cost reported (shouldn't happen on native costReporting, but
      // defensive). Emit an unknown-source cost so the usage-and-cost
      // contract row still sees one. Per capability docs, native requires
      // usd!=null; this fallback is for the adversarial case where the
      // vendor silently stops emitting cost. The contract test will then
      // flag it loudly.
      out.push({
        ...opts.corr.envelope(),
        kind: "cost",
        usd: null,
        confidence: "unknown",
        source: "vendor",
      });
    }

    if (!success) {
      // Non-success subtypes (error_during_execution, error_max_turns,
      // error_max_budget_usd, etc.) become an error event emitted BEFORE
      // the turn closes so consumers draining-to-turn_end still observe it.
      // The SDK puts specific codes on the result subtype.
      const message = redact(`Claude query terminated with subtype=${stopReason}`);
      out.push({
        ...opts.corr.envelope(),
        kind: "error",
        fatal: true,
        errorCode: stopReason,
        message,
        retriable: false,
      });
    }

    out.push({
      ...opts.corr.envelope(),
      kind: "turn_end",
      stopReason,
      durationMs,
    });

    opts.onTurnTerminal?.();
    return out;
  }

  // --- stream_event (partial assistant token). Emitted only when the SDK
  // option `includePartialMessages: true` is set. We translate to
  // `assistant_delta`. Shape: `raw.event` is a BetaRawMessageStreamEvent
  // (content_block_delta variants). Best-effort: extract text.
  if (type === "stream_event") {
    const event = raw.event as { delta?: { type?: string; text?: string } } | undefined;
    const text = event?.delta?.text;
    if (typeof text === "string" && text.length > 0) {
      out.push({
        ...opts.corr.envelope(),
        kind: "assistant_delta",
        text: redact(text),
      });
    }
    return out;
  }

  // Unknown message type — drop. Adding a logging hook here would be noise.
  return out;
}

/**
 * Project a Claude hook callback payload. Hooks are a second path to events
 * — the SDK's `PreToolUse`/`PostToolUse`/`Stop`/`SessionStart` hooks fire
 * alongside the SDKMessage stream. Today we use hooks for ancillary signals:
 *
 *   - `SessionStart` — already covered by `system:init`; we use hooks only
 *     when the SDK is launched with `unstable_v2_*` (no init message).
 *   - `PreToolUse` — currently pass-through (we don't emit a separate event;
 *     the assistant message's `tool_use` block is the source of truth).
 *   - `PostToolUse` — idem; the user-role `tool_result` block is the source.
 *   - `Stop` — emits a `checkpoint` event with `last_assistant_message`.
 *
 * Kept as pure switch here so unit tests can drive it without an SDK live.
 */
export type ClaudeHookInput =
  | {
      readonly hook_event_name: "PreToolUse";
      readonly tool_name: string;
      readonly tool_input: unknown;
      readonly tool_use_id: string;
      readonly session_id: string;
    }
  | {
      readonly hook_event_name: "PostToolUse";
      readonly tool_name: string;
      readonly tool_input: unknown;
      readonly tool_response: unknown;
      readonly tool_use_id: string;
      readonly session_id: string;
    }
  | {
      readonly hook_event_name: "Stop";
      readonly stop_hook_active: boolean;
      readonly last_assistant_message?: string;
      readonly session_id: string;
    }
  | {
      readonly hook_event_name: "SessionStart";
      readonly source: "startup" | "resume" | "clear" | "compact";
      readonly session_id: string;
    };

export interface ProjectHookOptions {
  readonly corr: CorrelationState;
  readonly redactor: Redactor;
  /** True when this is a resumed session (SessionStart → source=resume). */
  readonly expectSessionStartEmission: boolean;
}

export function projectClaudeHook(hook: ClaudeHookInput, opts: ProjectHookOptions): AgentEvent[] {
  const events: AgentEvent[] = [];
  switch (hook.hook_event_name) {
    case "SessionStart": {
      // Only emit here when we're in v2-session mode — otherwise `system:init`
      // already did it and this would double-fire.
      if (!opts.expectSessionStartEmission) return events;
      const source: "spawn" | "resume" | "fork" =
        hook.source === "resume" || hook.source === "compact" ? "resume" : "spawn";
      events.push({
        ...opts.corr.envelope(),
        kind: "session_start",
        source,
      });
      return events;
    }
    case "Stop": {
      const summary = opts.redactor.redact(hook.last_assistant_message ?? "");
      events.push({
        ...opts.corr.envelope(),
        kind: "checkpoint",
        summary,
      });
      return events;
    }
    case "PreToolUse":
    case "PostToolUse":
      // No extra event — the SDKMessage stream already covers these edges.
      return events;
  }
}
