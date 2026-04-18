/**
 * Pure projection of Codex SDK JSONL events → Shamu `AgentEvent[]`.
 *
 * Ported from `docs/phase-0/event-schema-spike/src/project.ts` (Codex side),
 * hardened for the edge cases the spike didn't hit and updated for the
 * finalized schema. Stateless from the caller's perspective — all mutable
 * state is carried on a supplied `CorrelationState` + a small projector-
 * owned bookkeeping object, so the projector can be exercised by unit
 * tests without an SDK instance.
 *
 * Key differences vs the 0.B spike projection:
 *
 * - **`turn.started` is suppressed.** PLAN.md § 1 confirmed the decision: no
 *   top-level `turn_start` kind. We still track the boundary internally so
 *   the first event of a turn allocates a fresh `turnId`, but no
 *   normalized event is emitted for `turn.started`.
 * - **Redaction is the caller's responsibility.** The projector returns raw
 *   `AgentEvent`s; the adapter's handle pipes every string field through a
 *   shared `Redactor` before enqueueing. Splitting the two concerns keeps
 *   the projector fixture-testable without a redactor instance.
 * - **`session_end` only on `thread.closed`-equivalent signal.** The 0.B
 *   shim emitted `session_end` on `turn.completed` because the spike
 *   treated each turn as a whole stream. The real adapter keeps the thread
 *   open across turns; `session_end` fires on adapter shutdown instead.
 * - **Thread-id is captured** from `thread.started` so the handle can
 *   expose `sessionId` before any turn finishes. If the SDK emits a later
 *   `thread.started` (shouldn't happen in normal use) we respect the new
 *   value but warn — useful if a future SDK version introduces
 *   thread-rotation semantics.
 * - **`error.errorCode`** (renamed from `code` in the spike) matches the
 *   current Zod schema so events validate directly without a normalization
 *   step.
 *
 * The projector does NOT apply path-scope or shell-gate checks. Those run
 * pre-dispatch in the permission handler (`permission-handler.ts`) before
 * the SDK is even asked to run the tool — by the time a JSONL event lands
 * here the side effect has already happened.
 */

import type { CorrelationState } from "@shamu/adapters-base";
import type { AgentEvent, EventEnvelope } from "@shamu/shared/events";
import {
  sessionId as asSessionId,
  type EventId,
  newToolCallId,
  type SessionId,
  type ToolCallId,
} from "@shamu/shared/ids";

/**
 * Optional hook bundle the projector consults. All fields are optional;
 * defaults produce the canonical production behavior. Exposed primarily
 * so the handle can thread its `currentModel` into `usage` events and so
 * snapshot tests can pin a deterministic `toolCallId` factory.
 */
export interface CodexProjectionHooks {
  /** Supplies the model id stamped on `usage` events. Default: empty string. */
  readonly modelProvider?: () => string;
  /** Mints the next tool call id. Default: `newToolCallId()`. */
  readonly newToolCallId?: () => ToolCallId;
}

import type {
  AgentMessageItem,
  CommandExecutionItem,
  ErrorItem,
  FileChangeItem,
  ItemCompletedEvent,
  ItemStartedEvent,
  ItemUpdatedEvent,
  McpToolCallItem,
  ReasoningItem,
  ThreadErrorEvent,
  ThreadEvent,
  ThreadItem,
  ThreadStartedEvent,
  TodoListItem,
  TurnCompletedEvent,
  TurnFailedEvent,
  WebSearchItem,
} from "@openai/codex-sdk";

/**
 * Mutable bookkeeping the projector carries across calls. The adapter
 * constructs one per handle and threads it through every projection. It
 * is NOT serializable; it's local runtime state.
 */
