/**
 * Linear webhook event types — discriminated union + hand-written type guards.
 *
 * We parse only the subset of Linear's webhook envelope that Phase 6 actually
 * consumes:
 *
 *   - `issue-label-added`  — envelope `{action: "update", type: "Issue"}` where
 *     the `updatedFrom.labelIds` array shrank (i.e. at least one label was
 *     added on this update).
 *   - `comment-created`    — envelope `{action: "create", type: "Comment"}`.
 *   - `status-changed`     — envelope `{action: "update", type: "Issue"}` where
 *     `updatedFrom.stateId` is present (the issue status transitioned).
 *
 * Linear's full webhook payload is much richer than what we model here; we
 * defensively pluck only the fields we need and return a canonical, stable
 * shape. If Linear adds fields tomorrow we keep working; if they remove the
 * ones we depend on we reject the payload as `malformed`.
 *
 * The raw envelope remains attached to every parsed event so downstream
 * consumers (Phase 6.C supervisor wiring) can re-extract fields we did not
 * surface.
 */

// --- Raw envelope shape (defensively typed) ---------------------------------

/**
 * The common envelope Linear's data-change webhooks share. Top-level
 * discriminators are `action` + `type`; the `data` payload shape varies.
 *
 * We model `data` and `updatedFrom` as free-form records — callers that need
 * stricter typing should narrow via `parseLinearEvent`, which returns the
 * typed union below.
 */
export interface LinearWebhookEnvelope {
  readonly action: string;
  readonly type: string;
  readonly createdAt?: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly updatedFrom?: Readonly<Record<string, unknown>>;
  readonly url?: string;
  readonly webhookTimestamp: number;
  readonly webhookId: string;
  readonly actor?: Readonly<Record<string, unknown>>;
  readonly organizationId?: string;
}

// --- Typed event union ------------------------------------------------------

export type LinearEventKind = "issue-label-added" | "comment-created" | "status-changed";

export interface LinearEventBase {
  /** Monotonic millisecond timestamp from the envelope. */
  readonly webhookTimestamp: number;
  /** Unique webhook delivery id (used for nonce-cache dedupe). */
  readonly webhookId: string;
  /** Raw envelope, preserved for downstream consumers. */
  readonly raw: LinearWebhookEnvelope;
}

export interface IssueLabelAddedEvent extends LinearEventBase {
  readonly kind: "issue-label-added";
  readonly issueId: string;
  /** Label ids that are present on the issue AFTER the update. */
  readonly labelIds: readonly string[];
  /** Label ids that were added by this update (i.e. not in `updatedFrom`). */
  readonly addedLabelIds: readonly string[];
}

export interface CommentCreatedEvent extends LinearEventBase {
  readonly kind: "comment-created";
  readonly commentId: string;
  readonly issueId: string;
  readonly body: string;
  readonly userId: string | null;
}

export interface StatusChangedEvent extends LinearEventBase {
  readonly kind: "status-changed";
  readonly issueId: string;
  readonly fromStateId: string;
  readonly toStateId: string;
}

export type LinearEvent = IssueLabelAddedEvent | CommentCreatedEvent | StatusChangedEvent;

// --- Parse result / rejection ----------------------------------------------

export type ParseRejectionReason =
  | "malformed_json"
  | "missing_envelope_fields"
  | "unsupported_event";

export interface ParseOk {
  readonly ok: true;
  readonly event: LinearEvent;
}

export interface ParseErr {
  readonly ok: false;
  readonly reason: ParseRejectionReason;
  readonly detail: string;
}

export type ParseResult = ParseOk | ParseErr;

// --- Type guards (hand-written, no runtime deps) ---------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v): v is string => typeof v === "string");
}

/**
 * True iff `value` conforms to {@link LinearWebhookEnvelope}. Fields we do not
 * touch are permitted to carry anything — we only check what downstream code
 * reads.
 */
