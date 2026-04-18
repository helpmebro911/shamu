/**
 * Signature verification for Linear webhooks.
 *
 * Three layers of defence, each independently testable:
 *
 *   1. **HMAC-SHA256 signature** over the raw body bytes, compared in
 *      constant time against the hex-encoded `Linear-Signature` header.
 *   2. **Timestamp window** (default +/- 5 min) against the envelope's
 *      `webhookTimestamp` field. Linear does NOT ship a timestamp header; the
 *      millisecond epoch lives inside the JSON payload. We therefore
 *      pre-parse the body to extract it BEFORE running the main event parser.
 *   3. **Nonce cache** keyed on `webhookId`, bounded both by size (LRU
 *      eviction) and by a rolling wall-clock window (default 10 min) so
 *      Linear's occasional replay-of-recent-deliveries is absorbed without
 *      re-processing.
 *
 * Each rejection returns a typed discriminant so the server can log + HTTP
 * status-map without stringly-typed branching.
 *
 * Reusing Node's `node:crypto` here — Bun exposes the same API surface, and
 * `timingSafeEqual` is available on both. We prefer this over WebCrypto's
 * subtle-crypto because the Node API is synchronous, which keeps the signal-
 * handling path simple and avoids pulling an `await` into the request
 * handler's hot path.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

// --- Rejection discriminant -------------------------------------------------

export type VerifyRejectionReason =
  | "missing_header"
  | "invalid_signature"
  | "stale_timestamp"
  | "duplicate_nonce"
  | "malformed";

export interface VerifyOk {
  readonly ok: true;
  /** The parsed envelope's monotonic ms timestamp, exposed for logging. */
  readonly webhookTimestamp: number;
  /** The parsed envelope's unique delivery id. */
  readonly webhookId: string;
}

export interface VerifyErr {
  readonly ok: false;
  readonly reason: VerifyRejectionReason;
  readonly detail: string;
}

export type VerifyResult = VerifyOk | VerifyErr;

// --- Nonce cache ------------------------------------------------------------

export interface NonceCacheOptions {
  /** Max entries retained (LRU eviction). Default 10_000. */
  readonly maxEntries?: number;
  /** Rolling window in ms. Entries older than this are purged on insert. Default 10 min. */
  readonly windowMs?: number;
  /** Override for `Date.now` in tests. */
  readonly now?: () => number;
}

/**
 * LRU + time-windowed nonce cache. `has(id)` returns true iff the id was seen
 * within the window; `remember(id)` records it and evicts expired / overflow
 * entries.
 *
 * We store entries in a `Map` keyed by id; insertion order doubles as
 * recency, which matches Map's iteration contract and mirrors the pattern
 * used in `@shamu/mailbox`'s lease cache.
 */
export class NonceCache {
  private readonly maxEntries: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly store = new Map<string, number>();

  constructor(opts: NonceCacheOptions = {}) {
    this.maxEntries = opts.maxEntries ?? 10_000;
    this.windowMs = opts.windowMs ?? 10 * 60 * 1000;
    this.now = opts.now ?? Date.now;
  }

  /** True if `id` was seen within the rolling window. */
  has(id: string): boolean {
    const ts = this.store.get(id);
    if (ts === undefined) return false;
    if (this.now() - ts > this.windowMs) {
      this.store.delete(id);
      return false;
    }
    // Bump recency by re-inserting; matches LRU semantics.
    this.store.delete(id);
    this.store.set(id, ts);
    return true;
  }

  /** Record `id`. Returns true if the id was newly added. */
  remember(id: string): boolean {
    const now = this.now();
    this.evictExpired(now);
    if (this.store.has(id)) {
      // Refresh position (LRU).
      this.store.delete(id);
      this.store.set(id, now);
      return false;
    }
    this.store.set(id, now);
    while (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) break;
      this.store.delete(oldest);
    }
    return true;
  }

  /** Current entry count (after lazy purge of expired entries). */
  size(): number {
    this.evictExpired(this.now());
    return this.store.size;
  }

  /** Drop every entry. Intended for tests + flow-run boundaries. */
  reset(): void {
    this.store.clear();
  }

  private evictExpired(now: number): void {
    const cutoff = now - this.windowMs;
    for (const [id, ts] of this.store) {
      if (ts >= cutoff) break;
      this.store.delete(id);
    }
  }
}

// --- Signature primitives ---------------------------------------------------

/**
 * Compute the hex-encoded HMAC-SHA256 of `rawBody` using `secret`.
 *
 * Exposed so callers (tests, fixture generators) can sign bodies with the
 * exact same primitive the verifier compares against. `rawBody` must be the
 * exact bytes the HTTP server received — do NOT re-serialize JSON.
 */
export function computeSignature(rawBody: Uint8Array | string, secret: string): string {
  const hmac = createHmac("sha256", secret);
  if (typeof rawBody === "string") {
    hmac.update(rawBody, "utf8");
  } else {
    hmac.update(rawBody);
  }
  return hmac.digest("hex");
}

