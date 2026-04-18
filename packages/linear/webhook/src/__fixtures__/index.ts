/**
 * Synthetic fixtures for webhook tests.
 *
 * IMPORTANT: `TEST_WEBHOOK_SECRET` is a SYNTHETIC value. It is not a real
 * Linear webhook signing secret; do not attempt to use it against a live
 * Linear workspace. The `shamu-test-` prefix is deliberate so grep / secret
 * scanners recognise it as fixture-only.
 */

import type { CommentCreatedEvent, IssueLabelAddedEvent, StatusChangedEvent } from "../events.ts";
import { computeSignature } from "../verify.ts";

/** Synthetic secret used across ALL fixtures. Do not use in production. */
export const TEST_WEBHOOK_SECRET = "shamu-test-webhook-secret-not-a-real-secret";

/**
 * Base timestamp (ms) used by default fixtures. A fixed value keeps tests
 * deterministic — verifiers pass a `now()` that returns this same value.
 */
export const FIXTURE_NOW_MS = 1_734_000_000_000;

/**
 * Build the raw envelope for an `issue-label-added` event.
 *
 * Shape intentionally mirrors Linear's documented `action: "update"` +
 * `type: "Issue"` envelope with a `updatedFrom.labelIds` delta showing at
 * least one label was added.
 */
export function issueLabelAddedPayload(overrides?: {
  webhookId?: string;
  webhookTimestamp?: number;
  issueId?: string;
  previousLabelIds?: readonly string[];
  currentLabelIds?: readonly string[];
}): Record<string, unknown> {
  const previous = overrides?.previousLabelIds ?? ["label-backlog"];
  const current = overrides?.currentLabelIds ?? ["label-backlog", "label-shamu-ready"];
  return {
    action: "update",
    type: "Issue",
    createdAt: "2024-12-12T00:00:00.000Z",
    data: {
      id: overrides?.issueId ?? "issue-1",
      title: "Example issue",
      labelIds: current,
      stateId: "state-todo",
    },
    updatedFrom: {
      labelIds: previous,
    },
    url: "https://linear.app/example/issue/EX-1",
    webhookTimestamp: overrides?.webhookTimestamp ?? FIXTURE_NOW_MS,
    webhookId: overrides?.webhookId ?? "hook-delivery-label-1",
  };
}

export function commentCreatedPayload(overrides?: {
  webhookId?: string;
  webhookTimestamp?: number;
  commentId?: string;
  issueId?: string;
  body?: string;
  userId?: string | null;
}): Record<string, unknown> {
  return {
    action: "create",
    type: "Comment",
    createdAt: "2024-12-12T00:01:00.000Z",
    data: {
      id: overrides?.commentId ?? "comment-1",
      issueId: overrides?.issueId ?? "issue-1",
      body: overrides?.body ?? "First comment",
      userId: overrides?.userId === null ? null : (overrides?.userId ?? "user-1"),
    },
    url: "https://linear.app/example/issue/EX-1#comment-1",
    webhookTimestamp: overrides?.webhookTimestamp ?? FIXTURE_NOW_MS,
    webhookId: overrides?.webhookId ?? "hook-delivery-comment-1",
  };
}

export function statusChangedPayload(overrides?: {
  webhookId?: string;
  webhookTimestamp?: number;
  issueId?: string;
  fromStateId?: string;
  toStateId?: string;
}): Record<string, unknown> {
  return {
    action: "update",
    type: "Issue",
    createdAt: "2024-12-12T00:02:00.000Z",
    data: {
      id: overrides?.issueId ?? "issue-1",
      title: "Example issue",
      labelIds: ["label-shamu-ready"],
      stateId: overrides?.toStateId ?? "state-in-progress",
    },
    updatedFrom: {
      stateId: overrides?.fromStateId ?? "state-todo",
    },
    url: "https://linear.app/example/issue/EX-1",
    webhookTimestamp: overrides?.webhookTimestamp ?? FIXTURE_NOW_MS,
    webhookId: overrides?.webhookId ?? "hook-delivery-status-1",
  };
}

export interface SignedFixture {
  readonly rawBody: Uint8Array;
  readonly bodyText: string;
  readonly signature: string;
  readonly webhookId: string;
  readonly webhookTimestamp: number;
}

/**
 * Serialize a payload to JSON (deterministic key order as the spread order
 * is stable) and compute its HMAC-SHA256 with the synthetic secret.
 */
export function signFixture(
  payload: Record<string, unknown>,
  secret: string = TEST_WEBHOOK_SECRET,
): SignedFixture {
  const bodyText = JSON.stringify(payload);
  const rawBody = new TextEncoder().encode(bodyText);
  const signature = computeSignature(rawBody, secret);
  const webhookId = String(payload.webhookId);
  const webhookTimestamp = Number(payload.webhookTimestamp);
  return { rawBody, bodyText, signature, webhookId, webhookTimestamp };
}

/** Type-level round-trip: compile-check the fixture shape matches the parsed event. */
export type ExpectIssueLabelAdded = IssueLabelAddedEvent["kind"];
export type ExpectCommentCreated = CommentCreatedEvent["kind"];
export type ExpectStatusChanged = StatusChangedEvent["kind"];