export function isLinearWebhookEnvelope(value: unknown): value is LinearWebhookEnvelope {
  if (!isRecord(value)) return false;
  if (typeof value.action !== "string" || value.action.length === 0) return false;
  if (typeof value.type !== "string" || value.type.length === 0) return false;
  if (typeof value.webhookTimestamp !== "number" || !Number.isFinite(value.webhookTimestamp)) {
    return false;
  }
  if (typeof value.webhookId !== "string" || value.webhookId.length === 0) return false;
  if (!isRecord(value.data)) return false;
  if (value.updatedFrom !== undefined && !isRecord(value.updatedFrom)) return false;
  return true;
}

function pickIssueId(data: Readonly<Record<string, unknown>>): string | null {
  const id = data.id;
  if (typeof id === "string" && id.length > 0) return id;
  return null;
}

function parseIssueLabelAdded(env: LinearWebhookEnvelope): ParseResult {
  if (env.action !== "update" || env.type !== "Issue") {
    return { ok: false, reason: "unsupported_event", detail: `${env.action}/${env.type}` };
  }
  const updatedFrom = env.updatedFrom;
  if (!updatedFrom || !("labelIds" in updatedFrom)) {
    return {
      ok: false,
      reason: "unsupported_event",
      detail: "Issue update without labelIds diff",
    };
  }
  const previousLabelIds = updatedFrom.labelIds;
  if (!isStringArray(previousLabelIds)) {
    return {
      ok: false,
      reason: "missing_envelope_fields",
      detail: "updatedFrom.labelIds is not string[]",
    };
  }
  const currentLabelIds = env.data.labelIds;
  if (!isStringArray(currentLabelIds)) {
    return {
      ok: false,
      reason: "missing_envelope_fields",
      detail: "data.labelIds is not string[]",
    };
  }
  const issueId = pickIssueId(env.data);
  if (!issueId) {
    return { ok: false, reason: "missing_envelope_fields", detail: "data.id missing" };
  }
  const previousSet = new Set(previousLabelIds);
  const added = currentLabelIds.filter((id) => !previousSet.has(id));
  if (added.length === 0) {
    return {
      ok: false,
      reason: "unsupported_event",
      detail: "label diff had no additions",
    };
  }
  const event: IssueLabelAddedEvent = {
    kind: "issue-label-added",
    webhookTimestamp: env.webhookTimestamp,
    webhookId: env.webhookId,
    raw: env,
    issueId,
    labelIds: currentLabelIds,
    addedLabelIds: added,
  };
  return { ok: true, event };
}

function parseCommentCreated(env: LinearWebhookEnvelope): ParseResult {
  if (env.action !== "create" || env.type !== "Comment") {
    return { ok: false, reason: "unsupported_event", detail: `${env.action}/${env.type}` };
  }
  const data = env.data;
  const id = data.id;
  if (typeof id !== "string" || id.length === 0) {
    return { ok: false, reason: "missing_envelope_fields", detail: "comment.id missing" };
  }
  const body = data.body;
  if (typeof body !== "string") {
    return { ok: false, reason: "missing_envelope_fields", detail: "comment.body missing" };
  }
  const issueId = data.issueId;
  if (typeof issueId !== "string" || issueId.length === 0) {
    // Fall back to nested `issue.id` shape used by some Linear payload versions.
    const issue = data.issue;
    if (!isRecord(issue) || typeof issue.id !== "string" || issue.id.length === 0) {
      return { ok: false, reason: "missing_envelope_fields", detail: "comment.issueId missing" };
    }
    const event: CommentCreatedEvent = {
      kind: "comment-created",
      webhookTimestamp: env.webhookTimestamp,
      webhookId: env.webhookId,
      raw: env,
      commentId: id,
      issueId: issue.id,
      body,
      userId: pickUserId(data),
    };
    return { ok: true, event };
  }
  const event: CommentCreatedEvent = {
    kind: "comment-created",
    webhookTimestamp: env.webhookTimestamp,
    webhookId: env.webhookId,
    raw: env,
    commentId: id,
    issueId,
    body,
    userId: pickUserId(data),
  };
  return { ok: true, event };
}

