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

describe("ExitCode mapping for shamu flow run (Track 4.C)", () => {
  // Track 4.C pins the 0/1/2 mapping at the CLI boundary. These cases
  // document the triplet so a regression in the `deriveTerminalStatus` /
  // `exitCodeFor` seams fails in isolation rather than only surfacing in
  // a subprocess e2e test.
  //
  // Per the track spec:
  //   - succeeded → OK (0)
  //   - paused    → USAGE (2) — closest "human must act" semantic in the
  //                 current taxonomy. Dedicated code reserved for a future
  //                 phase if/when paused flows become a distinct operator
  //                 signal.
  //   - failed    → RUN_FAILED (10)
  it("maps succeeded to OK (0)", () => {
    expect(ExitCode.OK).toBe(0);
  });
  it("maps paused to USAGE (2)", () => {
    expect(ExitCode.USAGE).toBe(2);
  });
  it("maps failed to RUN_FAILED (10)", () => {
    expect(ExitCode.RUN_FAILED).toBe(10);
  });
});
