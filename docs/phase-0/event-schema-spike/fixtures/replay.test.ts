// Fixture replay test. Projects each committed raw JSONL capture through the
// spike projector and asserts the result is byte-identical to the committed
// `*-projected.jsonl` fixture. These fixtures are the regression baselines
// the Phase 2 adapters will inherit; if they drift, we have real evidence the
// taxonomy changed.

import { describe, test, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { projectFile } from "../src/project.ts";

const FIXTURES = new URL(".", import.meta.url).pathname;

const CASES: { vendor: "claude" | "codex"; task: string }[] = [
  { vendor: "claude", task: "bugfix" },
  { vendor: "claude", task: "refactor" },
  { vendor: "claude", task: "new-feature" },
  { vendor: "codex", task: "bugfix" },
  { vendor: "codex", task: "refactor" },
  { vendor: "codex", task: "new-feature" },
];

describe("event-schema-spike: projection is deterministic", () => {
  for (const { vendor, task } of CASES) {
    test(`${vendor}/${task} round-trip matches fixture`, async () => {
      const rawPath = path.join(FIXTURES, "raw", `${vendor}-${task}-raw.jsonl`);
      const expectedProjectedPath = path.join(
        FIXTURES,
        "projected",
        `${vendor}-${task}-projected.jsonl`,
      );
      const expectedGapsPath = path.join(
        FIXTURES,
        "gaps",
        `${vendor}-${task}-gaps.json`,
      );

      const { events, gaps } = await projectFile(rawPath, vendor);
      const actualProjected = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
      const actualGaps = JSON.stringify(gaps, null, 2) + "\n";

      const expectedProjected = await readFile(expectedProjectedPath, "utf-8");
      const expectedGaps = await readFile(expectedGapsPath, "utf-8");

      expect(actualProjected).toBe(expectedProjected);
      expect(actualGaps).toBe(expectedGaps);
    });
  }
});
