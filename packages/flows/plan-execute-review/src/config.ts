/**
 * Defaults for the canonical plan -> execute -> review flow.
 *
 * Model identifiers match the strings passed verbatim to each adapter's
 * `SpawnOpts.model`:
 *   - Codex accepts any string; `gpt-5.4` is the planner+reviewer model per
 *     PLAN.md § 8. The Codex SDK (@openai/codex-sdk@0.121.0) routes this to
 *     whatever model Codex CLI is configured to use server-side; we do not
 *     validate against a whitelist because the model registry is owned by
 *     the vendor.
 *   - Claude accepts any string; `claude-opus-4-7` matches the vendor's
 *     current public model slug and mirrors the Claude adapter's own default
 *     in `@shamu/adapter-claude/src/index.ts` (`"claude-opus-4-7"`).
 *
 * Keeping these as module-level constants (rather than env-var fallbacks)
 * means the flow definition + prompts remain deterministic and covered by
 * snapshot tests. Overrides flow through `RegisterRunnersOptions`.
 */

export const DEFAULT_PLANNER_MODEL = "gpt-5.4" as const;
export const DEFAULT_EXECUTOR_MODEL = "claude-opus-4-7" as const;
export const DEFAULT_REVIEWER_MODEL = "gpt-5.4" as const;

/**
 * Upper bound on reviewer -> executor re-run cycles. PLAN.md § 8 names the
 * loop without pinning a cap; we pick five as a pragmatic ceiling that
 * aligns with the watchdog's cost-velocity signal window (see PLAN § 6).
 */
export const DEFAULT_MAX_ITERATIONS = 5;

export const FLOW_ID = "plan-execute-review" as const;
// v2: Phase 5.B inserted a `ci` node between execute and review, and the
// reviewer now reads CI summary + excerpt via ctx.priorOutputs.ci. The DAG
// shape affects content hashes + resumability; `flow_runs.dag_version` keys on
// this, so the bump is load-bearing -- resumes across a version boundary MUST
// invalidate cached outputs.
export const FLOW_VERSION = 2;
