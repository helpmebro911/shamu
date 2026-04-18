import { describe, expect, it } from "vitest";
import {
  assertCapability,
  freezeCapabilities,
  supportsCapability,
  supportsPermissionMode,
} from "../src/capabilities.ts";
import { ContractViolationError } from "../src/errors.ts";

const baseCaps = {
  resume: true,
  fork: false,
  interrupt: "cooperative" as const,
  permissionModes: ["default", "acceptEdits"] as const,
  mcp: "none" as const,
  customTools: true,
  patchVisibility: "events" as const,
  usageReporting: "per-turn" as const,
  costReporting: "native" as const,
  sandboxing: "process" as const,
  streaming: "events" as const,
};

describe("capability helpers", () => {
  it("freezeCapabilities produces a frozen Capabilities object", () => {
    const caps = freezeCapabilities(baseCaps);
    expect(Object.isFrozen(caps)).toBe(true);
    expect(caps.resume).toBe(true);
  });

  it("supportsCapability returns true for declared features", () => {
    const caps = freezeCapabilities(baseCaps);
    expect(supportsCapability(caps, "resume")).toBe(true);
    expect(supportsCapability(caps, "fork")).toBe(false);
    expect(supportsCapability(caps, "interrupt")).toBe(true);
    expect(supportsCapability(caps, "customTools")).toBe(true);
    expect(supportsCapability(caps, "patchEvents")).toBe(true);
    expect(supportsCapability(caps, "usageReporting")).toBe(true);
    expect(supportsCapability(caps, "costReporting")).toBe(true);
    expect(supportsCapability(caps, "streamingEvents")).toBe(true);
  });

  it("interrupt=none surfaces as unsupported", () => {
    const caps = freezeCapabilities({ ...baseCaps, interrupt: "none" });
    expect(supportsCapability(caps, "interrupt")).toBe(false);
  });

  it("patchVisibility=filesystem-only surfaces as patchEvents=false", () => {
    const caps = freezeCapabilities({ ...baseCaps, patchVisibility: "filesystem-only" });
    expect(supportsCapability(caps, "patchEvents")).toBe(false);
  });

  it("assertCapability throws ContractViolationError for missing features", () => {
    const caps = freezeCapabilities({ ...baseCaps, resume: false });
    expect(() => assertCapability(caps, "resume")).toThrow(ContractViolationError);
  });

  it("assertCapability is a no-op for supported features", () => {
    const caps = freezeCapabilities(baseCaps);
    expect(() => assertCapability(caps, "resume")).not.toThrow();
  });

  it("supportsPermissionMode returns true for declared modes", () => {
    const caps = freezeCapabilities(baseCaps);
    expect(supportsPermissionMode(caps, "default")).toBe(true);
    expect(supportsPermissionMode(caps, "plan")).toBe(false);
  });
});
