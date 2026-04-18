/**
 * `@shamu/ci` — public surface.
 *
 * The Phase 5 quality-gate wrapper around `@redwoodjs/agent-ci`. Three roles:
 *
 *   - Spawn agent-ci (via `Bun.spawn`) with the minimal env + GITHUB_REPO
 *     invariant, discover the run directory, and return a gate result.
 *   - Parse agent-ci's `run-state.json` + per-step logs deterministically,
 *     deriving aggregate status from workflow + job statuses (never the
 *     fire-and-forget top-level field).
 *   - Project the parsed summary to `CIRed` / `PatchReady` domain events and
 *     build a token-bounded, deterministic reviewer excerpt.
 *
 * Track 5.B imports from here verbatim.
 */

export { stripAnsi, stripAnsiLines } from "./ansi.ts";
export {
  buildReviewerExcerpt,
  estimateTokens,
  toDomainEvent,
} from "./excerpt.ts";
export {
  buildAllowlistedEnv,
  DEFAULT_ENV_ALLOWLIST,
  type DockerReaper,
  defaultDockerReaper,
  defaultWorkingDir,
  diffRunDirs,
  GateBootError,
  type GateLogger,
  type GateResult,
  parseOriginToGithubRepo,
  type RunGateOptions,
  resolveGithubRepo,
  runGate,
} from "./gate.ts";
export { type ParseRunStateOptions, parseRunDir, parseRunState } from "./parse-run-state.ts";
export {
  classifyStep,
  parseEslintFailures,
  parseStepLog,
  parseTapFailures,
  tailFailure,
} from "./parse-step-log.ts";
export type {
  AgentCIJob,
  AgentCIRunState,
  AgentCIStatus,
  AgentCIStep,
  AgentCIWorkflow,
  CIDomainEvent,
  CIJobSummary,
  CIRed,
  CIRunSummary,
  CIWorkflowSummary,
  FailedStep,
  FailingTest,
  FailureKind,
  ParsedRunState,
  ParsedStepLog,
  PatchReady,
  ReviewerExcerpt,
  ReviewerExcerptOptions,
  TriStatus,
} from "./types.ts";
