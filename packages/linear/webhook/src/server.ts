/**
 * Bun HTTP server exposing `/webhooks/linear`.
 *
 * Surface:
 *
 *   POST /webhooks/linear
 *     - signature-verified via HMAC-SHA256 against the per-webhook secret
 *     - body parsed into a typed `LinearEvent` union
 *     - surfaced to consumers via an async iterator on the returned handle
 *     - invalid signature -> 401
 *     - stale timestamp / duplicate nonce -> 401
 *     - malformed body (bad JSON, wrong shape) -> 400
 *     - unsupported event type (e.g. Project-update) -> 202 (accepted, not
 *       surfaced — Linear fires everything subscribed)
 *
 *   GET /webhooks/linear
 *     - 200 {"status":"ok"} — health check. Documented so operators can
 *       validate the tunnel is wired before Linear starts delivering.
 *
 *   everything else
 *     - 404. Enforces the G10 scope (only the webhook path is reachable).
 *
 * Consumer API: the returned `WebhookServerHandle` exposes `events`, an async
 * iterable of `LinearEvent`. Back-pressure: the iterator buffers unbounded;
 * Phase 6.C wires this into the supervisor bus, which performs its own
 * bounded fan-out. If Phase 6.C decides it wants a callback-shaped API
 * instead, we add it as a thin shim over `events` — see the writeup for the
 * tradeoff analysis.
 *
 * Secrets are never logged. The logger is expected to be a `@shamu/shared`
 * `Logger` (or compatible); redacting is the caller's responsibility via
 * child contexts that exclude secret fields.
 */

import { createLogger, type Logger } from "@shamu/shared";
import type { LinearEvent } from "./events.ts";
import { parseLinearEvent } from "./events.ts";
import {
  DEFAULT_TIMESTAMP_SKEW_MS,
  NonceCache,
  type NonceCacheOptions,
  type VerifyRejectionReason,
  verifyLinearRequest,
} from "./verify.ts";

/** Default port matches HANDOFF + PLAN references: 7357 (`LEET`ish for Linear). */
export const DEFAULT_PORT = 7357;
export const DEFAULT_HOST = "127.0.0.1";
export const WEBHOOK_PATH = "/webhooks/linear";

/** Env var keys — callers can also pass values in-process via opts. */
export const ENV_PORT = "SHAMU_LINEAR_WEBHOOK_PORT";
export const ENV_HOST = "SHAMU_LINEAR_WEBHOOK_HOST";

export interface WebhookServerOptions {
  /** Per-webhook signing secret (required). Never logged. */
  readonly secret: string;
  /** Listen port. Env `SHAMU_LINEAR_WEBHOOK_PORT` then {@link DEFAULT_PORT}. */
  readonly port?: number;
  /** Listen host. Env `SHAMU_LINEAR_WEBHOOK_HOST` then {@link DEFAULT_HOST}. */
  readonly host?: string;
  /** Allowed timestamp skew in ms. Default {@link DEFAULT_TIMESTAMP_SKEW_MS}. */
  readonly timestampSkewMs?: number;
  /** Nonce-cache tuning (see {@link NonceCacheOptions}). */
  readonly nonceCache?: NonceCacheOptions;
  /** Injected logger. Default: new `@shamu/shared` Logger. */
  readonly logger?: Logger;
  /** Override for `Date.now` in tests. */
  readonly now?: () => number;
}

export interface WebhookServerHandle {
  /** Actual port the server bound to (useful when port:0 was requested). */
  readonly port: number;
  readonly host: string;
  /** Async iterable of typed events surfaced by the handler. */
  readonly events: AsyncIterable<LinearEvent>;
  /** Stop listening and settle the async iterator. */
  stop(): Promise<void>;
  /**
   * Fetch handler — exposed for test harnesses that want to drive requests
   * without an actual socket. The server uses this internally via Bun.serve.
   */
  readonly fetch: (req: Request) => Promise<Response>;
}

interface EventSink {
  push(event: LinearEvent): void;
  close(): void;
  iterable(): AsyncIterable<LinearEvent>;
}

