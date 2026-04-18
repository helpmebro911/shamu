/**
 * Zod schemas for the plan -> execute -> review flow's node outputs.
 *
 * Each role emits a fenced ```json block at the end of its final assistant
 * message; the runner locates the LAST fenced json block and validates it
 * against the schema here. Keeping the schemas narrow and explicit is a
 * deliberate tradeoff against the vendor's freeform prose: we want the
 * structured surface to be tight enough for the next node to consume without
 * re-parsing, and loose enough that a well-behaved model can emit it on the
 * first try.
 *
 * Types are inferred from the schemas so drift between the runtime shape and
 * the compile-time contract is impossible.
 */

import type { CIRunSummary } from "@shamu/ci";
import { z } from "zod";

/**
 * Planner output. The planner produces a bounded ordered list of steps the
 * executor will follow. `filesTouched` is advisory rather than prescriptive
 * because the executor may discover ancillary files during work; the
 * reviewer references this list when checking whether scope expanded.
 */
export const PlannerOutputSchema = z.object({
  goal: z.string().min(1),
  steps: z.array(
    z.object({
      id: z.string().min(1),
      description: z.string().min(1),
      filesTouched: z.array(z.string()),
    }),
  ),
  assumptions: z.array(z.string()),
});

export type PlannerOutput = z.infer<typeof PlannerOutputSchema>;

/**
 * Executor output. We intentionally do NOT persist the full diff here; the
 * diff lives on disk in the executor's worktree and is re-read by tools that
 * need it. `diffStats` + `files` are the minimum surface the reviewer needs
 * to decide approve/revise without double-loading the raw diff through the
 * flow state.
 */
export const ExecutorOutputSchema = z.object({
  summary: z.string().min(1),
  diffStats: z.object({
    added: z.number().int().nonnegative(),
    removed: z.number().int().nonnegative(),
    files: z.array(z.string()),
  }),
  notes: z.string(),
});

export type ExecutorOutput = z.infer<typeof ExecutorOutputSchema>;

/**
 * Reviewer verdict. `iterationsUsed` is maintained by the reviewer runner
 * itself -- see `flow.ts` for why the loop body re-runs via the reviewer
 * instead of the engine's Loop node in 4.A.
 *
 * `concerns` is separate from `feedback` so a CLI/TUI sink can render a
 * bulleted list of issues even when the overall verdict is `approve`
 * (reviewer might approve with minor follow-ups).
 *
 * `requires_ci_rerun` is emitted when the reviewer believes a red CI is an
 * infra/flake issue and a clean rerun is warranted (rather than a code fix).
 * The reviewer runner skips re-invoking the executor and re-runs CI only;
 * the loop predicate treats this the same as revise at iteration cap.
 */
export const ReviewerVerdictSchema = z.object({
  verdict: z.enum(["approve", "revise", "requires_ci_rerun"]),
  feedback: z.string(),
  iterationsUsed: z.number().int().positive(),
  concerns: z.array(z.string()),
});

export type ReviewerVerdict = z.infer<typeof ReviewerVerdictSchema>;

/**
 * What the reviewer adapter itself emits inside its final fenced-json block
 * -- verdict + feedback + concerns. `iterationsUsed` is added by the runner
 * because the model does not know its own iteration number reliably.
 */
export const ReviewerModelOutputSchema = z.object({
  verdict: z.enum(["approve", "revise", "requires_ci_rerun"]),
  feedback: z.string(),
  concerns: z.array(z.string()),
});

export type ReviewerModelOutput = z.infer<typeof ReviewerModelOutputSchema>;

/**
 * CI node output. The `ci` runner wraps `@shamu/ci`'s `runGate` result and
 * projects it onto this shape so the reviewer has a stable validation
 * surface. We DO NOT pin the full `CIRunSummary` structure in the zod
 * schema -- that's `@shamu/ci`'s concern and will grow fields over time;
 * the reviewer only reads `status` + `reviewerExcerpt`, which is all we
 * validate strictly. `summary.passthrough()` lets the rest of the summary
 * flow through without coupling the flow package to `@shamu/ci`'s internal
 * shape. The TypeScript type, however, references `CIRunSummary` directly
 * so producers (the `ci` runner) pass summary data through without a cast.
 */
export const CINodeOutputSchema = z.object({
  kind: z.enum(["CIRed", "PatchReady"]),
  runId: z.string(),
  summary: z
    .object({
      runId: z.string(),
      status: z.enum(["green", "red", "unknown"]),
    })
    .passthrough(),
  reviewerExcerpt: z.string().nullable(),
});

export interface CINodeOutput {
  readonly kind: "CIRed" | "PatchReady";
  readonly runId: string;
  readonly summary: CIRunSummary;
  readonly reviewerExcerpt: string | null;
}
