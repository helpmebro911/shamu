import fs from "node:fs";
import path from "node:path";
import { stripAnsi } from "./ansi.ts";
import { classifyStep, parseStepLog } from "./parse-step-log.ts";
import type {
  AgentCIJob,
  AgentCIRunState,
  AgentCIStatus,
  AgentCIWorkflow,
  CIJobSummary,
  CIRunSummary,
  CIWorkflowSummary,
  FailedStep,
  FailingTest,
  FailureKind,
  TriStatus,
} from "./types.ts";

/**
 * Deterministically project an agent-ci `run-state.json` + its sibling step
 * logs into a `CIRunSummary`.
 *
 * Pure-ish: reads step logs synchronously via `readStepLog`. Tests inject a
 * map-backed reader; production reads from disk.
 */
export interface ParseRunStateOptions {
  /** Override the step-log reader for tests / replay. Keyed on absolute path. */
  readStepLog?: (logPath: string) => string | null;
  /** Per-test max error lines. Default 6. */
  maxErrorLinesPerTest?: number;
  /** Max failing tests per job. Default 10. */
  maxFailingTests?: number;
  /** Tail lines for unparsed step logs. Default 40. */
  tailLines?: number;
}

export function parseRunState(
  state: AgentCIRunState,
  opts: ParseRunStateOptions = {},
): CIRunSummary {
  const readStepLog = opts.readStepLog ?? defaultReadStepLog;

  const workflows = state.workflows.map((wf) => summarizeWorkflow(wf, readStepLog, opts));

  const failedSteps: FailedStep[] = [];
  let totalSteps = 0;
  let totalDuration = 0;
  for (const wf of state.workflows) {
    for (const job of wf.jobs) {
      totalSteps += job.steps.length;
      totalDuration += job.durationMs ?? 0;
      for (const step of job.steps) {
        if (step.status === "failed") {
          failedSteps.push({
            workflowId: wf.id,
            jobId: job.id,
            stepName: step.name,
            failureKind: classifyStep(step.name),
          });
        }
      }
    }
  }

  const status = deriveRunStatus(workflows);

  return {
    runId: state.runId,
    status,
    durationMs: totalDuration,
    workflows,
    totalSteps,
    failedSteps,
  };
}

/** Convenience: read `<runDir>/run-state.json` and parse it. */
export function parseRunDir(runDir: string, opts: ParseRunStateOptions = {}): CIRunSummary {
  const runStatePath = path.join(runDir, "run-state.json");
  const raw = fs.readFileSync(runStatePath, "utf-8");
  const state = JSON.parse(raw) as AgentCIRunState;
  return parseRunState(state, opts);
}

// --- Helpers ----------------------------------------------------------------

function defaultReadStepLog(logPath: string): string | null {
  try {
    return fs.readFileSync(logPath, "utf-8");
  } catch {
    return null;
  }
}

function summarizeWorkflow(
  wf: AgentCIWorkflow,
  readStepLog: (p: string) => string | null,
  opts: ParseRunStateOptions,
): CIWorkflowSummary {
  return {
    id: wf.id,
    path: wf.path,
    status: mapToTriStatus(
      wf.status,
      wf.jobs.map((j) => j.status),
    ),
    jobs: wf.jobs.map((job) => summarizeJob(job, readStepLog, opts)),
  };
}

function summarizeJob(
  job: AgentCIJob,
  readStepLog: (p: string) => string | null,
  opts: ParseRunStateOptions,
): CIJobSummary {
  const failedStep =
    job.failedStep ??
    job.pausedAtStep ??
    job.steps.find((s) => s.status === "failed")?.name ??
    null;

  let failureKind: FailureKind | null = null;
  let failingTests: FailingTest[] = [];
  let failureExcerpt: string[] = [];

  if (failedStep) {
    failureKind = classifyStep(failedStep);

    // Try to locate the step log. Strip ANSI before either extractor sees the
    // text so the downstream parsers (and any later redactor pass) work
    // against normalised input.
    let stepLog: string | null = null;
    if (job.logDir) {
      const fname = sanitizeStepFilename(failedStep);
      const raw = readStepLog(path.join(job.logDir, "steps", `${fname}.log`));
      stepLog = raw === null ? null : stripAnsi(raw);
    }
    if (stepLog === null && job.lastOutputLines && job.lastOutputLines.length > 0) {
      stepLog = stripAnsi(job.lastOutputLines.join("\n"));
    }

    if (stepLog !== null) {
      const stepOpts: {
        maxErrorLinesPerTest?: number;
        maxFailingTests?: number;
        tailLines?: number;
      } = {};
      if (opts.maxErrorLinesPerTest !== undefined) {
        stepOpts.maxErrorLinesPerTest = opts.maxErrorLinesPerTest;
      }
      if (opts.maxFailingTests !== undefined) stepOpts.maxFailingTests = opts.maxFailingTests;
      if (opts.tailLines !== undefined) stepOpts.tailLines = opts.tailLines;
      const parsed = parseStepLog(failedStep, stepLog, stepOpts);
      failureKind = parsed.kind;
      failingTests = parsed.failingTests;
      failureExcerpt = buildJobExcerpt(failingTests);
    } else if (job.lastOutputLines && job.lastOutputLines.length > 0) {
      failureExcerpt = job.lastOutputLines.slice(-10).map((l) => stripAnsi(l));
    }
  }

  return {
    id: job.id,
    runnerId: job.runnerId,
    status: jobStatus(job),
    failedStep,
    durationMs: job.durationMs ?? null,
    failureKind,
    failingTests,
    failureExcerpt,
  };
}

function jobStatus(job: AgentCIJob): TriStatus {
  if (job.status === "completed") return "green";
  if (job.status === "failed" || job.status === "paused") return "red";
  return "unknown";
}

/**
 * Workflow tri-status derivation.
 *
 * Intentionally consults BOTH the reported workflow status AND the child job
 * statuses, because agent-ci may leave the reported workflow status as
 * `"running"` on disk when the process exits before the final flush (the
 * same fire-and-forget quirk that makes top-level run-state.status
 * untrustworthy).
 */
function mapToTriStatus(reported: AgentCIStatus, childStatuses: AgentCIStatus[]): TriStatus {
  if (reported === "completed") return "green";
  if (reported === "failed") return "red";
  if (childStatuses.some((s) => s === "failed" || s === "paused")) return "red";
  if (childStatuses.length > 0 && childStatuses.every((s) => s === "completed")) {
    return "green";
  }
  return "unknown";
}

/**
 * Run-aggregate status. NEVER reads top-level `state.status` — that field is a
 * fire-and-forget save and agent-ci may exit before flushing. We derive from
 * the per-workflow tri-status (which itself consults its children).
 */
function deriveRunStatus(workflows: CIWorkflowSummary[]): TriStatus {
  if (workflows.length === 0) return "unknown";
  if (workflows.some((w) => w.status === "red")) return "red";
  if (workflows.every((w) => w.status === "green")) return "green";
  return "unknown";
}

/**
 * agent-ci writes step log filenames by replacing non-alphanumerics with
 * dashes (observed empirically: "Run actions/checkout@v4" ->
 * "Run-actions-checkout-v4.log"). We mirror that transformation.
 */
function sanitizeStepFilename(stepName: string): string {
  return stepName.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function buildJobExcerpt(failingTests: FailingTest[]): string[] {
  const out: string[] = [];
  for (const t of failingTests) {
    const header = t.location ? `${t.name} @ ${t.location}` : t.name;
    out.push(header);
    for (const line of t.errorLines) out.push(`  ${line}`);
    out.push("");
  }
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out;
}
