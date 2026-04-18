import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openDatabase, type ShamuDatabase } from "@shamu/persistence/db";
import { newRunId, newSwarmId, type RunId, type SwarmId } from "@shamu/shared/ids";
import type { AuthContext } from "../src/auth.ts";
import { whisper } from "../src/mailbox.ts";
import {
  appendToMaterializedLog,
  fileMatchesDb,
  materializePath,
  reconcile,
} from "../src/materialize.ts";

function ctxFor(agent: string, swarmId: SwarmId, runId: RunId): AuthContext {
  return { agent, swarmId, runId };
}

describe("materialize", () => {
  let dir: string;
  let baseDir: string;
  let db: ShamuDatabase;
  let swarmId: SwarmId;
  let plannerRun: RunId;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "shamu-mat-"));
    baseDir = join(dir, "repo");
    mkdirSync(baseDir, { recursive: true });
    db = openDatabase(join(dir, "db.sqlite"));
    swarmId = newSwarmId();
    plannerRun = newRunId();
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("materializePath returns .shamu/mailbox/<agent>.jsonl under baseDir", () => {
    expect(materializePath("/repo", "alice")).toBe("/repo/.shamu/mailbox/alice.jsonl");
  });

  it("appendToMaterializedLog writes one line per row", () => {
    const ctx = ctxFor("planner", swarmId, plannerRun);
    const r1 = whisper(db, ctx, "executor", "one");
    appendToMaterializedLog(baseDir, r1);
    const r2 = whisper(db, ctx, "executor", "two");
    appendToMaterializedLog(baseDir, r2);

    const path = materializePath(baseDir, "executor");
    expect(existsSync(path)).toBe(true);
    const contents = readFileSync(path, "utf8");
    const lines = contents.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    const parsed1 = JSON.parse(lines[0] ?? "");
    const parsed2 = JSON.parse(lines[1] ?? "");
    expect(parsed1.body).toBe("one");
    expect(parsed2.body).toBe("two");
    expect(parsed1.fromAgent).toBe("planner");
  });

  it("appendToMaterializedLog is atomic (no .tmp lingers)", () => {
    const ctx = ctxFor("planner", swarmId, plannerRun);
    const row = whisper(db, ctx, "executor", "hi");
    appendToMaterializedLog(baseDir, row);
    const path = materializePath(baseDir, "executor");
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });

  it("reconcile rebuilds each agent's file from DB", () => {
    const ctx = ctxFor("planner", swarmId, plannerRun);
    whisper(db, ctx, "executor", "one");
    whisper(db, ctx, "executor", "two");
    whisper(db, ctx, "reviewer", "note");

    reconcile(baseDir, db);

    const executorPath = materializePath(baseDir, "executor");
    const reviewerPath = materializePath(baseDir, "reviewer");
    const executorContents = readFileSync(executorPath, "utf8");
    const reviewerContents = readFileSync(reviewerPath, "utf8");

    expect(executorContents.split("\n").filter((l) => l.length > 0)).toHaveLength(2);
    expect(reviewerContents.split("\n").filter((l) => l.length > 0)).toHaveLength(1);
  });

  it("reconcile corrects an out-of-date file (divergence recovery)", () => {
    const ctx = ctxFor("planner", swarmId, plannerRun);
    whisper(db, ctx, "executor", "one");
    whisper(db, ctx, "executor", "two");

    const path = materializePath(baseDir, "executor");
    mkdirSync(dirname(path), { recursive: true });
    // Simulate a file that has fallen behind the DB.
    const stalePayload = JSON.stringify({
      msgId: "old",
      swarmId,
      fromAgent: "nobody",
      toAgent: "executor",
      body: "stale",
      deliveredAt: 0,
      readAt: null,
    });
    writeFileSync(path, `${stalePayload}\n`, "utf8");

    expect(fileMatchesDb(baseDir, "executor", db)).toBe(false);
    reconcile(baseDir, db);
    expect(fileMatchesDb(baseDir, "executor", db)).toBe(true);

    const contents = readFileSync(path, "utf8");
    expect(contents).not.toContain("stale");
    const lines = contents.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
  });

  it("fileMatchesDb returns true for a fresh jsonl written by appendToMaterializedLog", () => {
    const ctx = ctxFor("planner", swarmId, plannerRun);
    const r = whisper(db, ctx, "executor", "hi");
    appendToMaterializedLog(baseDir, r);
    expect(fileMatchesDb(baseDir, "executor", db)).toBe(true);
  });

  it("reconcile is a no-op for an agent with no messages", () => {
    reconcile(baseDir, db);
    // No file for a never-mentioned agent.
    expect(existsSync(materializePath(baseDir, "nobody"))).toBe(false);
  });
});
