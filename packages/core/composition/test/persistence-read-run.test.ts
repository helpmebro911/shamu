/**
 * Unit tests for `createReadRunRow`.
 *
 * Exercises the driver against a real `@shamu/persistence` database so
 * the structural hand-off to `@shamu/worktree`'s GC is verified end to
 * end (the whole point of having a composition layer). Uses
 * `bun:sqlite` via `openDatabase` — same pattern as persistence's own
 * tests. Vitest can't run `bun:sqlite`; this package's runner is
 * `bun test` for that reason.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, runsQueries, type ShamuDatabase } from "@shamu/persistence";
import { runId as brandRunId, newRunId, newSwarmId, type RunId } from "@shamu/shared/ids";
import type { GCReadRun } from "@shamu/worktree";
import { createReadRunRow } from "../src/persistence-read-run.ts";

describe("createReadRunRow", () => {
  let dir: string;
  let db: ShamuDatabase;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "shamu-comp-readrun-"));
    db = openDatabase(join(dir, "db.sqlite"));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns a structurally compatible snapshot when the row exists", () => {
    const rid = newRunId();
    const sid = newSwarmId();
    runsQueries.insertRun(db, {
      runId: rid,
      swarmId: sid,
      role: "executor",
      vendor: "echo",
      status: "completed",
      createdAt: 1_000,
    });

    const read = createReadRunRow({ db });
    const snapshot = read(rid);
    if (snapshot === null) throw new Error("Expected a snapshot");
    expect(snapshot.runId).toBe(rid);
    expect(snapshot.status).toBe("completed");
    expect(snapshot.createdAt).toBe(1_000);
    expect(snapshot.updatedAt).toBe(1_000);
  });

  it("returns null when the row is missing", () => {
    const read = createReadRunRow({ db });
    const nonexistent = newRunId();
    expect(read(nonexistent)).toBeNull();
  });

  it("throws TypeError with a clear message when the id is empty", () => {
    const read = createReadRunRow({ db });
    expect(() => read("" as RunId)).toThrow(TypeError);
  });

  it("satisfies the worktree package's GCReadRun structural contract", () => {
    // If `createReadRunRow` returns a function whose signature doesn't
    // match `GCReadRun` (i.e. `(runId) => GCRunSnapshot | null`), this
    // assignment would fail TypeScript. The runtime check just
    // exercises it once to ensure no accidental throw.
    const rid = newRunId();
    runsQueries.insertRun(db, {
      runId: rid,
      status: "failed",
      createdAt: 500,
    });
    const gcRead: GCReadRun = createReadRunRow({ db });
    const snapshot = gcRead(rid);
    if (snapshot === null) throw new Error("Expected snapshot");
    expect(snapshot.status).toBe("failed");
    expect(snapshot.updatedAt).toBe(500);
  });

  it("pipes arbitrary string ids through the branded factory", () => {
    // Covers the runtime brand path (non-TypeScript callers at the
    // boundary). We insert under a branded id then read via a string
    // re-brand; result matches.
    const raw = "01HZXTESTID000000000000001";
    runsQueries.insertRun(db, {
      runId: brandRunId(raw),
      status: "running",
      createdAt: 2_000,
    });
    const read = createReadRunRow({ db });
    const snapshot = read(brandRunId(raw));
    if (snapshot === null) throw new Error("Expected snapshot");
    expect(snapshot.runId).toBe(brandRunId(raw));
    expect(snapshot.status).toBe("running");
  });
});
