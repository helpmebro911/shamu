import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AgentCIRunState } from "../src/index.ts";
import { parseRunState, toDomainEvent } from "../src/index.ts";

const FIXTURES = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "fixtures");

function loadRunState(name: string): AgentCIRunState {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), "utf-8"));
}

function stepLogReader(map: Record<string, string>) {
  return (p: string): string | null => map[path.basename(p)] ?? null;
}

describe("toDomainEvent — green projects to PatchReady", () => {
  const state = loadRunState("green-run-state.json");
  const summary = parseRunState(state, { readStepLog: () => null });
  const ev = toDomainEvent(summary);

  it("selects PatchReady", () => {
    expect(ev.kind).toBe("PatchReady");
  });

  it("carries the runId and summary", () => {
    if (ev.kind !== "PatchReady") throw new Error("unreachable");
    expect(ev.runId).toBe(summary.runId);
    expect(ev.summary).toBe(summary);
  });

  it("does not include a reviewer excerpt on the PatchReady variant", () => {
    // Type-level check: PatchReady has no `reviewerExcerpt` field.
    expect("reviewerExcerpt" in ev).toBe(false);
  });
});

describe("toDomainEvent — red projects to CIRed", () => {
  const state = loadRunState("red-test-run-state.json");
  const stepLog = fs.readFileSync(path.join(FIXTURES, "red-test-step-Test.log"), "utf-8");
  const summary = parseRunState(state, {
    readStepLog: stepLogReader({ "Test.log": stepLog }),
  });
  const ev = toDomainEvent(summary);

  it("selects CIRed", () => {
    expect(ev.kind).toBe("CIRed");
  });

  it("carries the runId, summary, and excerpt", () => {
    if (ev.kind !== "CIRed") throw new Error("unreachable");
    expect(ev.runId).toBe(summary.runId);
    expect(ev.summary).toBe(summary);
    expect(ev.reviewerExcerpt).toContain("RED");
  });

  it("passes reviewer excerpt options through to the builder", () => {
    const small = toDomainEvent(summary, { maxTokens: 80 });
    if (small.kind !== "CIRed") throw new Error("unreachable");
    expect(small.reviewerExcerpt).toContain("truncated");
  });
});

describe("toDomainEvent — unknown status falls back to PatchReady", () => {
  // status=unknown (empty workflows) is a non-red terminal, so we default
  // to PatchReady. Red is the only path that publishes CIRed.
  const state: AgentCIRunState = {
    runId: "run-unknown",
    status: "running",
    startedAt: "2026-04-17T00:00:00Z",
    workflows: [],
  };
  const summary = parseRunState(state);
  const ev = toDomainEvent(summary);
  it("is PatchReady", () => {
    expect(ev.kind).toBe("PatchReady");
  });
});
