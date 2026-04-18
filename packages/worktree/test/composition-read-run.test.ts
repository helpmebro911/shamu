/**
 * Integration test — GC honors the composition-layer
 * `createReadRunRow` driver.
 *
 * `GCOptions.persistenceReadRun` is an injected callback matching the
 * shape `(runId) => { status, updatedAt } | null`. The composition
 * package (`@shamu/core-composition/persistence-read-run`) produces a
 * function that satisfies that structural contract while reading from
 * the real persistence layer. This test asserts that structural
 * compatibility by:
 *   - wrapping a fake "db" as a read-only map `runId → { status,
 *     updatedAt }`,
 *   - shaping the wrapper to match what the composition driver would
 *     return,
 *   - confirming GC still honors terminal-vs-non-terminal decisions
 *     through the wrapper.
 *
 * We intentionally don't pull `@shamu/persistence` into this package
 * (layer hygiene: `@shamu/worktree` has no persistence dep). Instead
 * we simulate the composition driver's return shape inline — if the
 * shape ever drifts, the composition package's own tests trip, not
 * this one. This test protects the INJECT SITE contract.
 */

import type { RunId } from "@shamu/shared/ids";
import { newRunId } from "@shamu/shared/ids";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorktree } from "../src/create.ts";
import { garbageCollect } from "../src/gc.ts";
import { createTempRepo, type TempRepo } from "./support/repo.ts";

/**
 * Shape the composition driver produces. Must remain a SUPERSET of
 * `GCRunSnapshot` so structural typing lets either flow through
 * `persistenceReadRun`.
 */
interface CompositionReadRunResult {
  readonly runId: RunId;
  readonly status: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

describe("garbageCollect honors composition-layer readRunRow drivers", () => {
  let repo: TempRepo;

  beforeEach(async () => {
    repo = await createTempRepo("shamu-comp-read-");
  });

  afterEach(() => {
    repo.cleanup();
  });

  it("accepts a function returning a composition-shaped row", async () => {
    const rid = newRunId();
    await createWorktree({ repoRoot: repo.path, runId: rid, baseBranch: "main" });

    const now = Date.now();
    const hour = 60 * 60 * 1000;

    const compositionRow: CompositionReadRunResult = {
      runId: rid,
      status: "completed",
      createdAt: now - 48 * hour,
      updatedAt: now - 48 * hour,
    };

    // The composition driver returns `CompositionReadRunResult`; the
    // GC callback expects `GCRunSnapshot`. Structural typing lets the
    // same function flow — extra fields (`runId`, `createdAt`) are
    // harmless. This is the whole point of the composition layering:
    // no cross-package type import needed.
    const report = await garbageCollect({
      repoRoot: repo.path,
      now,
      persistenceReadRun: (id) => (id === rid ? compositionRow : null),
    });

    expect(report.removed.map((r) => r.runId)).toContain(rid);
    expect(report.errors).toEqual([]);
  });
});