/** Simple unbounded FIFO sink that resolves pending pulls when fed. */
function createEventSink(): EventSink {
  const buffer: LinearEvent[] = [];
  const pending: Array<(next: IteratorResult<LinearEvent>) => void> = [];
  let closed = false;

  const iterable: AsyncIterable<LinearEvent> = {
    [Symbol.asyncIterator](): AsyncIterator<LinearEvent> {
      return {
        next(): Promise<IteratorResult<LinearEvent>> {
          if (buffer.length > 0) {
            const value = buffer.shift() as LinearEvent;
            return Promise.resolve({ value, done: false });
          }
          if (closed) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => {
            pending.push(resolve);
          });
        },
        return(): Promise<IteratorResult<LinearEvent>> {
          closed = true;
          while (pending.length > 0) {
            const resolve = pending.shift();
            if (resolve) resolve({ value: undefined, done: true });
          }
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };

  return {
    push(event: LinearEvent): void {
      if (closed) return;
      const waiter = pending.shift();
      if (waiter) {
        waiter({ value: event, done: false });
        return;
      }
      buffer.push(event);
    },
    close(): void {
      if (closed) return;
      closed = true;
      while (pending.length > 0) {
        const resolve = pending.shift();
        if (resolve) resolve({ value: undefined, done: true });
      }
    },
    iterable(): AsyncIterable<LinearEvent> {
      return iterable;
    },
  };
}

function normaliseHeaders(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

function rejectStatus(reason: VerifyRejectionReason): number {
  switch (reason) {
    case "missing_header":
    case "invalid_signature":
    case "stale_timestamp":
    case "duplicate_nonce":
      return 401;
    case "malformed":
      return 400;
  }
}

/**
 * Build a fetch handler without binding a socket. `createWebhookServer` wraps
 * this in a Bun.serve instance; tests can drive it directly.
 */
export function buildFetchHandler(opts: WebhookServerOptions): {
  fetch: (req: Request) => Promise<Response>;
  events: AsyncIterable<LinearEvent>;
  close: () => void;
} {
  if (typeof opts.secret !== "string" || opts.secret.length === 0) {
    throw new Error("WebhookServer: 'secret' is required");
  }
  const logger = opts.logger ?? createLogger({ context: { component: "linear-webhook" } });
  const nonceCache = new NonceCache(opts.nonceCache ?? {});
  const sink = createEventSink();

  const fetch = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (url.pathname !== WEBHOOK_PATH) {
      return new Response("not found", { status: 404 });
    }
    if (req.method === "GET") {
      return new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (req.method !== "POST") {
      return new Response("method not allowed", {
        status: 405,
        headers: { allow: "GET, POST" },
      });
    }

    // Read the exact bytes BEFORE any JSON parse — signature verify depends
    // on them being byte-identical to what Linear sent.
    const raw = new Uint8Array(await req.arrayBuffer());
    const headers = normaliseHeaders(req);

    const verifyOpts = {
      secret: opts.secret,
      rawBody: raw,
      headers,
      nonceCache,
      ...(opts.timestampSkewMs !== undefined ? { timestampSkewMs: opts.timestampSkewMs } : {}),
      ...(opts.now !== undefined ? { now: opts.now } : {}),
    } as const;
    const verified = verifyLinearRequest(verifyOpts);
    if (!verified.ok) {
      logger.warn("linear webhook rejected", {
        reason: verified.reason,
        detail: verified.detail,
      });
      return new Response(verified.reason, { status: rejectStatus(verified.reason) });
    }

    const bodyText = new TextDecoder("utf-8").decode(raw);
    const parsed = parseLinearEvent(bodyText);
    if (!parsed.ok) {
      if (parsed.reason === "unsupported_event") {
        // Linear subscriptions are set at webhook-registration time; if
        // something unexpected arrives we accept it (so Linear doesn't
        // retry) but don't surface it to consumers.
        logger.info("linear webhook ignored (unsupported)", {
          detail: parsed.detail,
          webhookId: verified.webhookId,
        });
        return new Response("accepted", { status: 202 });
      }
      logger.warn("linear webhook body rejected", {
        reason: parsed.reason,
        detail: parsed.detail,
      });
      return new Response(parsed.reason, { status: 400 });
    }

    sink.push(parsed.event);
    logger.info("linear webhook accepted", {
      kind: parsed.event.kind,
      webhookId: parsed.event.webhookId,
    });
    return new Response("ok", { status: 200 });
  };

  return {
    fetch,
    events: sink.iterable(),
    close: () => sink.close(),
  };
}

/** The concrete Bun server type we rely on; narrow to what we use. */
interface BunServerLike {
  readonly port: number;
  readonly hostname: string;
  stop(closeActiveConnections?: boolean): void | Promise<void>;
}

type BunServe = (options: {
  port?: number;
  hostname?: string;
  fetch: (req: Request) => Promise<Response> | Response;
}) => BunServerLike;

function getBunServe(): BunServe {
  const g = globalThis as unknown as { Bun?: { serve?: BunServe } };
  if (!g.Bun || typeof g.Bun.serve !== "function") {
    throw new Error(
      "createWebhookServer requires Bun; tests that run under Vitest should use buildFetchHandler instead",
    );
  }
  return g.Bun.serve;
}

/**
 * Start a Bun HTTP server bound to the configured host/port. Port + host may
 * be overridden via env (`SHAMU_LINEAR_WEBHOOK_PORT` / `..._HOST`).
 *
 * Throws when Bun is not the runtime (e.g. under Vitest). Tests that want
 * the in-memory handler should call {@link buildFetchHandler} directly.
 */
export function createWebhookServer(opts: WebhookServerOptions): WebhookServerHandle {
  const handler = buildFetchHandler(opts);
  const port = resolvePort(opts);
  const host = resolveHost(opts);
  const serve = getBunServe();
  const server = serve({ port, hostname: host, fetch: handler.fetch });

  return {
    port: server.port,
    host: server.hostname,
    events: handler.events,
    fetch: handler.fetch,
    async stop(): Promise<void> {
      handler.close();
      const maybe = server.stop(true);
      if (maybe instanceof Promise) await maybe;
    },
  };
}

function resolvePort(opts: WebhookServerOptions): number {
  if (opts.port !== undefined) return opts.port;
  const raw = process.env[ENV_PORT];
  if (raw !== undefined) {
    const n = Number.parseInt(raw, 10);
    if (!Number.isNaN(n) && n >= 0) return n;
  }
  return DEFAULT_PORT;
}

function resolveHost(opts: WebhookServerOptions): string {
  if (opts.host !== undefined) return opts.host;
  const raw = process.env[ENV_HOST];
  if (raw && raw.length > 0) return raw;
  return DEFAULT_HOST;
}
