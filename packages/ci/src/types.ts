/**
 * @shamu/ci — type surface.
 *
 * We model only the subset of `@redwoodjs/agent-ci`'s on-disk shapes that we
 * consume. These are NOT a semver'd public contract of that package, so we
 * parse defensively and pin nothing.
 *
 * Aggregate status and reviewer-facing summary shapes are ours.
 */

// --- agent-ci RunState (as persisted to <workDir>/runs/<runId>/run-state.json) ---

export type AgentCIStatus =
  | "queued"
  | "booting"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "skipped";

export interface AgentCIStep {
  name: string;
  index: number;
  status: AgentCIStatus;
  startedAt?: string | null;
  completedAt?: string | null;
  durationMs?: number;
}

export interface AgentCIJob {
  id: string;
  runnerId: string;
  status: AgentCIStatus;
  steps: AgentCIStep[];
  logDir?: string;
  debugLogPath?: string;
  failedStep?: string;
  pausedAtStep?: string;
  lastOutputLines?: string[];
  durationMs?: number;
  bootDurationMs?: number;
  startedAt?: string;
  completedAt?: string;
  attempt?: number;
}

export interface AgentCIWorkflow {
  id: string;
  path: string;
  status: AgentCIStatus;
  jobs: AgentCIJob[];
  startedAt?: string;
  completedAt?: string;
}

export interface AgentCIRunState {
  runId: string;
  /**
   * agent-ci's `RunStateStore.save()` is a fire-and-forget async write; the
   * process can exit before the final flush lands. Treat this field as
   * untrustworthy. The parser derives aggregate status from workflow + job
   * statuses instead.
   */
  status: AgentCIStatus;
  startedAt: string;
  completedAt?: string;
  workflows: AgentCIWorkflow[];
}

// --- Shamu-side summary shapes (stable) -------------------------------------

export type TriStatus = "green" | "red" | "unknown";

export type FailureKind = "test" | "lint" | "typecheck" | "build" | "install" | "unknown";

export interface FailingTest {
  /** TAP subtest name or ESLint rule + location. */
  name: string;
  /** Source location (file:line[:col]) if the extractor recognised one. */
  location: string | null;
  /**
   * Primary error lines the reviewer should see, ANSI-stripped. Bounded at
   * construction time; usually <= 6 lines.
   */
  errorLines: string[];
  /** Raw expected/actual for TAP assertion failures, when present. */
  expected?: string;
  actual?: string;
}

export interface FailedStep {
  workflowId: string;
  jobId: string;
  stepName: string;
  failureKind: FailureKind;
}

export interface CIJobSummary {
  id: string;
  runnerId: string;
  status: TriStatus;
  failedStep: string | null;
  durationMs: number | null;
  failureKind: FailureKind | null;
  failingTests: FailingTest[];
  /** Fallback excerpt lines when no failing tests were extracted. */
  failureExcerpt: string[];
}

export interface CIWorkflowSummary {
  id: string;
  path: string;
  status: TriStatus;
  jobs: CIJobSummary[];
}

export interface CIRunSummary {
  runId: string;
  status: TriStatus;
  durationMs: number;
  workflows: CIWorkflowSummary[];
  /** Total step count across all workflows and jobs. */
  totalSteps: number;
  /** Steps whose status === "failed". */
  failedSteps: FailedStep[];
}

export type ParsedRunState = CIRunSummary;

export interface ParsedStepLog {
  kind: FailureKind;
  failingTests: FailingTest[];
}

// --- Reviewer excerpt & domain events --------------------------------------

/**
 * The reviewer excerpt is the token-bounded, deterministic text the reviewer
 * agent sees. `buildReviewerExcerpt` returns just the string so both the
 * fixture snapshot tests and `toDomainEvent` can compare byte-identically.
 */
export type ReviewerExcerpt = string;

export interface ReviewerExcerptOptions {
  /** Approximate token budget. Default 2000. */
  maxTokens?: number;
  /** Max failing-test records to include per job. Default 10. */
  maxFailingTests?: number;
  /** Max error lines per failing test. Default 6. */
  maxErrorLinesPerTest?: number;
  /** Tail-lines fallback for step logs no extractor recognised. Default 40. */
  tailLines?: number;
}

/**
 * Domain events projected from a `CIRunSummary`. Locally defined in this
 * package; a future edit may hoist these into `@shamu/shared` if more than one
 * consumer needs them on the bus.
 */
export type CIDomainEvent = CIRed | PatchReady;

export interface CIRed {
  kind: "CIRed";
  runId: string;
  summary: CIRunSummary;
  /** Pre-rendered reviewer excerpt, token-bounded. */
  reviewerExcerpt: string;
}

export interface PatchReady {
  kind: "PatchReady";
  runId: string;
  summary: CIRunSummary;
}
