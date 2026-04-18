import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newRunId } from "@shamu/shared/ids";
import { openDatabase } from "./db.ts";
import { insertRun, listRuns } from "./queries/runs.ts";

describe("ShamuDatabase", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "shamu-db-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("applies migrations on open by default", () => {
    const db = openDatabase(join(dir, "db.sqlite"));
    try {
      expect(db.migrations()).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("backup() writes a valid, equal copy", () => {
    const src = join(dir, "src.sqlite");
    const dest = join(dir, "dest.sqlite");
    const db = openDatabase(src);
    try {
      const r = newRunId();
      insertRun(db, { runId: r, status: "pending", createdAt: 1000 });
      db.backup(dest);

      expect(existsSync(dest)).toBe(true);
      expect(statSync(dest).size).toBeGreaterThan(0);

      const copy = openDatabase(dest, { skipMigrations: true });
      try {
        const rows = listRuns(copy);
        expect(rows).toHaveLength(1);
        expect(rows[0]?.runId).toBe(r);
      } finally {
        copy.close();
      }
    } finally {
      db.close();
    }
  });

  it("backup() refuses to overwrite the source", () => {
    const p = join(dir, "db.sqlite");
    const db = openDatabase(p);
    try {
      expect(() => db.backup(p)).toThrow(/destPath must differ/);
    } finally {
      db.close();
    }
  });
});
