/**
 * Typed error surface for @shamu/linear-client.
 *
 * Two families:
 *
 *   - `LinearAuthError` — raised during API-key resolution. The `reason`
 *     discriminant lets callers distinguish "no key anywhere" from "the
 *     credential store itself blew up".
 *   - `LinearError` — raised by the client for every other failure mode
 *     (transport, HTTP non-2xx, GraphQL `errors[]`, rate-limit, shape
 *     mismatch). The `kind` discriminant drives retry / escalation policy in
 *     the Phase 6 flow.
 *
 * Both extend `ShamuError` so they inherit the stable `code` pattern the CLI,
 * dashboard, and Linear sink key off of.
 */

import { ShamuError } from "@shamu/shared/errors";

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export type LinearAuthErrorReason =
  /** No key in env, none in the credential store. Onboarding needed. */
  | "missing"
  /** The credential store backend itself threw. `cause` carries the original. */
  | "credential_store_failed"
  /** An env-supplied or persisted key was present but empty/whitespace. */
  | "invalid_format";

export class LinearAuthError extends ShamuError {
  public readonly code = "linear_auth_error" as const;
  public readonly reason: LinearAuthErrorReason;

  constructor(reason: LinearAuthErrorReason, message: string, cause?: unknown) {
    super(message, cause);
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export type LinearErrorKind =
  /** fetch() rejected — DNS, TLS, offline. Transient; callers may retry. */
  | "network"
  /**
   * HTTP non-2xx AND not one of the specific cases below. Carries the raw
   * status + body snippet for log correlation.
   */
  | "http"
  /**
   * Rate-limited. Linear returns 400 with `extensions.code === "RATELIMITED"`
   * OR a 429 with `Retry-After`. We normalize both into this kind and carry
   * the best retry hint we can compute.
   */
  | "rate_limited"
  /** Unauthenticated (401) — key is missing, wrong, or revoked. */
  | "unauthenticated"
  /** Forbidden (403) — key is valid but lacks scope for this op. */
  | "forbidden"
  /** Target resource doesn't exist (404 or GraphQL null-on-lookup). */
  | "not_found"
  /**
   * GraphQL-level error: HTTP was 200 but the response body had a non-empty
   * `errors[]`. Preserves Linear's `extensions.code` when present.
   */
  | "graphql"
  /** The response body didn't match the shape we expected. */
  | "shape"
  /** Caller passed something invalid before we even hit the wire. */
  | "invalid_input";

export interface LinearErrorDetail {
  /** HTTP status, when we have one. */
  readonly status?: number;
  /** Linear's `extensions.code` string, when we have one. */
  readonly extensionsCode?: string;
  /** Seconds until the caller is allowed to retry (rate-limit only). */
  readonly retryAfterSeconds?: number;
  /** Millisecond-epoch timestamp when the window resets (rate-limit only). */
  readonly resetAtMs?: number;
  /** Bounded snippet of the response body for log correlation. */
  readonly bodySnippet?: string;
  /** GraphQL error path, when Linear surfaced one. */
  readonly path?: readonly (string | number)[];
}

export class LinearError extends ShamuError {
  public readonly code = "linear_error" as const;
  public readonly kind: LinearErrorKind;
  public readonly detail: LinearErrorDetail;

  constructor(
    kind: LinearErrorKind,
    message: string,
    detail: LinearErrorDetail = {},
    cause?: unknown,
  ) {
    super(message, cause);
    this.kind = kind;
    this.detail = detail;
  }
}

// ---------------------------------------------------------------------------
// Detection helpers (exported for tests and for the client's own use)
// ---------------------------------------------------------------------------

const RATE_LIMIT_CODES: ReadonlySet<string> = new Set(["RATELIMITED", "RATE_LIMITED"]);

/**
 * Return the retry-after value in seconds given the most common shapes:
 *   - `Retry-After: 42`       (seconds as integer string)
 *   - `Retry-After: <HTTP-date>`
 *
 * Unparseable → `undefined`, caller falls back to a sane default.
 */
export function parseRetryAfter(
  value: string | null | undefined,
  nowMs: number = Date.now(),
): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  // Pure integer seconds.
  if (/^\d+$/.test(trimmed)) {
    const n = Number.parseInt(trimmed, 10);
    if (Number.isFinite(n) && n >= 0) return n;
    return undefined;
  }
  // Explicitly reject signed numerics — negative seconds make no sense.
  if (/^[+-]?\d/.test(trimmed)) return undefined;
  // HTTP-date (RFC 7231).
  const whenMs = Date.parse(trimmed);
  if (!Number.isFinite(whenMs)) return undefined;
  const diff = Math.max(0, Math.ceil((whenMs - nowMs) / 1000));
  return diff;
}

/**
 * Extract Linear's `X-RateLimit-Requests-Reset` header (UTC epoch ms) if
 * present and parseable.
 */
export function parseResetHeader(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const n = Number.parseInt(trimmed, 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * Is this a rate-limit GraphQL error extension? Linear's canonical code is
 * `RATELIMITED`; some historical payloads use `RATE_LIMITED`. We accept both.
 */
export function isRateLimitCode(code: string | undefined): boolean {
  return typeof code === "string" && RATE_LIMIT_CODES.has(code);
}