/**
 * Constant-time equality over two hex-encoded signatures. Returns false when
 * the lengths mismatch (which would make `timingSafeEqual` throw).
 */
export function safeEqualHex(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  // timingSafeEqual requires equal-length buffers. We normalise to
  // lower-case first so a caller sending upper-case hex doesn't break.
  const buf1 = Buffer.from(a.toLowerCase(), "utf8");
  const buf2 = Buffer.from(b.toLowerCase(), "utf8");
  if (buf1.length !== buf2.length) return false;
  return timingSafeEqual(buf1, buf2);
}

// --- Top-level verify -------------------------------------------------------

export interface VerifyOptions {
  /** Per-webhook signing secret. Required. */
  readonly secret: string;
  /** Raw body bytes (exact — before JSON parse). */
  readonly rawBody: Uint8Array;
  /** Request headers, lowercased keys expected. */
  readonly headers: Readonly<Record<string, string | undefined>>;
  /** Nonce cache instance (shared across requests). */
  readonly nonceCache: NonceCache;
  /** Allowed skew in ms. Default 5 minutes. */
  readonly timestampSkewMs?: number;
  /** Override `Date.now` for tests. */
  readonly now?: () => number;
}

/** Canonical lowercase header name for Linear signatures. */
export const LINEAR_SIGNATURE_HEADER = "linear-signature" as const;

/** Default +/- 5 min skew. */
export const DEFAULT_TIMESTAMP_SKEW_MS = 5 * 60 * 1000;

/**
 * Verify a signed request end-to-end. Returns a discriminated result. The
 * server maps each reason onto an HTTP status + log line; see `server.ts`.
 *
 * Order of checks (each must pass before the next runs):
 *   1. `Linear-Signature` header present.
 *   2. HMAC-SHA256 matches (constant-time).
 *   3. Body is valid JSON with `webhookTimestamp` + `webhookId`.
 *   4. `webhookTimestamp` is within +/- skew.
 *   5. `webhookId` is not a duplicate.
 */
export function verifyLinearRequest(opts: VerifyOptions): VerifyResult {
  const signature = opts.headers[LINEAR_SIGNATURE_HEADER];
  if (typeof signature !== "string" || signature.length === 0) {
    return { ok: false, reason: "missing_header", detail: LINEAR_SIGNATURE_HEADER };
  }

  const expected = computeSignature(opts.rawBody, opts.secret);
  if (!safeEqualHex(signature.trim(), expected)) {
    return { ok: false, reason: "invalid_signature", detail: "HMAC mismatch" };
  }

  const envelope = extractEnvelopeMeta(opts.rawBody);
  if (!envelope.ok) {
    return { ok: false, reason: "malformed", detail: envelope.detail };
  }

  const now = opts.now ? opts.now() : Date.now();
  const skewMs = opts.timestampSkewMs ?? DEFAULT_TIMESTAMP_SKEW_MS;
  const delta = Math.abs(now - envelope.webhookTimestamp);
  if (delta > skewMs) {
    return {
      ok: false,
      reason: "stale_timestamp",
      detail: `|now - webhookTimestamp|=${delta}ms > ${skewMs}ms`,
    };
  }

  if (opts.nonceCache.has(envelope.webhookId)) {
    return { ok: false, reason: "duplicate_nonce", detail: envelope.webhookId };
  }
  opts.nonceCache.remember(envelope.webhookId);

  return { ok: true, webhookTimestamp: envelope.webhookTimestamp, webhookId: envelope.webhookId };
}

interface EnvelopeMetaOk {
  readonly ok: true;
  readonly webhookTimestamp: number;
  readonly webhookId: string;
}

interface EnvelopeMetaErr {
  readonly ok: false;
  readonly detail: string;
}

type EnvelopeMeta = EnvelopeMetaOk | EnvelopeMetaErr;

/**
 * Decode the minimum envelope fields needed for verification — specifically
 * `webhookTimestamp` (for the skew check) and `webhookId` (for the nonce
 * cache). Kept narrow so a malformed body is rejected at signature-verify
 * time instead of leaking into the event parser.
 */
export function extractEnvelopeMeta(rawBody: Uint8Array): EnvelopeMeta {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(rawBody);
  } catch (cause) {
    return { ok: false, detail: cause instanceof Error ? cause.message : "utf-8 decode failed" };
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch (cause) {
    return { ok: false, detail: cause instanceof Error ? cause.message : "json parse failed" };
  }
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
    return { ok: false, detail: "body is not a JSON object" };
  }
  const record = decoded as Record<string, unknown>;
  const ts = record.webhookTimestamp;
  if (typeof ts !== "number" || !Number.isFinite(ts)) {
    return { ok: false, detail: "webhookTimestamp missing or not a finite number" };
  }
  const id = record.webhookId;
  if (typeof id !== "string" || id.length === 0) {
    return { ok: false, detail: "webhookId missing or empty" };
  }
  return { ok: true, webhookTimestamp: ts, webhookId: id };
}
