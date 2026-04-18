import { describe, expect, it } from "vitest";
import { auditEventSchema } from "./audit.ts";

describe("auditEventSchema", () => {
  it("parses a valid event with default payload", () => {
    const parsed = auditEventSchema.parse({
      actor: "supervisor",
      action: "run.start",
      entity: "run:01HZZZ",
      reason: "scheduled",
      ts: 1_700_000_000_000,
    });
    expect(parsed.payload).toEqual({});
  });

  it("rejects unknown actions", () => {
    expect(() =>
      auditEventSchema.parse({
        actor: "x",
        action: "hack.override",
        entity: "y",
        reason: "",
        ts: 1,
      }),
    ).toThrow();
  });

  it("accepts payload values", () => {
    const parsed = auditEventSchema.parse({
      actor: "user",
      action: "lease.acquire",
      entity: "lease:abc",
      reason: "executor edit",
      ts: 1_700_000_000_000,
      payload: { glob: "src/**/*.ts", runId: "r1" },
    });
    expect(parsed.payload).toEqual({ glob: "src/**/*.ts", runId: "r1" });
  });
});
