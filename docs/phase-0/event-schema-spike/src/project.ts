// Raw → normalized AgentEvent projection.
//
// Takes a vendor + raw JSONL stream and emits the draft `AgentEvent` taxonomy
// from PLAN.md § Adapter contract. The goal of this spike is NOT to be feature-
// complete; it is to measure how well the taxonomy covers real vendor output.
//
// Every raw event gets classified as one of:
//   - mapped to a core `AgentEvent.kind`
//   - DROPPED intentionally (vendor chatter that carries no behavior-affecting
//     signal — e.g. duplicate hook_started/hook_response echoes)
//   - UNMAPPED (we don't have a good home for it; counted against kill-switch)
//
// We do NOT invent an `extra` grab-bag field here; the PLAN explicitly forbids
// it. If we needed one, that would be the strongest possible signal the
// taxonomy is wrong.
//
// Usage:
//   bun src/project.ts captures/claude-bugfix-raw.jsonl claude
//   bun src/project.ts captures/codex-refactor-raw.jsonl codex

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// ---------- Draft AgentEvent types (copied from PLAN.md § Adapter contract) ----------

export type EventId = string;
export type RunId = string;
export type SessionId = string;
export type TurnId = string;
export type ToolCallId = string;

export type Tokens = {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
};
export type CacheStats = {
  hitRate: number | null;
};

export type EventEnvelope = {
  eventId: EventId;
  runId: RunId;
  sessionId: SessionId | null;
  turnId: TurnId;
  parentEventId: EventId | null;
  seq: number;
  tsMonotonic: number;
  tsWall: number;
  vendor: string;
  rawRef: { vendorRawId: string; offset: number } | null;
};

export type AgentEvent = EventEnvelope & (
  | { kind: "session_start"; source: "spawn" | "resume" | "fork" }
  | { kind: "session_end"; reason: string }
  | { kind: "assistant_delta"; text: string }
  | { kind: "assistant_message"; text: string; stopReason: string }
  | { kind: "tool_call"; toolCallId: ToolCallId; tool: string; args: unknown }
  | {
      kind: "tool_result";
      toolCallId: ToolCallId;
      ok: boolean;
      summary: string;
      bytes: number;
    }
  | {
      kind: "permission_request";
      toolCallId: ToolCallId;
      decision: "pending" | "allow" | "deny" | "ask";
    }
  | { kind: "patch_applied"; files: string[]; stats: { add: number; del: number } }
  | { kind: "checkpoint"; summary: string }
  | { kind: "stdout"; text: string }
  | { kind: "stderr"; text: string }
  | { kind: "usage"; model: string; tokens: Tokens; cache: CacheStats }
  | {
      kind: "cost";
      usd: number | null;
      confidence: "exact" | "estimate" | "unknown";
      source: string;
    }
  | {
      kind: "interrupt";
      requestedBy: "user" | "supervisor" | "watchdog" | "flow";
      delivered: boolean;
    }
  | { kind: "turn_end"; stopReason: string; durationMs: number }
  | { kind: "error"; fatal: boolean; code: string; message: string; retriable: boolean }
);

// ---------- Gap log ----------

export type GapEntry = {
  vendor: string;
  rawKind: string;
  shamuKind: AgentEvent["kind"] | "UNMAPPED" | "DROPPED";
  notes: string;
  count: number;
};

// ---------- Deterministic ID generation ----------
// For regression tests we need byte-identical projections, so we avoid ULIDs
// here and use a stable counter-based scheme.

function makeIdFactory(prefix: string) {
  let n = 0;
  return () => `${prefix}${String(++n).padStart(6, "0")}`;
}

// ---------- Shared helpers ----------

function envelopeBase(
  vendor: string,
  runId: RunId,
  sessionId: SessionId | null,
  turnId: TurnId,
  seq: number,
  eventId: EventId,
  parentEventId: EventId | null,
  tsMonotonic: number,
  tsWall: number,
  offset: number,
  rawId: string,
): EventEnvelope {
  return {
    eventId,
    runId,
    sessionId,
    turnId,
    parentEventId,
    seq,
    tsMonotonic,
    tsWall,
    vendor,
    rawRef: { vendorRawId: rawId, offset },
  };
}

// ---------- Claude projector ----------

type ClaudeRaw = any;