export interface CodexProjectionState {
  /**
   * Codex thread id. Set on `thread.started` and surfaced as the handle's
   * `sessionId`. Null until the SDK tells us.
   */
  threadId: SessionId | null;
  /**
   * Tool calls the projector has emitted, keyed by the Codex item id. Used
   * to link `tool_result` → `tool_call` via `parentEventId` without
   * relying on a global singleton.
   */
  readonly toolCallByItemId: Map<string, { toolCallId: ToolCallId; eventId: EventId }>;
  /**
   * Has a `session_start` been emitted? The projector emits one on the
   * first `thread.started`; subsequent thread.starteds (rare, but possible
   * on a future SDK) are warned about but don't re-emit.
   */
  sessionStartEmitted: boolean;
  /**
   * Has a turn been opened since the last `turn.completed` / `turn.failed`?
   * The projector manages `corr.startTurn()` / `corr.endTurn()` based on
   * `turn.started` / `turn.completed|failed` boundaries.
   */
  turnOpen: boolean;
  /**
   * Monotonic turn counter used for durationMs estimates on `turn_end`.
   * The SDK doesn't give us duration directly; we derive it from the
   * monotonic clock via `CorrelationState`'s envelope timestamps. Stored
   * here so `turn.completed` can diff against the value captured on
   * `turn.started`.
   */
  turnStartedAtMonotonic: number | null;
}

export function createProjectionState(): CodexProjectionState {
  return {
    threadId: null,
    toolCallByItemId: new Map(),
    sessionStartEmitted: false,
    turnOpen: false,
    turnStartedAtMonotonic: null,
  };
}

/**
 * Optional warning sink. Adapters can pass `console.warn` or a structured
 * logger; the default is a no-op so unit tests aren't noisy.
 */
export type ProjectionLogger = (msg: string, extra?: Record<string, unknown>) => void;

const noopLogger: ProjectionLogger = () => {};

/** One event in → zero or more `AgentEvent`s out. */
export function projectCodexEvent(
  raw: ThreadEvent,
  corr: CorrelationState,
  state: CodexProjectionState,
  logger: ProjectionLogger = noopLogger,
  hooks: CodexProjectionHooks = {},
): AgentEvent[] {
  switch (raw.type) {
    case "thread.started":
      return handleThreadStarted(raw, corr, state, logger);
    case "turn.started":
      // Intentional drop — no top-level `turn_start` kind (PLAN.md § 1).
      // We still perform the boundary bookkeeping so later events have a
      // turn to hang off of.
      openTurn(corr, state);
      return [];
    case "turn.completed":
      return handleTurnCompleted(raw, corr, state, hooks);
    case "turn.failed":
      return handleTurnFailed(raw, corr, state);
    case "item.started":
      return handleItemStarted(raw, corr, state, logger, hooks);
    case "item.updated":
      return handleItemUpdated(raw, corr, state, logger);
    case "item.completed":
      return handleItemCompleted(raw, corr, state, logger, hooks);
    case "error":
      return handleThreadError(raw, corr, state);
    default: {
      // Exhaustiveness guard — a new SDK top-level kind must be handled
      // explicitly. We surface the raw kind so an operator can spot it in
      // logs; we don't try to synthesize an event, because the taxonomy
      // kill-switch only works if unmapped events are visible.
      const exhaustive: never = raw;
      logger("codex-projection: unhandled top-level event", { raw: exhaustive });
      return [];
    }
  }
}

function openTurn(corr: CorrelationState, state: CodexProjectionState): void {
  if (state.turnOpen) {
    // Duplicate turn.started — the SDK shouldn't do this, but if it does
    // we treat it as a reopen so correlation stays sane.
    return;
  }
  corr.startTurn();
  state.turnOpen = true;
  // Peek a current monotonic timestamp by asking the correlation clock
  // indirectly — `peekSeq` is the cheapest signal we have without pulling
  // the clock directly. For `turn_end.durationMs` we read the envelope's
  // tsMonotonic at close time and diff. We set `turnStartedAtMonotonic`
  // lazily on the first in-turn envelope emission (see `emitInTurn`).
  state.turnStartedAtMonotonic = null;
}

/**
 * Small helper: build an envelope, remembering the first-in-turn monotonic
 * timestamp so `turn_end.durationMs` can be computed at close time.
 */
function emitInTurn(
  corr: CorrelationState,
  state: CodexProjectionState,
  input: { readonly parentEventId?: EventId | null } = {},
): EventEnvelope {
  if (!state.turnOpen) {
    // The SDK skipped `turn.started` (first turn in a thread does so in
    // some Codex paths — the spike fixtures all had it, but we defend
    // anyway). Implicitly open a turn.
    openTurn(corr, state);
  }
  const envelope =
    input.parentEventId !== undefined
      ? corr.envelope({ parentEventId: input.parentEventId })
      : corr.envelope();
  if (state.turnStartedAtMonotonic === null) {
    state.turnStartedAtMonotonic = envelope.tsMonotonic;
  }
  return envelope;
}

