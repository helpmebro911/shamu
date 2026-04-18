/**
 * `@shamu/linear-webhook` — public surface.
 *
 * Deliverable for Phase 6.B:
 *
 *   - `createWebhookServer(opts)` — Bun HTTP server exposing
 *     `POST /webhooks/linear` and `GET /webhooks/linear` (health). Every
 *     other route returns 404. Consumer API is `handle.events` — an async
 *     iterable of typed {@link LinearEvent} values. Phase 6.C wires this
 *     into the supervisor bus.
 *
 *   - `buildFetchHandler(opts)` — the same request handler as a pure
 *     function; exposed for tests that want to exercise the code path
 *     without binding a socket (Vitest workers, simulators, …).
 *
 *   - `verifyLinearRequest(opts)` — standalone HMAC-SHA256 + timestamp-window
 *     + nonce-cache verifier. Rejection reasons are typed discriminants.
 *
 *   - `parseLinearEvent(rawBody)` — raw-JSON → typed union parser. Events
 *     retain the raw envelope so Phase 6.C can extract additional fields
 *     without re-parsing.
 *
 *   - `startTunnel(opts)` — spawn cloudflared for local dev; SIGTERM
 *     handler installed to reap the child cleanly.
 */

export type {
  CommentCreatedEvent,
  IssueLabelAddedEvent,
  LinearEvent,
  LinearEventBase,
  LinearEventKind,
  LinearWebhookEnvelope,
  ParseErr,
  ParseOk,
  ParseRejectionReason,
  ParseResult,
  StatusChangedEvent,
} from "./events.ts";
export {
  classifyEnvelope,
  isLinearWebhookEnvelope,
  parseLinearEvent,
} from "./events.ts";
export type { WebhookServerHandle, WebhookServerOptions } from "./server.ts";
export {
  buildFetchHandler,
  createWebhookServer,
  DEFAULT_HOST,
  DEFAULT_PORT,
  ENV_HOST,
  ENV_PORT,
  WEBHOOK_PATH,
} from "./server.ts";
export type { BinaryCheckResult, SpawnImpl, TunnelHandle, TunnelOptions } from "./tunnel.ts";
export {
  buildTunnelArgs,
  defaultCheckBinary,
  scopeMessage,
  startTunnel,
  TunnelBootError,
} from "./tunnel.ts";
export type {
  NonceCacheOptions,
  VerifyErr,
  VerifyOk,
  VerifyOptions,
  VerifyRejectionReason,
  VerifyResult,
} from "./verify.ts";
export {
  computeSignature,
  DEFAULT_TIMESTAMP_SKEW_MS,
  extractEnvelopeMeta,
  LINEAR_SIGNATURE_HEADER,
  NonceCache,
  safeEqualHex,
  verifyLinearRequest,
} from "./verify.ts";