function projectClaude(runId: RunId, rawLines: string[]): {
  events: AgentEvent[];
  gaps: GapEntry[];
} {
  const nextEventId = makeIdFactory("evt_");
  const events: AgentEvent[] = [];
  const gaps: GapEntry[] = [];

  // Deterministic wall-clock anchor, so replays are byte-identical even when
  // the raw stream doesn't carry timestamps. Monotonic is the offset index;
  // wall is anchor + seq * 1ms.
  const anchor = Date.parse("2026-04-17T00:00:00Z");
  let seq = 0;
  let sessionId: SessionId | null = null;
  let turnCounter = 0;
  let turnId: TurnId = `turn_${String(++turnCounter).padStart(6, "0")}`;
  const toolCallIdToEvent = new Map<string, EventId>();
  const turnStartMs: number[] = [];
  let sessionStarted = false;

  const pushGap = (rawKind: string, shamuKind: GapEntry["shamuKind"], notes: string) => {
    const existing = gaps.find(
      (g) => g.rawKind === rawKind && g.shamuKind === shamuKind && g.notes === notes,
    );
    if (existing) existing.count += 1;
    else gaps.push({ vendor: "claude", rawKind, shamuKind, notes, count: 1 });
  };

  const emit = (
    payload: Record<string, unknown>,
    offset: number,
    rawId: string,
    parent: EventId | null = null,
  ): AgentEvent => {
    const id = nextEventId();
    const envelope = envelopeBase(
      "claude",
      runId,
      sessionId,
      turnId,
      ++seq,
      id,
      parent,
      offset,
      anchor + seq,
      offset,
      rawId,
    );
    const ev = { ...envelope, ...payload } as AgentEvent;
    events.push(ev);
    return ev;
  };

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    if (!line.trim()) continue;
    let raw: ClaudeRaw;
    try {
      raw = JSON.parse(line);
    } catch {
      pushGap("<parse-error>", "UNMAPPED", "JSONL parse error");
      continue;
    }

    const type = raw.type as string;
    const subtype = raw.subtype as string | undefined;
    const rawId: string = raw.uuid ?? `${type}:${i}`;
    const compound = subtype ? `${type}:${subtype}` : type;

    if (type === "system" && subtype === "init") {
      sessionId = raw.session_id ?? null;
      if (!sessionStarted) {
        sessionStarted = true;
        emit({ kind: "session_start", source: "spawn" }, i, rawId);
      }
      turnStartMs.push(i);
      continue;
    }

    // Hook started/response: these are control-plane acknowledgements for
    // orchestrator-provided hooks. They don't change state for a vendor-neutral
    // consumer. Intentionally dropped.
    if (type === "system" && (subtype === "hook_started" || subtype === "hook_response")) {
      pushGap(
        compound,
        "DROPPED",
        "Hook acknowledgement — orchestrator-internal, no behavioral signal",
      );
      continue;
    }

    if (type === "rate_limit_event") {
      // Carries resetsAt + rateLimitType. No explicit AgentEvent kind covers
      // this. We could piggyback on `error` with fatal=false, but it isn't an
      // error. It's informational, and behavior-affecting (budget).
      pushGap(
        compound,
        "UNMAPPED",
        "Rate-limit informational — no kind for quota/budget telemetry",
      );
      continue;
    }

    if (type === "assistant") {
      const content = raw.message?.content ?? [];
      let anyEmitted = false;
      for (const c of content) {
        if (c.type === "text") {
          emit(
            {
              kind: "assistant_message",
              text: c.text ?? "",
              stopReason: raw.message?.stop_reason ?? "end_turn",
            } as any,
            i,
            rawId,
          );
          anyEmitted = true;
        } else if (c.type === "tool_use") {
          const tc = emit(
            {
              kind: "tool_call",
              toolCallId: c.id,
              tool: c.name,
              args: c.input,
            } as any,
            i,
            rawId,
          );
          toolCallIdToEvent.set(c.id, tc.eventId);
          anyEmitted = true;
        } else if (c.type === "thinking") {
          // Thinking blocks are an ambient reasoning trace. No core kind — we
          // could model as assistant_delta (streamed) but these arrive as a
          // finalized block on the assistant message, not a delta. Dropped
          // for now; this is candidate #1 for a `reasoning` kind.
          pushGap(
            "assistant.content.thinking",
            "DROPPED",
            "Reasoning trace — no `reasoning` kind in draft; consider adding",
          );
        } else {
          pushGap(
            `assistant.content.${c.type}`,
            "UNMAPPED",
            `Unknown assistant content block type: ${c.type}`,
          );
        }
      }
      if (!anyEmitted && content.length > 0) {
        // Assistant message with only non-emittable blocks (e.g. only thinking).
        // Still carries stop_reason. We emit an empty assistant_message to keep
        // ordering intact.
        emit(
          {
            kind: "assistant_message",
            text: "",
            stopReason: raw.message?.stop_reason ?? "end_turn",
          } as any,
          i,
          rawId,
        );
      }
      continue;
    }

    if (type === "user") {
      const content = raw.message?.content ?? [];
      for (const c of content) {
        if (c.type === "tool_result") {
          const parent = toolCallIdToEvent.get(c.tool_use_id) ?? null;
          const ok = c.is_error !== true;
          let summary: string;
          let bytes = 0;
          if (typeof c.content === "string") {
            summary = c.content.slice(0, 500);
            bytes = Buffer.byteLength(c.content);
          } else if (Array.isArray(c.content)) {
            const text = c.content
              .filter((x: any) => x && x.type === "text")
              .map((x: any) => x.text ?? "")
              .join("\n");
            summary = text.slice(0, 500);
            bytes = Buffer.byteLength(text);
          } else {
            summary = "";
            bytes = 0;
          }
          emit(
            {
              kind: "tool_result",
              toolCallId: c.tool_use_id,
              ok,
              summary,
              bytes,
            } as any,
            i,
            rawId,
            parent,
          );
        } else if (c.type === "text") {
          // User-role text: this is the echo of the user's own prompt (or an
          // orchestrator-injected reminder). No core kind covers it — it's
          // input, not output. Dropped; the orchestrator already knows what it
          // sent.
          pushGap(
            "user.content.text",
            "DROPPED",
            "Echo of user/orchestrator input — orchestrator already has it",
          );
        } else {
          pushGap(
            `user.content.${c.type}`,
            "UNMAPPED",
            `Unknown user content block type: ${c.type}`,
          );
        }
      }
      continue;
    }

    if (type === "result") {
      // Final turn summary. Contains duration_ms, total_cost_usd, usage.
      const durationMs = typeof raw.duration_ms === "number" ? raw.duration_ms : 0;
      const stopReason = raw.subtype ?? "success";

      if (raw.usage) {
        const u = raw.usage;
        emit(
          {
            kind: "usage",
            model: raw.model ?? "",
            tokens: {
              input: u.input_tokens ?? 0,
              output: u.output_tokens ?? 0,
              cacheRead: u.cache_read_input_tokens,
              cacheWrite: u.cache_creation_input_tokens,
            },
            cache: {
              hitRate: u.cache_read_input_tokens && u.input_tokens
                ? u.cache_read_input_tokens /
                  (u.input_tokens + u.cache_read_input_tokens)
                : null,
            },
          } as any,
          i,
          rawId,
        );
      }

      if (typeof raw.total_cost_usd === "number") {
        emit(
          {
            kind: "cost",
            usd: raw.total_cost_usd,
            confidence: "exact",
            source: "vendor",
          } as any,
          i,
          rawId,
        );
      }

      emit(
        {
          kind: "turn_end",
          stopReason,
          durationMs,
        } as any,
        i,
        rawId,
      );

      // If Claude ran for multiple turns inside one query (rare in these
      // captures), we could reset turnId here. For spike scope, one result
      // marks stream completion, so we then emit session_end.
      emit({ kind: "session_end", reason: stopReason } as any, i, rawId);
      continue;
    }

    if (type === "stream_event") {
      // SDK partial-assistant streaming tokens. The spike captures use non-
      // streaming, so these shouldn't appear — but record the gap if they do.
      pushGap(
        "stream_event",
        "UNMAPPED",
        "Partial-assistant stream — would project to assistant_delta",
      );
      continue;
    }

    pushGap(compound, "UNMAPPED", `Unhandled Claude message kind`);
  }

  return { events, gaps };
}