function handleThreadStarted(
  raw: ThreadStartedEvent,
  corr: CorrelationState,
  state: CodexProjectionState,
  logger: ProjectionLogger,
): AgentEvent[] {
  const newId = typeof raw.thread_id === "string" ? asSessionId(raw.thread_id) : null;
  if (state.threadId && newId && state.threadId !== newId) {
    // Thread rotation — not a documented SDK behavior; log loudly.
    logger("codex-projection: thread.started emitted a different thread_id than we had", {
      previous: state.threadId,
      next: newId,
    });
  }
  state.threadId = newId;
  if (newId) corr.bindSession(newId);

  if (state.sessionStartEmitted) return [];
  state.sessionStartEmitted = true;

  // `session_start` must live inside a turn (envelope invariant). If no
  // turn is open yet (thread.started arrives before turn.started, which is
  // the canonical order), open one now.
  const envelope = emitInTurn(corr, state);
  // Source is "spawn" for the first thread.started on a fresh handle.
  // Resume paths bind the session id at construction time and set
  // sessionStartEmitted separately — see handle.ts.
  return [
    {
      ...envelope,
      kind: "session_start",
      source: "spawn",
    },
  ];
}

function handleTurnCompleted(
  raw: TurnCompletedEvent,
  corr: CorrelationState,
  state: CodexProjectionState,
  hooks: CodexProjectionHooks,
): AgentEvent[] {
  const events: AgentEvent[] = [];
  // Usage — emit even if tokens are all zero; the contract's
  // `usage-and-cost` scenario requires at least one usage event per turn
  // when `usageReporting != "none"`.
  const usage = raw.usage;
  const usageEnvelope = emitInTurn(corr, state);
  events.push({
    ...usageEnvelope,
    kind: "usage",
    model: hooks.modelProvider ? hooks.modelProvider() : "",
    tokens: {
      input: usage?.input_tokens ?? 0,
      output: usage?.output_tokens ?? 0,
      ...(typeof usage?.cached_input_tokens === "number"
        ? { cacheRead: usage.cached_input_tokens }
        : {}),
    },
    cache: {
      // `cache_read_input_tokens` is our best proxy for hits when the SDK
      // gives us no hit/miss counts. `misses` is the non-cached input.
      hits: usage?.cached_input_tokens ?? 0,
      misses: Math.max(0, (usage?.input_tokens ?? 0) - (usage?.cached_input_tokens ?? 0)),
    },
  });

  // Cost — Codex SDK does not report dollars on any current path. We emit
  // `usd: null` / `confidence: "unknown"`; the core projector stamps the
  // authoritative `source` based on the adapter's declared capability
  // (T17 from threat model). For `costReporting: "subscription"` the
  // contract's `usage-and-cost` scenario asserts `usd === null` +
  // `confidence === "unknown"`, which matches.
  events.push({
    ...emitInTurn(corr, state),
    kind: "cost",
    usd: null,
    confidence: "unknown",
    source: "subscription",
  });

  // Duration. `tsMonotonic` on the usage envelope is the tail of the
  // turn; `turnStartedAtMonotonic` is the head. Diff gives ms.
  const durationMs = Math.max(
    0,
    usageEnvelope.tsMonotonic - (state.turnStartedAtMonotonic ?? usageEnvelope.tsMonotonic),
  );
  events.push({
    ...emitInTurn(corr, state),
    kind: "turn_end",
    stopReason: "completed",
    durationMs,
  });

  corr.endTurn();
  state.turnOpen = false;
  state.turnStartedAtMonotonic = null;
  return events;
}

function handleTurnFailed(
  raw: TurnFailedEvent,
  corr: CorrelationState,
  state: CodexProjectionState,
): AgentEvent[] {
  const events: AgentEvent[] = [];
  events.push({
    ...emitInTurn(corr, state),
    kind: "error",
    fatal: true,
    errorCode: "turn_failed",
    message: raw.error?.message ?? "unknown turn failure",
    // Codex doesn't classify retriability on the turn-level failure; we
    // default to false. A future SDK surface that carries a status/rate
    // code would let us refine this.
    retriable: false,
  });
  events.push({
    ...emitInTurn(corr, state),
    kind: "turn_end",
    stopReason: "failed",
    durationMs: 0,
  });
  corr.endTurn();
  state.turnOpen = false;
  state.turnStartedAtMonotonic = null;
  return events;
}

