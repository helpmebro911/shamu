import { describe, expect, it } from "vitest";
import {
  auditEventId,
  eventId,
  leaseId,
  newAuditEventId,
  newEventId,
  newLeaseId,
  newRunId,
  newSessionId,
  newSwarmId,
  newToolCallId,
  newTurnId,
  newWorkflowRunId,
  runId,
  sessionId,
  swarmId,
  toolCallId,
  turnId,
  workflowRunId,
} from "./ids.ts";
import { isUlid } from "./ulid.ts";

describe("branded IDs", () => {
  describe("validators", () => {
    it("rejects empty strings", () => {
      for (const fn of [runId, sessionId, turnId, toolCallId, leaseId, swarmId, workflowRunId]) {
        expect(() => fn("")).toThrow(TypeError);
      }
    });

    it("accepts arbitrary non-empty strings for non-ULID IDs", () => {
      expect(runId("foo")).toBe("foo");
      expect(sessionId("vendor_session-abc")).toBe("vendor_session-abc");
      expect(toolCallId("tool_call_42")).toBe("tool_call_42");
    });

    it("rejects non-ULID strings for eventId / auditEventId", () => {
      expect(() => eventId("not a ulid")).toThrow(TypeError);
      expect(() => auditEventId("foo")).toThrow(TypeError);
    });

    it("accepts valid ULIDs for eventId / auditEventId", () => {
      const u = newEventId();
      expect(isUlid(u)).toBe(true);
      expect(eventId(u)).toBe(u);
    });
  });

  describe("generators", () => {
    it("produce fresh ULIDs for every brand", () => {
      const ids = [
        newRunId(),
        newSessionId(),
        newEventId(),
        newTurnId(),
        newToolCallId(),
        newLeaseId(),
        newSwarmId(),
        newWorkflowRunId(),
        newAuditEventId(),
      ];
      for (const id of ids) expect(isUlid(id)).toBe(true);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });
});