// ---------- Codex projector ----------

function projectCodex(runId: RunId, rawLines: string[]): {
  events: AgentEvent[];
  gaps: GapEntry[];
} {
  const nextEventId = makeIdFactory("evt_");
  const events: AgentEvent[] = [];
  const gaps: GapEntry[] = [];

  const anchor = Date.parse("2026-04-17T00:00:00Z");
  let seq = 0;
  let sessionId: SessionId | null = null;
  let turnId: TurnId = "turn_000001";
  const toolCallIdToEvent = new Map<string, EventId>();
  const commandStartedAt = new Map<string, number>();

  const pushGap = (rawKind: string, shamuKind: GapEntry["shamuKind"], notes: string) => {
    const existing = gaps.find(
      (g) => g.rawKind === rawKind && g.shamuKind === shamuKind && g.notes === notes,
    );
    if (existing) existing.count += 1;
    else gaps.push({ vendor: "codex", rawKind, shamuKind, notes, count: 1 });
  };

  const emit = (
    payload: Record<string, unknown>,
    offset: number,
    rawId: string,
    parent: EventId | null = null,
  ): AgentEvent => {
    const id = nextEventId();
    const envelope = envelopeBase(
      "codex",
      runId,
      sessionId,
      turnId,
      ++seq,
      id,
      parent,
      offset,
      anchor + seq,
      offset,
      rawId,
    );
    const ev = { ...envelope, ...payload } as AgentEvent;
    events.push(ev);
    return ev;
  };

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    if (!line.trim()) continue;
    let raw: any;
    try {
      raw = JSON.parse(line);
    } catch {
      pushGap("<parse-error>", "UNMAPPED", "JSONL parse error");
      continue;
    }
    const type = raw.type as string;
    const itemType = raw.item?.type as string | undefined;
    const rawId: string = raw.item?.id ?? `${type}:${i}`;

    if (type === "thread.started") {
      sessionId = raw.thread_id ?? null;
      emit({ kind: "session_start", source: "spawn" } as any, i, rawId);
      continue;
    }

    if (type === "turn.started") {
      // No dedicated `turn_start` kind; the taxonomy only has `turn_end`.
      // Candidate gap. For now we DROP it; turnId rotation on turn.completed.
      pushGap(
        "turn.started",
        "DROPPED",
        "No `turn_start` kind; turn scoping derived from turn.completed",
      );
      continue;
    }

    if (type === "turn.completed") {
      // usage arrives on turn.completed for Codex.
      const usage = raw.usage;
      if (usage) {
        emit(
          {
            kind: "usage",
            model: "",
            tokens: {
              input: usage.input_tokens ?? 0,
              output: usage.output_tokens ?? 0,
              cacheRead: usage.cached_input_tokens,
            },
            cache: {
              hitRate: usage.input_tokens && usage.cached_input_tokens
                ? usage.cached_input_tokens /
                  (usage.input_tokens + usage.cached_input_tokens)
                : null,
            },
          } as any,
          i,
          rawId,
        );
      }
      // Codex does not emit explicit cost. Mark as subscription/unknown.
      emit(
        {
          kind: "cost",
          usd: null,
          confidence: "unknown",
          source: "subscription",
        } as any,
        i,
        rawId,
      );

      // We don't get duration_ms from Codex; compute 0. In the real adapter we
      // would measure wall time against turn.started.
      emit({ kind: "turn_end", stopReason: "completed", durationMs: 0 } as any, i, rawId);
      // Emit session_end once the outer loop has no more events. Deferred to
      // post-loop because Codex could run multiple turns in a thread. For
      // the spike we always break the loop after turn.completed, so we emit
      // session_end here.
      emit({ kind: "session_end", reason: "completed" } as any, i, rawId);
      continue;
    }

    if (type === "turn.failed") {
      const msg = raw.error?.message ?? "unknown";
      emit(
        {
          kind: "error",
          fatal: true,
          code: "turn_failed",
          message: msg,
          retriable: false,
        } as any,
        i,
        rawId,
      );
      emit({ kind: "turn_end", stopReason: "failed", durationMs: 0 } as any, i, rawId);
      emit({ kind: "session_end", reason: "failed" } as any, i, rawId);
      continue;
    }

    if (type === "error") {
      emit(
        {
          kind: "error",
          fatal: true,
          code: "stream_error",
          message: raw.message ?? "unknown",
          retriable: false,
        } as any,
        i,
        rawId,
      );
      continue;
    }

    if (type === "item.started") {
      if (itemType === "command_execution") {
        commandStartedAt.set(raw.item.id, i);
        const tc = emit(
          {
            kind: "tool_call",
            toolCallId: raw.item.id,
            tool: "Bash",
            args: { command: raw.item.command },
          } as any,
          i,
          rawId,
        );
        toolCallIdToEvent.set(raw.item.id, tc.eventId);
      } else if (itemType === "file_change") {
        // Codex emits the patch as a single item: both a tool_call (the
        // intent) and later a tool_result + patch_applied on completed.
        const tc = emit(
          {
            kind: "tool_call",
            toolCallId: raw.item.id,
            tool: "apply_patch",
            args: { changes: raw.item.changes },
          } as any,
          i,
          rawId,
        );
        toolCallIdToEvent.set(raw.item.id, tc.eventId);
      } else if (itemType === "mcp_tool_call") {
        const tc = emit(
          {
            kind: "tool_call",
            toolCallId: raw.item.id,
            tool: `mcp:${raw.item.server}.${raw.item.tool}`,
            args: raw.item.arguments,
          } as any,
          i,
          rawId,
        );
        toolCallIdToEvent.set(raw.item.id, tc.eventId);
      } else if (itemType === "web_search") {
        const tc = emit(
          {
            kind: "tool_call",
            toolCallId: raw.item.id,
            tool: "web_search",
            args: { query: raw.item.query },
          } as any,
          i,
          rawId,
        );
        toolCallIdToEvent.set(raw.item.id, tc.eventId);
      } else if (itemType === "todo_list") {
        // Codex plan / to-do item. No dedicated kind. We model it as a
        // `checkpoint` whose summary is the plan text; this is a stretch.
        const summary = (raw.item.items ?? [])
          .map((it: any) => `[${it.completed ? "x" : " "}] ${it.text}`)
          .join("\n");
        emit({ kind: "checkpoint", summary } as any, i, rawId);
      } else if (itemType === "reasoning") {
        pushGap(
          `item.started:${itemType}`,
          "DROPPED",
          "Reasoning trace — no `reasoning` kind; candidate for addition",
        );
      } else if (itemType === "agent_message") {
        // Usually not seen as started — only as completed. But handle it.
        pushGap(
          `item.started:${itemType}`,
          "DROPPED",
          "agent_message rarely starts before completing; use item.completed",
        );
      } else if (itemType === "error") {
        emit(
          {
            kind: "error",
            fatal: false,
            code: "item_error",
            message: raw.item.message ?? "",
            retriable: false,
          } as any,
          i,
          rawId,
        );
      } else {
        pushGap(
          `item.started:${itemType ?? "unknown"}`,
          "UNMAPPED",
          `Unhandled Codex item type on start`,
        );
      }
      continue;
    }

    if (type === "item.updated") {
      // Updates of a running item: progress, streaming output chunks, etc.
      // For the spike captures these don't appear often; when they do for a
      // command_execution they carry aggregated_output so far. No core kind
      // covers a typed update-in-place; we DROP and note.
      if (itemType === "command_execution" || itemType === "todo_list") {
        pushGap(
          `item.updated:${itemType}`,
          "DROPPED",
          "In-flight update — no streaming-update kind; terminal state reconstructed from item.completed",
        );
      } else {
        pushGap(
          `item.updated:${itemType ?? "unknown"}`,
          "DROPPED",
          "item.updated — dropped",
        );
      }
      continue;
    }

    if (type === "item.completed") {
      if (itemType === "agent_message") {
        emit(
          {
            kind: "assistant_message",
            text: raw.item.text ?? "",
            stopReason: "end_turn",
          } as any,
          i,
          rawId,
        );
      } else if (itemType === "reasoning") {
        pushGap(
          `item.completed:${itemType}`,
          "DROPPED",
          "Reasoning trace completed — no `reasoning` kind; candidate for addition",
        );
      } else if (itemType === "command_execution") {
        const parent = toolCallIdToEvent.get(raw.item.id) ?? null;
        const ok = raw.item.status === "completed";
        const text = raw.item.aggregated_output ?? "";
        emit(
          {
            kind: "tool_result",
            toolCallId: raw.item.id,
            ok,
            summary: text.slice(0, 500),
            bytes: Buffer.byteLength(text),
          } as any,
          i,
          rawId,
          parent,
        );
      } else if (itemType === "file_change") {
        const parent = toolCallIdToEvent.get(raw.item.id) ?? null;
        const ok = raw.item.status === "completed";
        const files = (raw.item.changes ?? []).map((c: any) => c.path);
        const summary = files.join(", ");
        emit(
          {
            kind: "tool_result",
            toolCallId: raw.item.id,
            ok,
            summary: summary.slice(0, 500),
            bytes: Buffer.byteLength(summary),
          } as any,
          i,
          rawId,
          parent,
        );
        if (ok) {
          // Codex doesn't report line stats. We emit patch_applied with 0/0
          // and note the gap — a real adapter would compute from the diff.
          emit(
            {
              kind: "patch_applied",
              files,
              stats: { add: 0, del: 0 },
            } as any,
            i,
            rawId,
            parent,
          );
        }
      } else if (itemType === "mcp_tool_call") {
        const parent = toolCallIdToEvent.get(raw.item.id) ?? null;
        const ok = raw.item.status === "completed";
        const summary = JSON.stringify(raw.item.result ?? raw.item.error ?? {}).slice(0, 500);
        emit(
          {
            kind: "tool_result",
            toolCallId: raw.item.id,
            ok,
            summary,
            bytes: Buffer.byteLength(summary),
          } as any,
          i,
          rawId,
          parent,
        );
      } else if (itemType === "web_search") {
        const parent = toolCallIdToEvent.get(raw.item.id) ?? null;
        emit(
          {
            kind: "tool_result",
            toolCallId: raw.item.id,
            ok: true,
            summary: `web_search: ${raw.item.query ?? ""}`,
            bytes: 0,
          } as any,
          i,
          rawId,
          parent,
        );
      } else if (itemType === "todo_list") {
        const summary = (raw.item.items ?? [])
          .map((it: any) => `[${it.completed ? "x" : " "}] ${it.text}`)
          .join("\n");
        emit({ kind: "checkpoint", summary } as any, i, rawId);
      } else if (itemType === "error") {
        emit(
          {
            kind: "error",
            fatal: false,
            code: "item_error",
            message: raw.item.message ?? "",
            retriable: false,
          } as any,
          i,
          rawId,
        );
      } else {
        pushGap(
          `item.completed:${itemType ?? "unknown"}`,
          "UNMAPPED",
          "Unhandled Codex item type on complete",
        );
      }
      continue;
    }

    pushGap(type, "UNMAPPED", "Unhandled Codex top-level event");
  }

  return { events, gaps };
}

