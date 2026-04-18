/**
 * Tests for the envelope parser + typed event union.
 */

import { describe, expect, it } from "vitest";
import {
  commentCreatedPayload,
  issueLabelAddedPayload,
  statusChangedPayload,
} from "../__fixtures__/index.ts";
import { classifyEnvelope, isLinearWebhookEnvelope, parseLinearEvent } from "../events.ts";

describe("isLinearWebhookEnvelope", () => {
  it("accepts a realistic issue-label-added envelope", () => {
    expect(isLinearWebhookEnvelope(issueLabelAddedPayload())).toBe(true);
  });

  it("rejects non-objects", () => {
    expect(isLinearWebhookEnvelope(null)).toBe(false);
    expect(isLinearWebhookEnvelope("string")).toBe(false);
    expect(isLinearWebhookEnvelope([])).toBe(false);
  });

  it("rejects envelopes missing webhookId", () => {
    const payload = issueLabelAddedPayload();
    delete (payload as Record<string, unknown>).webhookId;
    expect(isLinearWebhookEnvelope(payload)).toBe(false);
  });

  it("rejects envelopes whose webhookTimestamp is not a number", () => {
    const payload = issueLabelAddedPayload();
    (payload as Record<string, unknown>).webhookTimestamp = "not a number";
    expect(isLinearWebhookEnvelope(payload)).toBe(false);
  });
});

describe("parseLinearEvent — issue-label-added", () => {
  it("parses a realistic payload and reports added ids", () => {
    const payload = issueLabelAddedPayload({
      previousLabelIds: ["a"],
      currentLabelIds: ["a", "b", "c"],
    });
    const result = parseLinearEvent(JSON.stringify(payload));
    expect(result.ok).toBe(true);
    if (result.ok && result.event.kind === "issue-label-added") {
      expect(result.event.addedLabelIds).toEqual(["b", "c"]);
      expect(result.event.labelIds).toEqual(["a", "b", "c"]);
      expect(result.event.webhookId).toBe("hook-delivery-label-1");
    } else {
      throw new Error("expected issue-label-added");
    }
  });

  it("rejects Issue updates that only removed labels", () => {
    const payload = issueLabelAddedPayload({
      previousLabelIds: ["a", "b"],
      currentLabelIds: ["a"],
    });
    const result = parseLinearEvent(JSON.stringify(payload));
    expect(result.ok).toBe(false);
  });
});

describe("parseLinearEvent — comment-created", () => {
  it("parses top-level issueId shape", () => {
    const payload = commentCreatedPayload({ body: "hello", userId: "u-9" });
    const result = parseLinearEvent(JSON.stringify(payload));
    expect(result.ok).toBe(true);
    if (result.ok && result.event.kind === "comment-created") {
      expect(result.event.body).toBe("hello");
      expect(result.event.userId).toBe("u-9");
      expect(result.event.issueId).toBe("issue-1");
    } else {
      throw new Error("expected comment-created");
    }
  });

  it("falls back to nested issue.id shape when issueId is absent", () => {
    const base = commentCreatedPayload();
    const data = base.data as Record<string, unknown>;
    delete data.issueId;
    data.issue = { id: "issue-42" };
    const result = parseLinearEvent(JSON.stringify(base));
    expect(result.ok).toBe(true);
    if (result.ok && result.event.kind === "comment-created") {
      expect(result.event.issueId).toBe("issue-42");
    } else {
      throw new Error("expected comment-created");
    }
  });

  it("rejects comment payloads missing body", () => {
    const base = commentCreatedPayload();
    delete (base.data as Record<string, unknown>).body;
    const result = parseLinearEvent(JSON.stringify(base));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("missing_envelope_fields");
  });
});

describe("parseLinearEvent — status-changed", () => {
  it("parses a realistic state transition", () => {
    const payload = statusChangedPayload({
      fromStateId: "state-todo",
      toStateId: "state-doing",
    });
    const result = parseLinearEvent(JSON.stringify(payload));
    expect(result.ok).toBe(true);
    if (result.ok && result.event.kind === "status-changed") {
      expect(result.event.fromStateId).toBe("state-todo");
      expect(result.event.toStateId).toBe("state-doing");
    } else {
      throw new Error("expected status-changed");
    }
  });

  it("prefers status-changed over label-added when both diffs appear", () => {
    const payload = statusChangedPayload();
    (payload.updatedFrom as Record<string, unknown>).labelIds = ["x"];
    (payload.data as Record<string, unknown>).labelIds = ["x", "y"];
    const result = parseLinearEvent(JSON.stringify(payload));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.event.kind).toBe("status-changed");
  });
});

describe("parseLinearEvent — malformed", () => {
  it("reports malformed_json for non-JSON input", () => {
    const result = parseLinearEvent("not json{{{");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("malformed_json");
  });

  it("reports missing_envelope_fields for an empty object", () => {
    const result = parseLinearEvent("{}");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("missing_envelope_fields");
  });

  it("reports unsupported_event for Project updates", () => {
    const result = parseLinearEvent(
      JSON.stringify({
        action: "update",
        type: "Project",
        data: { id: "p-1" },
        webhookTimestamp: 1,
        webhookId: "w-1",
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unsupported_event");
  });
});

describe("classifyEnvelope directly", () => {
  it("rejects Comment actions other than create", () => {
    const payload = commentCreatedPayload();
    payload.action = "update";
    expect(isLinearWebhookEnvelope(payload)).toBe(true);
    const classified = isLinearWebhookEnvelope(payload) ? classifyEnvelope(payload) : null;
    expect(classified?.ok).toBe(false);
  });
});
