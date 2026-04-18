/**
 * Event record / replay utilities.
 *
 * Two call shapes:
 *
 * 1. `recordAdapter(handle, sink)` — subscribes to an `AgentHandle.events`
 *    iterable, writes each event as JSONL into `sink`, and re-yields the
 *    same events so a caller can still consume them. Useful to capture
 *    fixtures from a live adapter.
 *
 * 2. `replayFromJsonl(readable)` — reads newline-delimited JSON from a
 *    readable source and yields parsed+validated `AgentEvent` values. The
 *    0.B spike fixtures under `docs/phase-0/event-schema-spike/fixtures/`
 *    are the canonical inputs; the contract suite uses this to assert the
 *    normalized stream still validates after any adapter refactor.
 *
 * The readable contract is `AsyncIterable<string>` — any code that yields
 * lines (text chunks split on `\n`) is accepted. Adapters that hold a file
 * path can pipe it through `jsonlLinesFromPath(path)`.
 *
 * Zod validation is STRICT by default. Fixtures that don't match the
 * schema surface as `ReplayValidationError` with the underlying issues; the
 * contract test explicitly checks the 0.B corpus passes.
 */

import { createReadStream } from "node:fs";
import type { AgentHandle } from "./adapter.ts";
import { AdapterError } from "./errors.ts";
import { type AgentEvent, agentEventSchema, safeValidateEvent } from "./events.ts";

export class ReplayValidationError extends AdapterError {
  public readonly code = "replay_validation_error" as const;
  public readonly lineNumber: number;
  public readonly rawLine: string;

  constructor(lineNumber: number, rawLine: string, cause: unknown) {
    super(
      `Replay validation failed on line ${lineNumber}: ${(cause as Error)?.message ?? cause}`,
      cause,
    );
    this.lineNumber = lineNumber;
    this.rawLine = rawLine;
  }
}

/**
 * A minimal async-iterable text source. Produces lines already split; no
 * newline in the yielded chunks. Empty lines are preserved so callers can
 * detect a trailing newline but `replayFromJsonl` skips them.
 */
export type LineSource = AsyncIterable<string>;

/**
 * Convert a file path into a line-by-line async iterable. Uses
 * `node:fs.createReadStream` so we don't load the whole file into memory.
 */
export async function* jsonlLinesFromPath(path: string): LineSource {
  const stream = createReadStream(path, { encoding: "utf8" });
  let buffer = "";
  try {
    for await (const chunk of stream) {
      buffer += chunk as string;
      let nl = buffer.indexOf("\n");
      while (nl !== -1) {
        yield buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf("\n");
      }
    }
    if (buffer.length > 0) yield buffer;
  } finally {
    stream.close();
  }
}

/**
 * A sink for `recordAdapter`. `write(line)` receives the already-
 * serialized JSONL line (no trailing newline); implementations append as
 * appropriate. Concurrent calls are serialized by the iterable's
 * back-to-back `for await` semantics — no locking needed.
 */
export interface ReplaySink {
  write(line: string): Promise<void> | void;
  close?(): Promise<void> | void;
}

/**
 * In-memory sink. Convenient for tests and for adapters that want to
 * post-process captured events before persisting.
 */
export class MemoryReplaySink implements ReplaySink {
  private readonly _lines: string[] = [];
  write(line: string): void {
    this._lines.push(line);
  }
  get lines(): readonly string[] {
    return this._lines;
  }
  /** Convenience: parse and return the captured events. */
  async replay(): Promise<AgentEvent[]> {
    const events: AgentEvent[] = [];
    for await (const ev of replayFromJsonl(toLineSource(this._lines))) {
      events.push(ev);
    }
    return events;
  }
}

async function* toLineSource(lines: readonly string[]): LineSource {
  for (const line of lines) yield line;
}

/**
 * Wrap an `AgentHandle`'s event stream with a replay sink. Returns a fresh
 * async iterable that yields the same events; every event is also serialized
 * and forwarded to `sink.write` before being re-yielded to the caller. If
 * the sink's write rejects, the error propagates to the consumer — i.e.,
 * recording failures are not silently swallowed.
 */
export async function* recordAdapter(
  handle: Pick<AgentHandle, "events">,
  sink: ReplaySink,
): AsyncIterable<AgentEvent> {
  for await (const event of handle.events) {
    const line = JSON.stringify(event);
    await sink.write(line);
    yield event;
  }
  if (typeof sink.close === "function") await sink.close();
}

/**
 * Iterate a line source, parse each non-empty line as JSON, and validate
 * against the shared `AgentEvent` schema. Throws `ReplayValidationError` at
 * the first line that fails — callers who want best-effort replay can wrap
 * with `safeReplayFromJsonl`.
 */
export async function* replayFromJsonl(source: LineSource): AsyncIterable<AgentEvent> {
  let lineNumber = 0;
  for await (const raw of source) {
    lineNumber += 1;
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (cause) {
      throw new ReplayValidationError(lineNumber, raw, cause);
    }
    const result = safeValidateEvent(parsed);
    if (!result.ok) {
      throw new ReplayValidationError(lineNumber, raw, result.error);
    }
    yield result.value;
  }
}

/**
 * Best-effort variant: skips invalid lines and returns both the valid
 * events and the collected errors. Useful for importing historic fixtures
 * where some rows pre-date the current schema (e.g., the 0.B spike's
 * counter-based `eventId` format that doesn't match ULID today).
 */
export interface SafeReplayResult {
  readonly events: readonly AgentEvent[];
  readonly errors: readonly ReplayValidationError[];
}

export async function safeReplayFromJsonl(source: LineSource): Promise<SafeReplayResult> {
  const events: AgentEvent[] = [];
  const errors: ReplayValidationError[] = [];
  let lineNumber = 0;
  for await (const raw of source) {
    lineNumber += 1;
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (cause) {
      errors.push(new ReplayValidationError(lineNumber, raw, cause));
      continue;
    }
    const result = agentEventSchema.safeParse(parsed);
    if (!result.success) {
      errors.push(new ReplayValidationError(lineNumber, raw, result.error));
      continue;
    }
    events.push(result.data);
  }
  return { events, errors };
}
