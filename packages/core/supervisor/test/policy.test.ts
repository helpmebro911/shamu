import { describe, expect, it } from "vitest";
import {
  DEFAULT_ROLE_POLICIES,
  defaultPolicyForRole,
  InvalidPolicyError,
  resolvePolicy,
  validateRestartPolicy,
} from "../src/policy.ts";
import type { RestartPolicy } from "../src/types.ts";

describe("DEFAULT_ROLE_POLICIES", () => {
  it("matches the PLAN.md defaults for planner/executor/reviewer", () => {
    expect(DEFAULT_ROLE_POLICIES.planner).toEqual({
      strategy: "one_for_one",
      intensity: 3,
      withinMs: 60_000,
      escalate: "swarm",
    });
    expect(DEFAULT_ROLE_POLICIES.executor).toEqual({
      strategy: "one_for_one",
      intensity: 5,
      withinMs: 300_000,
      escalate: "role",
    });
    expect(DEFAULT_ROLE_POLICIES.reviewer).toEqual({
      strategy: "one_for_one",
      intensity: 2,
      withinMs: 120_000,
      escalate: "swarm",
    });
  });

  it("defaultPolicyForRole returns the same object as the constant", () => {
    expect(defaultPolicyForRole("planner")).toBe(DEFAULT_ROLE_POLICIES.planner);
    expect(defaultPolicyForRole("executor")).toBe(DEFAULT_ROLE_POLICIES.executor);
    expect(defaultPolicyForRole("reviewer")).toBe(DEFAULT_ROLE_POLICIES.reviewer);
  });

  it("the exported object is frozen", () => {
    const planner = DEFAULT_ROLE_POLICIES.planner;
    expect(Object.isFrozen(planner)).toBe(true);
    expect(Object.isFrozen(DEFAULT_ROLE_POLICIES)).toBe(true);
  });
});

describe("validateRestartPolicy", () => {
  const ok: RestartPolicy = {
    strategy: "one_for_one",
    intensity: 3,
    withinMs: 60_000,
    escalate: "swarm",
  };

  it("accepts a well-formed policy", () => {
    expect(validateRestartPolicy(ok)).toBe(ok);
  });

  it("rejects unknown strategies", () => {
    expect(() =>
      validateRestartPolicy({
        ...ok,
        strategy: "one_for_all" as unknown as RestartPolicy["strategy"],
      }),
    ).toThrow(InvalidPolicyError);
  });

  it("rejects unknown escalate targets", () => {
    expect(() =>
      validateRestartPolicy({
        ...ok,
        escalate: "linear" as unknown as RestartPolicy["escalate"],
      }),
    ).toThrow(InvalidPolicyError);
  });

  it("rejects negative intensity", () => {
    expect(() => validateRestartPolicy({ ...ok, intensity: -1 })).toThrow(InvalidPolicyError);
  });

  it("rejects non-integer intensity", () => {
    expect(() => validateRestartPolicy({ ...ok, intensity: 1.5 })).toThrow(InvalidPolicyError);
  });

  it("rejects withinMs <= 0", () => {
    expect(() => validateRestartPolicy({ ...ok, withinMs: 0 })).toThrow(InvalidPolicyError);
    expect(() => validateRestartPolicy({ ...ok, withinMs: -10 })).toThrow(InvalidPolicyError);
  });

  it("rejects non-finite withinMs", () => {
    expect(() => validateRestartPolicy({ ...ok, withinMs: Number.POSITIVE_INFINITY })).toThrow(
      InvalidPolicyError,
    );
    expect(() => validateRestartPolicy({ ...ok, withinMs: Number.NaN })).toThrow(
      InvalidPolicyError,
    );
  });
});

describe("resolvePolicy", () => {
  const base: RestartPolicy = {
    strategy: "one_for_one",
    intensity: 5,
    withinMs: 300_000,
    escalate: "role",
  };

  it("returns the base when no overrides are supplied", () => {
    expect(resolvePolicy(base)).toEqual(base);
  });

  it("applies individual overrides without mutating the base", () => {
    const merged = resolvePolicy(base, { intensity: 10, strategy: "rest_for_one" });
    expect(merged).toEqual({
      strategy: "rest_for_one",
      intensity: 10,
      withinMs: 300_000,
      escalate: "role",
    });
    expect(base.intensity).toBe(5);
  });

  it("validates the merged result", () => {
    expect(() => resolvePolicy(base, { intensity: -1 })).toThrow(InvalidPolicyError);
  });
});
