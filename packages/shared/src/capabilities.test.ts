import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { freezeCapabilities, loadCapabilities } from "./capabilities.ts";
import { ConfigError } from "./errors.ts";

const CANONICAL = {
  resume: true,
  fork: false,
  interrupt: "cooperative",
  permissionModes: ["default", "acceptEdits"],
  mcp: "in-process",
  customTools: true,
  patchVisibility: "events",
  usageReporting: "per-turn",
  costReporting: "native",
  sandboxing: "process",
  streaming: "events",
} as const;

describe("capabilities", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "shamu-cap-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("freezeCapabilities returns an immutable object", () => {
    const caps = freezeCapabilities(CANONICAL);
    expect(Object.isFrozen(caps)).toBe(true);
    expect(() => {
      (caps as unknown as { interrupt: string }).interrupt = "hard";
    }).toThrow();
  });

  it("freezeCapabilities throws ConfigError on schema violation", () => {
    expect(() => freezeCapabilities({ ...CANONICAL, interrupt: "???" })).toThrow(ConfigError);
  });

  it("loadCapabilities reads a JSON manifest", () => {
    const p = join(dir, "manifest.json");
    writeFileSync(p, JSON.stringify(CANONICAL));
    const caps = loadCapabilities(p);
    expect(caps.costReporting).toBe("native");
    expect(Object.isFrozen(caps)).toBe(true);
  });

  it("loadCapabilities throws ConfigError for missing files", () => {
    expect(() => loadCapabilities(join(dir, "nope.json"))).toThrow(ConfigError);
  });

  it("loadCapabilities throws ConfigError for invalid JSON", () => {
    const p = join(dir, "broken.json");
    writeFileSync(p, "{not json");
    expect(() => loadCapabilities(p)).toThrow(ConfigError);
  });

  it("loadCapabilities throws ConfigError for schema violations", () => {
    const p = join(dir, "bad.json");
    writeFileSync(p, JSON.stringify({ ...CANONICAL, permissionModes: [] }));
    expect(() => loadCapabilities(p)).toThrow(ConfigError);
  });
});
