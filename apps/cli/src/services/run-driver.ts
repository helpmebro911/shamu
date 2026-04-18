/**
 * Shared event-ingestion loop for `shamu run` + `shamu resume`.
 *
 * Both commands share the same persistence + cost-stamping shape:
 *
 * 1. Drain the handle's `events` iterator.
 * 2. Stamp every `cost` event with the core-authoritative `confidence` +
 *    `source` from the adapter's capability manifest (T17 — the adapter
 *    cannot self-certify its cost reporting).
 * 3. Persist the (post-stamp) event to `events` + `raw_events`.
 * 4. On the first non-null `sessionId`, insert a row into `sessions`.
 * 5. Render to stdout per output mode.
 * 6. Cooperatively handle SIGINT.
 * 7. Decide an exit code from terminal events.
 *
 * Keeping this in a single place means `resume` does not diverge from
 * `run` in how it stamps costs or persists session ids.
 */

import type { AgentAdapter, AgentEvent, AgentHandle } from "@shamu/adapters-base";
import { stampCostEventFromCapability } from "@shamu/adapters-base";
import { eventsQueries, type ShamuDatabase, sessionsQueries } from "@shamu/persistence";
import { eventId as brandEventId, sessionId as brandSessionId, type RunId } from "@shamu/shared";
import { ExitCode, type ExitCodeValue } from "../exit-codes.ts";
import { type OutputMode, writeDiag, writeHuman, writeJson } from "../output.ts";

export interface StreamHandleParams {
  readonly adapter: AgentAdapter;
  readonly handle: AgentHandle;
  readonly db: ShamuDatabase;
  readonly runId: RunId;
  readonly mode: OutputMode;
}

/**
 * Drive a handle to completion. Returns the exit code the caller should
 * propagate. Writes side-effect the DB and stdout.
 */
export async function streamHandle(params: StreamHandleParams): Promise<ExitCodeValue> {
  const { adapter, handle, db, runId, mode } = params;
  let interrupts = 0;
  let sawFatalError = false;
  let forced = false;
  let sessionPersisted = false;

  const onSigint = (): void => {
    interrupts += 1;
    if (interrupts === 1) {
      void handle.interrupt("sigint").catch(() => {});
    } else {
      forced = true;
    }
  };
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigint);

  try {
    for await (const raw of handle.events) {
      // T17: stamp cost events BEFORE persisting. A compromised adapter
      // that emitted `confidence: "exact"` on a subscription vendor is
      // overridden here — the persisted row reflects what CORE trusts, not
      // what the adapter claimed.
      const ev = stampCostEventFromCapability(raw, adapter.capabilities.costReporting);

      // Persist the (stamped) normalized event and a raw snapshot. Failures
      // are surfaced but not fatal — a subsequent event might still land.
      try {
        eventsQueries.insertRawEvent(db, {
          eventId: brandEventId(ev.eventId),
          runId,
          vendor: adapter.vendor,
          ts: ev.tsWall,
          payload: ev,
        });
        eventsQueries.insertEvent(db, ev);
      } catch (err) {
        writeDiag(
          `run: failed to persist event ${ev.eventId} (${ev.kind}): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }

      // Record the vendor session id the first time we see it. Later
      // appearances (same run, same session) are no-ops because
      // `insertSession` uses `INSERT OR IGNORE`.
      if (!sessionPersisted && ev.sessionId !== null) {
        try {
          sessionsQueries.insertSession(db, {
            // Brand the string-shaped id from the envelope. The schema only
            // guarantees `string`; the branded factory is a cheap cast.
            sessionId: brandSessionId(ev.sessionId),
            runId,
            vendor: adapter.vendor,
          });
          sessionPersisted = true;
        } catch (err) {
          writeDiag(
            `run: failed to persist session ${ev.sessionId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }

      writeJson(mode, ev);
      writeHuman(mode, formatEventLine(ev));

      if (ev.kind === "error" && ev.fatal) sawFatalError = true;
      if (ev.kind === "turn_end") break;
      if (forced) break;
    }
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigint);
  }

  if (interrupts > 0) return ExitCode.INTERRUPTED;
  if (sawFatalError) return ExitCode.RUN_FAILED;
  return ExitCode.OK;
}

/** Render one event to a compact human-readable line. */
export function formatEventLine(ev: AgentEvent): string {
  const head = `[${ev.seq.toString().padStart(3, "0")}] ${ev.kind}`;
  switch (ev.kind) {
    case "session_start":
      return `${head} source=${ev.source} session=${ev.sessionId ?? "-"}`;
    case "session_end":
      return `${head} reason=${ev.reason}`;
    case "reasoning":
      return `${head} ${truncate(ev.text, 120)}`;
    case "assistant_delta":
      return `${head} ${truncate(ev.text, 120)}`;
    case "assistant_message":
      return `${head} stop=${ev.stopReason} ${truncate(ev.text, 120)}`;
    case "tool_call":
      return `${head} ${ev.tool} id=${ev.toolCallId}`;
    case "tool_result":
      return `${head} ok=${ev.ok} bytes=${ev.bytes} ${truncate(ev.summary, 80)}`;
    case "permission_request":
      return `${head} decision=${ev.decision} tool=${ev.toolCallId}`;
    case "patch_applied":
      return `${head} files=${ev.files.join(",")} +${ev.stats.add}/-${ev.stats.del}`;
    case "checkpoint":
      return `${head} ${truncate(ev.summary, 120)}`;
    case "stdout":
    case "stderr":
      return `${head} ${truncate(ev.text, 120)}`;
    case "usage":
      return `${head} model=${ev.model} in=${ev.tokens.input} out=${ev.tokens.output}`;
    case "cost":
      return `${head} usd=${ev.usd ?? "null"} confidence=${ev.confidence} source=${ev.source}`;
    case "rate_limit":
      return `${head} scope=${ev.scope} status=${ev.status}`;
    case "interrupt":
      return `${head} requestedBy=${ev.requestedBy} delivered=${ev.delivered}`;
    case "turn_end":
      return `${head} stop=${ev.stopReason} duration=${ev.durationMs}ms`;
    case "error":
      return `${head} fatal=${ev.fatal} retriable=${ev.retriable} code=${ev.errorCode}: ${truncate(ev.message, 120)}`;
  }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}