// ---------- CLI entry ----------

export async function projectFile(
  rawPath: string,
  vendor: "claude" | "codex",
  runId: RunId = "run_spike_001",
) {
  const raw = await readFile(rawPath, "utf-8");
  const lines = raw.split("\n");
  if (vendor === "claude") return projectClaude(runId, lines);
  return projectCodex(runId, lines);
}

async function main() {
  const [rawPath, vendor] = process.argv.slice(2);
  if (!rawPath || !vendor) {
    console.error("Usage: bun src/project.ts <raw.jsonl> <claude|codex>");
    process.exit(1);
  }
  const { events, gaps } = await projectFile(
    rawPath,
    vendor as "claude" | "codex",
  );
  const outBase = rawPath.replace(/-raw\.jsonl$/, "");
  const projectedPath = `${outBase}-projected.jsonl`;
  const gapsPath = `${outBase}-gaps.json`;
  await writeFile(
    projectedPath,
    events.map((e) => JSON.stringify(e)).join("\n") + "\n",
  );
  await writeFile(gapsPath, JSON.stringify(gaps, null, 2) + "\n");

  const totalRaw = (await readFile(rawPath, "utf-8")).trim().split("\n").filter(Boolean)
    .length;
  const unmapped = gaps
    .filter((g) => g.shamuKind === "UNMAPPED")
    .reduce((a, b) => a + b.count, 0);
  const dropped = gaps
    .filter((g) => g.shamuKind === "DROPPED")
    .reduce((a, b) => a + b.count, 0);

  console.log(
    `[${vendor}/${path.basename(rawPath)}] raw=${totalRaw} projected=${events.length} unmapped=${unmapped} dropped=${dropped}`,
  );
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
