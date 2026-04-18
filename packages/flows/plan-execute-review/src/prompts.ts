/**
 * Prompt builders for the plan -> execute -> review flow.
 *
 * These are intentionally terse, deterministic, and committed to the repo so
 * that snapshot tests catch accidental whitespace churn that would otherwise
 * invalidate the reviewer's downstream expectations. Prompts do NOT
 * interpolate anything from the environment; every variable is a named
 * argument.
 *
 * Each prompt includes:
 *   1. A system message setting the role + expected JSON schema shape.
 *   2. A user message carrying the task (and prior-role output when
 *      applicable).
 *   3. An explicit instruction to emit the final answer as a fenced
 *      ```json block matching the role's schema.
 *
 * The runner extracts the LAST fenced-json block from the final assistant
 * message and validates it with Zod. See `runners.ts`.
 */

import type { ExecutorOutput, PlannerOutput } from "./schemas.ts";

/**
 * Stable marker the prompt tells the model to wrap its final output with.
 * We match this against a case-sensitive regex so prose that happens to
 * contain the word `json` doesn't get parsed as output.
 */
export const JSON_BLOCK_LANG = "json" as const;

export interface PlannerPromptInput {
  readonly task: string;
  readonly repoContext: string;
}

export interface PlannerPrompt {
  readonly system: string;
  readonly user: string;
}

export function buildPlannerPrompt(input: PlannerPromptInput): PlannerPrompt {
  const system = [
    "You are the PLANNER in a plan-execute-review coding flow.",
    "Your job is to produce a short, ordered, executable plan for an executor agent.",
    "Do not write code yourself; do not modify files; do not call tools.",
    "End your reply with a fenced ```json``` block matching exactly this shape:",
    "{",
    '  "goal": string,',
    '  "steps": Array<{ "id": string, "description": string, "filesTouched": string[] }>,',
    '  "assumptions": string[]',
    "}",
    "The `steps` array must be non-empty. Each `id` must be unique within the plan.",
  ].join("\n");

  const user = [
    "Task:",
    input.task,
    "",
    "Repository context:",
    input.repoContext,
    "",
    "Produce the plan. Remember: fenced ```json``` block at the end.",
  ].join("\n");

  return { system, user };
}

export interface ExecutorPromptInput {
  readonly task: string;
  readonly plan: PlannerOutput;
  readonly reviewerFeedback?: string;
  readonly priorNotes?: string;
}

export interface ExecutorPrompt {
  readonly system: string;
  readonly user: string;
}

export function buildExecutorPrompt(input: ExecutorPromptInput): ExecutorPrompt {
  const system = [
    "You are the EXECUTOR in a plan-execute-review coding flow.",
    "Follow the planner's steps in order. You may edit files in your worktree.",
    "Stay within the `filesTouched` set where possible; if you must expand scope,",
    "note it explicitly in your final `notes` field.",
    "End your reply with a fenced ```json``` block matching exactly this shape:",
    "{",
    '  "summary": string,',
    '  "diffStats": { "added": number, "removed": number, "files": string[] },',
    '  "notes": string',
    "}",
  ].join("\n");

  const planJson = JSON.stringify(input.plan, null, 2);
  const feedbackSection =
    input.reviewerFeedback !== undefined && input.reviewerFeedback.length > 0
      ? ["", "Reviewer feedback from the previous iteration (address it):", input.reviewerFeedback]
      : [];
  const notesSection =
    input.priorNotes !== undefined && input.priorNotes.length > 0
      ? ["", "Your own notes from the previous iteration:", input.priorNotes]
      : [];

  const user = [
    "Task:",
    input.task,
    "",
    "Plan:",
    planJson,
    ...feedbackSection,
    ...notesSection,
    "",
    "Execute the plan. Remember: fenced ```json``` block at the end.",
  ].join("\n");

  return { system, user };
}

export interface ReviewerPromptCI {
  readonly status: "green" | "red" | "unknown";
  readonly excerpt: string | null;
}

export interface ReviewerPromptInput {
  readonly task: string;
  readonly plan: PlannerOutput;
  readonly execution: ExecutorOutput;
  /**
   * CI signal for this iteration. The full `CIRunSummary` is NOT passed in --
   * the reviewer only needs status + a token-bounded excerpt. Omit when the
   * flow was invoked without CI wiring (smoke tests, legacy callers).
   */
  readonly ci?: ReviewerPromptCI;
}

export interface ReviewerPrompt {
  readonly system: string;
  readonly user: string;
}

export function buildReviewerPrompt(input: ReviewerPromptInput): ReviewerPrompt {
  const system = [
    "You are the REVIEWER in a plan-execute-review coding flow.",
    "Decide whether the executor's work fulfills the plan and the original task.",
    "A `revise` verdict sends the executor back for another iteration; reserve it",
    "for concrete, fixable issues (incorrect logic, missing step, obvious defect).",
    "A `requires_ci_rerun` verdict is for when the CI failure looks like an",
    "infrastructure flake (network hiccup, transient container boot failure) and",
    "a clean CI rerun is warranted -- NOT for logic fixes. If the failure points",
    "at the executor's code, use `revise` instead.",
    "Do not invent scope beyond the plan.",
    "If the CI result section below reports `status: red`, you MUST NOT emit",
    "`approve`; valid verdicts are `revise` (fixable code) or `requires_ci_rerun`",
    "(suspected flake). An `approve` against red CI will be overridden.",
    "If the CI result reports `status: green`, proceed normally; green CI alone",
    "does not force approve -- still judge scope and plan adherence.",
    "If the CI section is absent, proceed as you would without a CI signal.",
    "End your reply with a fenced ```json``` block matching exactly this shape:",
    "{",
    '  "verdict": "approve" | "revise" | "requires_ci_rerun",',
    '  "feedback": string,',
    '  "concerns": string[]',
    "}",
  ].join("\n");

  const planJson = JSON.stringify(input.plan, null, 2);
  const execJson = JSON.stringify(input.execution, null, 2);
  const ciSection =
    input.ci !== undefined
      ? [
          "",
          "CI result:",
          `status: ${input.ci.status}`,
          "excerpt:",
          input.ci.excerpt ?? "(no excerpt available)",
        ]
      : [];

  const user = [
    "Task:",
    input.task,
    "",
    "Plan the executor followed:",
    planJson,
    "",
    "Executor's report:",
    execJson,
    ...ciSection,
    "",
    "Render a verdict. Remember: fenced ```json``` block at the end.",
  ].join("\n");

  return { system, user };
}