function handleThreadError(
  raw: ThreadErrorEvent,
  corr: CorrelationState,
  state: CodexProjectionState,
): AgentEvent[] {
  return [
    {
      ...emitInTurn(corr, state),
      kind: "error",
      fatal: true,
      errorCode: "stream_error",
      message: raw.message ?? "unknown stream error",
      retriable: false,
    },
  ];
}

function handleItemStarted(
  raw: ItemStartedEvent,
  corr: CorrelationState,
  state: CodexProjectionState,
  logger: ProjectionLogger,
  hooks: CodexProjectionHooks,
): AgentEvent[] {
  const item = raw.item;
  switch (item.type) {
    case "command_execution":
      return [emitCommandToolCall(item, corr, state, hooks)];
    case "file_change":
      return [emitFileChangeToolCall(item, corr, state, hooks)];
    case "mcp_tool_call":
      return [emitMcpToolCall(item, corr, state, hooks)];
    case "web_search":
      return [emitWebSearchToolCall(item, corr, state, hooks)];
    case "todo_list":
      return [emitTodoCheckpoint(item, corr, state)];
    case "reasoning":
      // Reasoning trace is a top-level kind now; emit on `started` so the
      // watchdog sees it promptly. The matching `item.completed` carries
      // the finalized text — we prefer the completed version when both
      // arrive because it's the authoritative copy; started-only reasoning
      // (rare) still surfaces so we don't lose the signal.
      return [emitReasoning(item, corr, state)];
    case "agent_message":
      // Almost never seen on `started` in practice, but defend: emit an
      // empty assistant_delta as a placeholder so the stream shape
      // reflects the vendor's message boundary.
      return [
        {
          ...emitInTurn(corr, state),
          kind: "assistant_delta",
          text: "",
        },
      ];
    case "error":
      return [emitItemError(item, corr, state)];
    default: {
      const exhaustive: never = item;
      logger("codex-projection: unhandled item.started kind", {
        item: exhaustive,
      });
      return [];
    }
  }
}

function handleItemUpdated(
  raw: ItemUpdatedEvent,
  _corr: CorrelationState,
  _state: CodexProjectionState,
  logger: ProjectionLogger,
): AgentEvent[] {
  // In-flight updates don't map to any top-level kind. Terminal state is
  // reconstructed from `item.completed`. We log once per unique kind so a
  // future SDK change (e.g., streaming assistant text) shows up.
  logger("codex-projection: item.updated dropped (no streaming-update kind)", {
    itemType: raw.item.type,
  });
  return [];
}

function handleItemCompleted(
  raw: ItemCompletedEvent,
  corr: CorrelationState,
  state: CodexProjectionState,
  logger: ProjectionLogger,
  hooks: CodexProjectionHooks,
): AgentEvent[] {
  const item = raw.item;
  switch (item.type) {
    case "agent_message":
      return [emitAgentMessage(item, corr, state)];
    case "reasoning":
      return [emitReasoning(item, corr, state)];
    case "command_execution":
      return emitCommandToolResult(item, corr, state, hooks);
    case "file_change":
      return emitFileChangeResult(item, corr, state, hooks);
    case "mcp_tool_call":
      return emitMcpToolResult(item, corr, state, hooks);
    case "web_search":
      return emitWebSearchResult(item, corr, state, hooks);
    case "todo_list":
      return [emitTodoCheckpoint(item, corr, state)];
    case "error":
      return [emitItemError(item, corr, state)];
    default: {
      const exhaustive: never = item;
      logger("codex-projection: unhandled item.completed kind", {
        item: exhaustive,
      });
      return [];
    }
  }
}

// ---------------------------------------------------------------------------
// Emitters — each returns exactly one AgentEvent and registers tool-call
// parentage where relevant. Kept small so the switch above reads like a
// table of contents.
// ---------------------------------------------------------------------------

function rememberToolCall(
  state: CodexProjectionState,
  itemId: string,
  toolCallId: ToolCallId,
  eventId: EventId,
  corr: CorrelationState,
): void {
  state.toolCallByItemId.set(itemId, { toolCallId, eventId });
  // Also thread it through CorrelationState so `parentForToolResult`
  // keeps working for code that reaches for it directly.
  corr.rememberToolCall(toolCallId, eventId);
}