function pickUserId(data: Readonly<Record<string, unknown>>): string | null {
  const direct = data.userId;
  if (typeof direct === "string" && direct.length > 0) return direct;
  const user = data.user;
  if (isRecord(user) && typeof user.id === "string" && user.id.length > 0) return user.id;
  return null;
}

function parseStatusChanged(env: LinearWebhookEnvelope): ParseResult {
  if (env.action !== "update" || env.type !== "Issue") {
    return { ok: false, reason: "unsupported_event", detail: `${env.action}/${env.type}` };
  }
  const updatedFrom = env.updatedFrom;
  if (!updatedFrom || !("stateId" in updatedFrom)) {
    return {
      ok: false,
      reason: "unsupported_event",
      detail: "Issue update without stateId diff",
    };
  }
  const fromStateId = updatedFrom.stateId;
  if (typeof fromStateId !== "string" || fromStateId.length === 0) {
    return {
      ok: false,
      reason: "missing_envelope_fields",
      detail: "updatedFrom.stateId is not a non-empty string",
    };
  }
  const toStateId = env.data.stateId;
  if (typeof toStateId !== "string" || toStateId.length === 0) {
    return {
      ok: false,
      reason: "missing_envelope_fields",
      detail: "data.stateId is not a non-empty string",
    };
  }
  const issueId = pickIssueId(env.data);
  if (!issueId) {
    return { ok: false, reason: "missing_envelope_fields", detail: "data.id missing" };
  }
  const event: StatusChangedEvent = {
    kind: "status-changed",
    webhookTimestamp: env.webhookTimestamp,
    webhookId: env.webhookId,
    raw: env,
    issueId,
    fromStateId,
    toStateId,
  };
  return { ok: true, event };
}

/**
 * Parse a raw envelope into one of the supported events.
 *
 * Precedence when the envelope matches multiple interpretations (e.g. an
 * Issue-update with BOTH a stateId diff and a labelIds diff): status change
 * wins, because it is the more semantically actionable signal for the
 * supervisor bus. A supervisor that actually needs to see both can inspect
 * `event.raw.updatedFrom`.
 */
export function classifyEnvelope(env: LinearWebhookEnvelope): ParseResult {
  if (env.action === "create" && env.type === "Comment") {
    return parseCommentCreated(env);
  }
  if (env.action === "update" && env.type === "Issue") {
    const statusResult = parseStatusChanged(env);
    if (statusResult.ok) return statusResult;
    const labelResult = parseIssueLabelAdded(env);
    if (labelResult.ok) return labelResult;
    // Neither status nor label — pick the more-specific rejection.
    if (labelResult.reason === "missing_envelope_fields") return labelResult;
    if (statusResult.reason === "missing_envelope_fields") return statusResult;
    return {
      ok: false,
      reason: "unsupported_event",
      detail: "Issue update without stateId or labelIds diff",
    };
  }
  return {
    ok: false,
    reason: "unsupported_event",
    detail: `${env.action}/${env.type}`,
  };
}

/**
 * Parse a JSON string into a typed Linear event. Returns a discriminated
 * result so callers can switch exhaustively on `ok`.
 *
 * The server layer keeps the raw body bytes (for signature verification) and
 * hands them here AFTER verification succeeds. Parse failures are surfaced to
 * the server as HTTP 400.
 */
export function parseLinearEvent(rawBody: string): ParseResult {
  let decoded: unknown;
  try {
    decoded = JSON.parse(rawBody);
  } catch (cause) {
    return {
      ok: false,
      reason: "malformed_json",
      detail: cause instanceof Error ? cause.message : String(cause),
    };
  }
  if (!isLinearWebhookEnvelope(decoded)) {
    return {
      ok: false,
      reason: "missing_envelope_fields",
      detail: "envelope missing action/type/webhookTimestamp/webhookId/data",
    };
  }
  return classifyEnvelope(decoded);
}
