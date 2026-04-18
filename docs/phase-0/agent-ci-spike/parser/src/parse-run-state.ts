import fs from "node:fs";
import path from "node:path";
import type {
  AgentCIJob,
  AgentCIRunState,
  AgentCIWorkflow,
  CIJobSummary,
  CIRunSummary,
  CIWorkflowSummary,
  FailedStep,
} from "./types.ts";
import { classifyStep, parseStepLog } from "./parse-step-log.ts";

/**
 * Deterministically project an agent-ci `run-state.json` + its sibling step
 * logs into a shamu `CIRunSummary`.
 *
 * This function is pure-ish: it performs synchronous fs reads for step logs
 * when `readStepLog` is not provided. In tests we pass a stubbed reader.
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

  const workflows = state.workflows.map((wf) =>
    summarizeWorkflow(wf, readStepLog, opts),
  );

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

/**
 * Read + parse a run directory. Convenience wrapper used by the subprocess
 * driver and by any integration code that already has a run directory.
 */
export function parseRunDir(runDir: string, opts: ParseRunStateOptions = {}): CIRunSummary {
  const runStatePath = path.join(runDir, "run-state.json");
  const raw = fs.readFileSync(runStatePath, "utf-8");
  const state = JSON.parse(raw) as AgentCIRunState;
  return parseRunState(state, opts);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

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
    status: mapToTriStatus(wf.status, wf.jobs.map((j) => j.status)),
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

  let failureKind: CIJobSummary["failureKind"] = null;
  let failingTests: CIJobSummary["failingTests"] = [];
  let failureExcerpt: string[] = [];

  if (failedStep) {
    failureKind = classifyStep(failedStep);

    // Try to locate the step log.
    let stepLog: string | null = null;
    if (job.logDir) {
      const fname = sanitizeStepFilename(failedStep);
      stepLog = readStepLog(path.join(job.logDir, "steps", `${fname}.log`));
    }
    if (stepLog === null && job.lastOutputLines && job.lastOutputLines.length > 0) {
      stepLog = job.lastOutputLines.join("\n");
    }

    if (stepLog !== null) {
      const parsed = parseStepLog(failedStep, stepLog, {
        maxErrorLinesPerTest: opts.maxErrorLinesPerTest,
        maxFailingTests: opts.maxFailingTests,
        tailLines: opts.tailLines,
      });
      failureKind = parsed.kind;
      failingTests = parsed.failingTests;
      failureExcerpt = buildJobExcerpt(failingTests);
    } else if (job.lastOutputLines && job.lastOutputLines.length > 0) {
      failureExcerpt = job.lastOutputLines.slice(-10);
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

function jobStatus(job: AgentCIJob): "green" | "red" | "unknown" {
  if (job.status === "completed") return "green";
  if (job.status === "failed" || job.status === "paused") return "red";
  return "unknown";
}

function mapToTriStatus(
  reported: AgentCIRunState["status"],
  childStatuses: AgentCIRunState["status"][],
): "green" | "red" | "unknown" {
  if (reported === "completed") return "green";
  if (reported === "failed") return "red";
  // Defensively handle the "still running on disk" quirk by looking at children.
  if (childStatuses.some((s) => s === "failed" || s === "paused")) return "red";
  if (childStatuses.length > 0 && childStatuses.every((s) => s === "completed")) {
    return "green";
  }
  return "unknown";
}

function deriveRunStatus(workflows: CIWorkflowSummary[]): "green" | "red" | "unknown" {
  if (workflows.length === 0) return "unknown";
  if (workflows.some((w) => w.status === "red")) return "red";
  if (workflows.every((w) => w.status === "green")) return "green";
  return "unknown";
}

/**
 * agent-ci writes step log filenames by replacing non-alphanumerics with
 * dashes (observed empirically: "Run actions/checkout@v4" → "Run-actions-checkout-v4.log").
 * This mirrors that transformation.
 */
function sanitizeStepFilename(stepName: string): string {
  return stepName
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function buildJobExcerpt(failingTests: CIJobSummary["failingTests"]): string[] {
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
