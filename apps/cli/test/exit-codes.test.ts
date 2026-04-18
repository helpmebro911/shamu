import { describe, expect, it } from "vitest";
import { ExitCode, labelFor } from "../src/exit-codes.ts";

describe("ExitCode taxonomy", () => {
  it("exports every documented name", () => {
    const expected = [
      "OK",
      "USER_CANCEL",
      "USAGE",
      "CONFIG_ERROR",
      "CREDENTIALS_ERROR",
      "RUN_FAILED",
      "SUPERVISOR_ESCALATION",
      "CI_RED",
      "INTERRUPTED",
      "INTERNAL",
    ];
    for (const name of expected) {
      expect(ExitCode).toHaveProperty(name);
    }
  });

  it("has numeric, distinct codes", () => {
    const values = Object.values(ExitCode);
    const unique = new Set(values);
    expect(unique.size).toBe(values.length);
    for (const v of values) {
      expect(typeof v).toBe("number");
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
    }
  });

  it("uses the documented values from PLAN.md Track 1.D", () => {
    expect(ExitCode.OK).toBe(0);
    expect(ExitCode.USER_CANCEL).toBe(1);
    expect(ExitCode.USAGE).toBe(2);
    expect(ExitCode.CONFIG_ERROR).toBe(3);
    expect(ExitCode.CREDENTIALS_ERROR).toBe(4);
    expect(ExitCode.RUN_FAILED).toBe(10);
    expect(ExitCode.SUPERVISOR_ESCALATION).toBe(11);
    expect(ExitCode.CI_RED).toBe(12);
    expect(ExitCode.INTERRUPTED).toBe(13);
    expect(ExitCode.INTERNAL).toBe(20);
  });

  it("round-trips values to names via labelFor", () => {
    for (const [name, value] of Object.entries(ExitCode)) {
      expect(labelFor(value)).toBe(name);
    }
  });
});
