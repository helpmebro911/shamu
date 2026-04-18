import { describe, expect, test } from "vitest";
import { buildExecutorPrompt, buildPlannerPrompt, buildReviewerPrompt } from "../src/prompts.ts";
import type { ExecutorOutput, PlannerOutput } from "../src/schemas.ts";

const samplePlan: PlannerOutput = {
  goal: "add a readme heading",
  steps: [
    { id: "s1", description: "open README.md", filesTouched: ["README.md"] },
    { id: "s2", description: "insert a heading at the top", filesTouched: ["README.md"] },
  ],
  assumptions: ["the file already exists"],
};

const sampleExec: ExecutorOutput = {
  summary: "added a heading to README.md",
  diffStats: { added: 1, removed: 0, files: ["README.md"] },
  notes: "no scope expansion",
};

describe("prompts", () => {
  test("planner prompt is deterministic and mentions the json schema marker", () => {
    const a = buildPlannerPrompt({ task: "task-a", repoContext: "ctx-a" });
    const b = buildPlannerPrompt({ task: "task-a", repoContext: "ctx-a" });
    expect(a).toEqual(b);
    expect(a.system).toMatch(/```json```/);
    expect(a.system).toMatch(/"goal"/);
    expect(a.user).toMatch(/task-a/);
    expect(a.user).toMatch(/ctx-a/);
    expect(a).toMatchSnapshot();
  });

  test("executor prompt echoes the plan, is deterministic, and mentions schema", () => {
    const a = buildExecutorPrompt({ task: "task-a", plan: samplePlan });
    const b = buildExecutorPrompt({ task: "task-a", plan: samplePlan });
    expect(a).toEqual(b);
    expect(a.system).toMatch(/```json```/);
    expect(a.system).toMatch(/"diffStats"/);
    expect(a.user).toContain("add a readme heading");
    expect(a.user).toContain("task-a");
    expect(a).toMatchSnapshot();
  });

  test("executor prompt includes reviewer feedback when supplied", () => {
    const withFb = buildExecutorPrompt({
      task: "task-a",
      plan: samplePlan,
      reviewerFeedback: "need to also update the table of contents",
    });
    expect(withFb.user).toMatch(/Reviewer feedback/i);
    expect(withFb.user).toContain("table of contents");
  });

  test("executor prompt includes prior notes when supplied", () => {
    const withNotes = buildExecutorPrompt({
      task: "task-a",
      plan: samplePlan,
      priorNotes: "struggled to find the insertion point",
    });
    expect(withNotes.user).toMatch(/Your own notes/);
    expect(withNotes.user).toContain("insertion point");
  });

  test("reviewer prompt embeds plan and execution, includes schema marker", () => {
    const r = buildReviewerPrompt({
      task: "task-a",
      plan: samplePlan,
      execution: sampleExec,
    });
    expect(r.system).toMatch(/```json```/);
    expect(r.system).toMatch(/"verdict"/);
    expect(r.system).toMatch(/requires_ci_rerun/);
    expect(r.user).toContain("task-a");
    expect(r.user).toContain("add a readme heading");
    expect(r.user).toContain("added a heading to README.md");
    // No CI section when ci is absent.
    expect(r.user).not.toMatch(/CI result:/);
    expect(r).toMatchSnapshot();
  });

  test("reviewer prompt includes CI section when green CI is supplied", () => {
    const r = buildReviewerPrompt({
      task: "task-a",
      plan: samplePlan,
      execution: sampleExec,
      ci: { status: "green", excerpt: null },
    });
    expect(r.user).toMatch(/CI result:/);
    expect(r.user).toMatch(/status: green/);
    expect(r.user).toContain("(no excerpt available)");
    expect(r).toMatchSnapshot();
  });

  test("reviewer prompt includes CI excerpt verbatim on red", () => {
    const r = buildReviewerPrompt({
      task: "task-a",
      plan: samplePlan,
      execution: sampleExec,
      ci: {
        status: "red",
        excerpt: "agent-ci run run-42: RED\n  workflows: 1, failed jobs: 1\n  - test-suite failed",
      },
    });
    expect(r.user).toMatch(/CI result:/);
    expect(r.user).toMatch(/status: red/);
    expect(r.user).toContain("agent-ci run run-42: RED");
    expect(r.user).toContain("test-suite failed");
    // System prompt carries the red-CI rule.
    expect(r.system).toMatch(/MUST NOT emit\s*\n?\s*`approve`/);
    expect(r).toMatchSnapshot();
  });
});
