/**
 * Types for the agent-ci parser spike.
 *
 * These intentionally mirror only the subset of agent-ci's internal shapes we
 * need to consume — we do NOT re-export their internal types because they are
 * not part of a semver'd public contract. We parse defensively.
 */

// ─── agent-ci RunState (as persisted to <workDir>/runs/<runId>/run-state.json) ─

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
   * NOTE: in practice agent-ci often leaves this as `"running"` on disk even
   * after the run has exited, because `RunStateStore.save()` is an async
   * fire-and-forget write and the process may exit before the final save
   * flushes. Consumers MUST NOT trust this field — derive the aggregate
   * status from workflows + jobs.
   */
  status: AgentCIStatus;
  startedAt: string;
  completedAt?: string;
  workflows: AgentCIWorkflow[];
}

// ─── Shamu-side domain events (draft — align with PLAN.md §9/§10) ────────────

export interface CIRunSummary {
  runId: string;
  status: "green" | "red" | "unknown";
  durationMs: number;
  workflows: CIWorkflowSummary[];
  /** Total step count across all workflows and jobs. */
  totalSteps: number;
  /** Steps whose status === "failed". */
  failedSteps: FailedStep[];
}

export interface CIWorkflowSummary {
  id: string;
  path: string;
  status: "green" | "red" | "unknown";
  jobs: CIJobSummary[];
}

export interface CIJobSummary {
  id: string;
  runnerId: string;
  status: "green" | "red" | "unknown";
  failedStep: string | null;
  durationMs: number | null;
  /** Kind of failure if we can classify it from the step name + log. */
  failureKind: FailureKind | null;
  /**
   * Individual failing tests extracted from a step log, if the step log was
   * available and the heuristic recognised the format. Empty for non-test
   * steps or when we couldn't parse.
   */
  failingTests: FailingTest[];
  /** Primary failure message lines (ANSI-stripped, ≤ N lines). */
  failureExcerpt: string[];
}

export type FailureKind =
  | "test"
  | "lint"
  | "typecheck"
  | "build"
  | "install"
  | "unknown";

export interface FailedStep {
  workflowId: string;
  jobId: string;
  stepName: string;
  failureKind: FailureKind;
}

export interface FailingTest {
  /** TAP subtest name or ESLint rule/message */
  name: string;
  /** Location string as reported by the runner (file:line[:col]), if any. */
  location: string | null;
  /**
   * The primary error lines the reviewer should see. ANSI-stripped.
   * Bounded at construction time; usually ≤ 6 lines.
   */
  errorLines: string[];
  /** Optional raw expected/actual for assertion failures. */
  expected?: string;
  actual?: string;
}

// ─── Shamu domain-event projections (draft) ─────────────────────────────────

/**
 * Projected domain events a shamu quality-gate subscriber would emit based on
 * a parsed CIRunSummary. PLAN.md §9/§10 name these `CIRed` and `PatchReady`.
 */
export type CIDomainEvent =
  | {
      kind: "CIRed";
      runId: string;
      summary: CIRunSummary;
      /** Pre-rendered reviewer excerpt, token-bounded. */
      reviewerExcerpt: string;
    }
  | {
      kind: "PatchReady";
      runId: string;
      summary: CIRunSummary;
    };

export interface ReviewerExcerptOptions {
  /** Approximate token budget. Default 2000. */
  maxTokens?: number;
  /** Max failing-test records to include. Default 10. */
  maxFailingTests?: number;
  /** Max error lines per failing test. Default 6. */
  maxErrorLinesPerTest?: number;
  /** If a step log had no parseable tests, how many tail lines to fall back to. Default 40. */
  tailLines?: number;
}
