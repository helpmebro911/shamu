import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./db.ts";
import { applyPending, migrations } from "./migrations.ts";

describe("migrations", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "shamu-persist-mig-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("exposes the declared migrations", () => {
    const m = migrations();
    expect(m).toHaveLength(2);
    expect(m[0]?.version).toBe(1);
    expect(m[0]?.name).toBe("initial");
    expect(m[1]?.version).toBe(2);
    expect(m[1]?.name).toBe("flow_runs");
  });

  it("applies every pending migration on open", () => {
    const db = openDatabase(join(dir, "db.sqlite"));
    try {
      const record = db.migrations();
      expect(record).toHaveLength(2);
      expect(record[0]?.version).toBe(1);
      expect(record[1]?.version).toBe(2);
    } finally {
      db.close();
    }
  });

  it("v2 flow_runs table carries the canonical columns", () => {
    const db = openDatabase(join(dir, "db.sqlite"));
    try {
      const cols = db.prepare("PRAGMA table_info(flow_runs)").all() as Array<{
        name: string;
        type: string;
        notnull: number;
      }>;
      const names = cols.map((c) => c.name);
      expect(names).toEqual(
        expect.arrayContaining([
          "flow_run_id",
          "flow_id",
          "dag_version",
          "status",
          "state_json",
          "resumed_from",
          "started_at",
          "updated_at",
        ]),
      );
      const dagVersion = cols.find((c) => c.name === "dag_version");
      expect(dagVersion?.type).toBe("INTEGER");
    } finally {
      db.close();
    }
  });

  it("is idempotent: re-running applyPending is a no-op", () => {
    const db = openDatabase(join(dir, "db.sqlite"));
    try {
      const a = db.migrations();
      applyPending(db.driver as unknown as Parameters<typeof applyPending>[0]);
      const b = db.migrations();
      expect(b).toEqual(a);
    } finally {
      db.close();
    }
  });

  it("creates all declared tables", () => {
    const db = openDatabase(join(dir, "db.sqlite"));
    try {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as Array<{ name: string }>;
      const names = tables.map((t) => t.name);
      const expected = [
        "audit_events",
        "checkpoints",
        "ci_runs",
        "events",
        "flow_runs",
        "leases",
        "linear_issues",
        "mailbox",
        "raw_events",
        "runs",
        "schema_lock",
        "schema_migrations",
        "sessions",
      ];
      for (const t of expected) expect(names).toContain(t);
    } finally {
      db.close();
    }
  });

  it("configures WAL journal mode", () => {
    const db = openDatabase(join(dir, "db.sqlite"));
    try {
      const mode = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
      expect(mode.journal_mode).toBe("wal");
    } finally {
      db.close();
    }
  });
});