function parentFor(state: CodexProjectionState, itemId: string): EventId | null {
  return state.toolCallByItemId.get(itemId)?.eventId ?? null;
}

function mintToolCallId(hooks: CodexProjectionHooks): ToolCallId {
  return hooks.newToolCallId ? hooks.newToolCallId() : newToolCallId();
}

function toolCallIdFor(
  state: CodexProjectionState,
  itemId: string,
  hooks: CodexProjectionHooks,
): ToolCallId {
  const existing = state.toolCallByItemId.get(itemId);
  // If `item.completed` arrives without a prior `item.started`, synthesize
  // a fresh tool-call id so the downstream schema still validates. The
  // real emission path always goes started → completed, so this branch is
  // defensive, not hot.
  return existing?.toolCallId ?? mintToolCallId(hooks);
}

function emitCommandToolCall(
  item: CommandExecutionItem,
  corr: CorrelationState,
  state: CodexProjectionState,
  hooks: CodexProjectionHooks,
): AgentEvent {
  const toolCallId = mintToolCallId(hooks);
  const envelope = emitInTurn(corr, state);
  rememberToolCall(state, item.id, toolCallId, envelope.eventId as EventId, corr);
  return {
    ...envelope,
    kind: "tool_call",
    toolCallId,
    tool: "shell",
    args: { command: item.command },
  };
}

function emitCommandToolResult(
  item: CommandExecutionItem,
  corr: CorrelationState,
  state: CodexProjectionState,
  hooks: CodexProjectionHooks,
): AgentEvent[] {
  const toolCallId = toolCallIdFor(state, item.id, hooks);
  const parent = parentFor(state, item.id);
  const text = item.aggregated_output ?? "";
  const ok = item.status === "completed";
  const envelope = emitInTurn(corr, state, { parentEventId: parent });
  return [
    {
      ...envelope,
      kind: "tool_result",
      toolCallId,
      ok,
      summary: text.slice(0, 500),
      bytes: Buffer.byteLength(text),
    },
  ];
}

function emitFileChangeToolCall(
  item: FileChangeItem,
  corr: CorrelationState,
  state: CodexProjectionState,
  hooks: CodexProjectionHooks,
): AgentEvent {
  const toolCallId = mintToolCallId(hooks);
  const envelope = emitInTurn(corr, state);
  rememberToolCall(state, item.id, toolCallId, envelope.eventId as EventId, corr);
  return {
    ...envelope,
    kind: "tool_call",
    toolCallId,
    tool: "apply_patch",
    args: { changes: item.changes },
  };
}

function emitFileChangeResult(
  item: FileChangeItem,
  corr: CorrelationState,
  state: CodexProjectionState,
  hooks: CodexProjectionHooks,
): AgentEvent[] {
  const toolCallId = toolCallIdFor(state, item.id, hooks);
  const parent = parentFor(state, item.id);
  const ok = item.status === "completed";
  const files = (item.changes ?? []).map((c) => c.path);
  const summary = files.join(", ");

  const events: AgentEvent[] = [];
  events.push({
    ...emitInTurn(corr, state, { parentEventId: parent }),
    kind: "tool_result",
    toolCallId,
    ok,
    summary: summary.slice(0, 500),
    bytes: Buffer.byteLength(summary),
  });
  if (ok && files.length > 0) {
    events.push({
      ...emitInTurn(corr, state, { parentEventId: parent }),
      kind: "patch_applied",
      files,
      // Codex's `file_change` item doesn't carry line stats; a future
      // adapter upgrade could compute them by diffing the worktree in the
      // permission handler and storing the count here. For now 0/0 is the
      // honest value — the contract suite's `patch-metadata` scenario
      // only asserts `add` and `del` are numbers (it does not require > 0).
      stats: { add: 0, del: 0 },
    });
  }
  return events;
}

function emitMcpToolCall(
  item: McpToolCallItem,
  corr: CorrelationState,
  state: CodexProjectionState,
  hooks: CodexProjectionHooks,
): AgentEvent {
  const toolCallId = mintToolCallId(hooks);
  const envelope = emitInTurn(corr, state);
  rememberToolCall(state, item.id, toolCallId, envelope.eventId as EventId, corr);
  return {
    ...envelope,
    kind: "tool_call",
    toolCallId,
    tool: `mcp:${item.server}.${item.tool}`,
    args: item.arguments,
  };
}

