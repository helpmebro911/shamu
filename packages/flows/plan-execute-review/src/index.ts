/**
 * @shamu/flows-plan-execute-review — public surface.
 *
 * Contract consumed by `shamu flow run --flow <module-spec>` (4.C):
 *   - `flowDefinition`
 *   - `registerRunners(registry, opts)`
 *   - `name`
 *   - optional `parseOptions(cliOpts)`
 *
 * Schemas + types are re-exported so dashboards / programmatic callers can
 * decode the flow's node outputs without re-declaring them.
 */

import { FLOW_ID } from "./config.ts";
import { flowDefinition } from "./flow.ts";
import type { RegisterRunnersOptions } from "./runners.ts";

export {
  DEFAULT_EXECUTOR_MODEL,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_PLANNER_MODEL,
  DEFAULT_REVIEWER_MODEL,
  FLOW_ID,
  FLOW_VERSION,
} from "./config.ts";
export { flowDefinition } from "./flow.ts";
export type {
  ExecutorPrompt,
  ExecutorPromptInput,
  PlannerPrompt,
  PlannerPromptInput,
  ReviewerPrompt,
  ReviewerPromptInput,
} from "./prompts.ts";
export {
  buildExecutorPrompt,
  buildPlannerPrompt,
  buildReviewerPrompt,
  JSON_BLOCK_LANG,
} from "./prompts.ts";
export type {
  AdapterOverride,
  RegisterRunnersOptions,
} from "./runners.ts";
export {
  parseLastJsonBlock,
  registerRunners,
} from "./runners.ts";
export type {
  ExecutorOutput,
  PlannerOutput,
  ReviewerModelOutput,
  ReviewerVerdict,
} from "./schemas.ts";
export {
  ExecutorOutputSchema,
  PlannerOutputSchema,
  ReviewerModelOutputSchema,
  ReviewerVerdictSchema,
} from "./schemas.ts";

/** Human-readable name; matches `flowDefinition.id` for display parity. */
export const name: string = flowDefinition.id;

/**
 * CLI-flag parser: accept a small allowlisted set of keys and produce a
 * `Partial<RegisterRunnersOptions>`. Called by 4.C's loader when it sees
 * `--flow-opt key=value` pairs. Unknown keys throw so typos surface at
 * parse time instead of producing silently-ignored options.
 *
 * Supported keys (match `RegisterRunnersOptions` 1:1):
 *   - maxIterations    (parsed as a positive integer)
 *   - plannerModel     (string)
 *   - executorModel    (string)
 *   - reviewerModel    (string)
 *   - anthropicCliPath (string)
 *   - codexCliPath     (string)
 */
export function parseOptions(cliOpts: Record<string, string>): Partial<RegisterRunnersOptions> {
  const allowed = new Set([
    "maxIterations",
    "plannerModel",
    "executorModel",
    "reviewerModel",
    "anthropicCliPath",
    "codexCliPath",
  ]);
  const out: {
    maxIterations?: number;
    plannerModel?: string;
    executorModel?: string;
    reviewerModel?: string;
    anthropicCliPath?: string;
    codexCliPath?: string;
  } = {};
  for (const [key, value] of Object.entries(cliOpts)) {
    if (!allowed.has(key)) {
      throw new Error(
        `parseOptions: unknown flow option '${key}' (expected one of ${[...allowed].sort().join(", ")})`,
      );
    }
    if (typeof value !== "string") {
      throw new TypeError(`parseOptions: value for '${key}' must be a string`);
    }
    if (key === "maxIterations") {
      const n = Number.parseInt(value, 10);
      if (!Number.isFinite(n) || n < 1) {
        throw new TypeError(
          `parseOptions: maxIterations must be a positive integer (got '${value}')`,
        );
      }
      out.maxIterations = n;
    } else if (key === "plannerModel") {
      out.plannerModel = value;
    } else if (key === "executorModel") {
      out.executorModel = value;
    } else if (key === "reviewerModel") {
      out.reviewerModel = value;
    } else if (key === "anthropicCliPath") {
      out.anthropicCliPath = value;
    } else if (key === "codexCliPath") {
      out.codexCliPath = value;
    }
  }
  return out;
}

/** Make FLOW_ID accessible at runtime without a separate import from `./config`. */
export const flowId: string = FLOW_ID;
