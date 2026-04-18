import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  classifyStep,
  parseEslintFailures,
  parseStepLog,
  parseTapFailures,
  tailFailure,
} from "../src/index.ts";

const FIXTURES = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "fixtures");

describe("classifyStep", () => {
  it("classifies test-runner step names", () => {
    expect(classifyStep("Test")).toBe("test");
    expect(classifyStep("Run vitest")).toBe("test");
    expect(classifyStep("pytest unit")).toBe("test");
    expect(classifyStep("Jest")).toBe("test");
  });

  it("classifies lint step names", () => {
    expect(classifyStep("Lint")).toBe("lint");
    expect(classifyStep("eslint .")).toBe("lint");
    expect(classifyStep("biome check")).toBe("lint");
    expect(classifyStep("ruff")).toBe("lint");
  });

  it("classifies typecheck + build + install", () => {
    expect(classifyStep("Typecheck")).toBe("typecheck");
    expect(classifyStep("tsc --noEmit")).toBe("typecheck");
    expect(classifyStep("mypy")).toBe("typecheck");
    expect(classifyStep("build")).toBe("build");
    expect(classifyStep("compile")).toBe("build");
    expect(classifyStep("Install")).toBe("install");
    expect(classifyStep("npm ci")).toBe("install");
    expect(classifyStep("yarn install")).toBe("install");
  });

  it("returns unknown for unrecognised step names", () => {
    expect(classifyStep("Capture outputs")).toBe("unknown");
    expect(classifyStep("Post Setup")).toBe("unknown");
  });
});

describe("parseTapFailures", () => {
  it("parses the red-test fixture", () => {
    const log = fs.readFileSync(path.join(FIXTURES, "red-test-step-Test.log"), "utf-8");
    const failures = parseTapFailures(log);
    expect(failures.length).toBeGreaterThanOrEqual(2);
    const greet = failures.find((f) => f.name.startsWith("greets with"));
    if (!greet) throw new Error("expected greet failure");
    expect(greet.expected).toBe("Hello, Shamu.");
    expect(greet.actual).toBe("Hello, Shamu!");
  });

  it("ignores leading/trailing whitespace on failures", () => {
    const tap = [
      "    not ok 1 - whitespaced name",
      "      ---",
      "      error: 'something broke'",
      "      ...",
    ].join("\n");
    const failures = parseTapFailures(tap);
    expect(failures).toHaveLength(1);
    const f0 = failures[0];
    if (!f0) throw new Error("expected failure");
    expect(f0.name).toBe("whitespaced name");
    expect(f0.errorLines[0]).toBe("something broke");
  });

  it("returns empty for passing TAP", () => {
    const tap = ["TAP version 13", "ok 1 - a passes", "ok 2 - b passes", "1..2"].join("\n");
    expect(parseTapFailures(tap)).toEqual([]);
  });
});

describe("parseEslintFailures", () => {
  it("parses the red-lint fixture", () => {
    const log = fs.readFileSync(path.join(FIXTURES, "red-lint-step-Lint.log"), "utf-8");
    const failures = parseEslintFailures(log);
    expect(failures.length).toBeGreaterThanOrEqual(2);
    const names = failures.map((f) => f.name).join("\n");
    expect(names).toContain("no-var");
    expect(names).toContain("@typescript-eslint/no-unused-vars");
  });

  it("ignores warning-severity diagnostics", () => {
    const log = ["/abs/path/file.ts", "  1:1  warning  should warn   some-rule"].join("\n");
    expect(parseEslintFailures(log)).toEqual([]);
  });
});

describe("tailFailure", () => {
  it("returns the last N non-blank lines", () => {
    const raw = ["line 1", "line 2", "", "line 3", ""].join("\n");
    const failures = tailFailure(raw, 2);
    expect(failures).toHaveLength(1);
    const f0 = failures[0];
    if (!f0) throw new Error("expected failure");
    expect(f0.errorLines).toEqual(["line 2", "", "line 3"].slice(-2));
  });

  it("returns empty when the input is blank", () => {
    expect(tailFailure("", 10)).toEqual([]);
    expect(tailFailure("\n\n\n", 10)).toEqual([]);
  });
});

describe("parseStepLog — fallback paths", () => {
  it("falls back to tail when a test-named step produces no TAP", () => {
    const parsed = parseStepLog("Test", "plain panic\ncall stack line 1\ncall stack line 2", {
      tailLines: 5,
    });
    expect(parsed.kind).toBe("test");
    expect(parsed.failingTests).toHaveLength(1);
    const t0 = parsed.failingTests[0];
    if (!t0) throw new Error("expected failure");
    expect(t0.name).toContain("unparsed failure");
  });

  it("caps failing tests at maxFailingTests", () => {
    const tap = Array.from({ length: 20 }, (_, i) => `not ok ${i + 1} - test ${i + 1}`).join("\n");
    const parsed = parseStepLog("Test", tap, { maxFailingTests: 3 });
    expect(parsed.failingTests).toHaveLength(3);
  });
});