function emitMcpToolResult(
  item: McpToolCallItem,
  corr: CorrelationState,
  state: CodexProjectionState,
  hooks: CodexProjectionHooks,
): AgentEvent[] {
  const toolCallId = toolCallIdFor(state, item.id, hooks);
  const parent = parentFor(state, item.id);
  const ok = item.status === "completed";
  const payload = ok ? item.result : item.error;
  const summary = JSON.stringify(payload ?? {}).slice(0, 500);
  return [
    {
      ...emitInTurn(corr, state, { parentEventId: parent }),
      kind: "tool_result",
      toolCallId,
      ok,
      summary,
      bytes: Buffer.byteLength(summary),
    },
  ];
}

function emitWebSearchToolCall(
  item: WebSearchItem,
  corr: CorrelationState,
  state: CodexProjectionState,
  hooks: CodexProjectionHooks,
): AgentEvent {
  const toolCallId = mintToolCallId(hooks);
  const envelope = emitInTurn(corr, state);
  rememberToolCall(state, item.id, toolCallId, envelope.eventId as EventId, corr);
  return {
    ...envelope,
    kind: "tool_call",
    toolCallId,
    tool: "web_search",
    args: { query: item.query },
  };
}

function emitWebSearchResult(
  item: WebSearchItem,
  corr: CorrelationState,
  state: CodexProjectionState,
  hooks: CodexProjectionHooks,
): AgentEvent[] {
  const toolCallId = toolCallIdFor(state, item.id, hooks);
  const parent = parentFor(state, item.id);
  const summary = `web_search: ${item.query ?? ""}`;
  return [
    {
      ...emitInTurn(corr, state, { parentEventId: parent }),
      kind: "tool_result",
      toolCallId,
      ok: true,
      summary: summary.slice(0, 500),
      bytes: Buffer.byteLength(summary),
    },
  ];
}

function emitTodoCheckpoint(
  item: TodoListItem,
  corr: CorrelationState,
  state: CodexProjectionState,
): AgentEvent {
  const summary = (item.items ?? [])
    .map((it) => `[${it.completed ? "x" : " "}] ${it.text}`)
    .join("\n");
  return {
    ...emitInTurn(corr, state),
    kind: "checkpoint",
    summary,
  };
}

function emitAgentMessage(
  item: AgentMessageItem,
  corr: CorrelationState,
  state: CodexProjectionState,
): AgentEvent {
  return {
    ...emitInTurn(corr, state),
    kind: "assistant_message",
    text: item.text ?? "",
    // Codex doesn't surface a stop_reason on agent_message; "end_turn"
    // matches the Claude adapter's shape so downstream consumers don't
    // have to special-case.
    stopReason: "end_turn",
  };
}

function emitReasoning(
  item: ReasoningItem,
  corr: CorrelationState,
  state: CodexProjectionState,
): AgentEvent {
  return {
    ...emitInTurn(corr, state),
    kind: "reasoning",
    text: item.text ?? "",
  };
}

function emitItemError(
  item: ErrorItem,
  corr: CorrelationState,
  state: CodexProjectionState,
): AgentEvent {
  return {
    ...emitInTurn(corr, state),
    kind: "error",
    fatal: false,
    errorCode: "item_error",
    message: item.message ?? "",
    retriable: false,
  };
}

/**
 * Map a ThreadItem to the Shamu tool name used when the projector has to
 * fabricate one (e.g., an orphan `item.completed` with no prior `started`).
 * Exported for unit tests that want to assert the same name is used
 * symmetrically between started + completed.
 */
export function toolNameForItem(item: ThreadItem): string {
  switch (item.type) {
    case "command_execution":
      return "shell";
    case "file_change":
      return "apply_patch";
    case "mcp_tool_call":
      return `mcp:${item.server}.${item.tool}`;
    case "web_search":
      return "web_search";
    case "todo_list":
      return "todo_list";
    case "agent_message":
      return "agent_message";
    case "reasoning":
      return "reasoning";
    case "error":
      return "error";
    default: {
      const exhaustive: never = item;
      return String(exhaustive);
    }
  }
}
