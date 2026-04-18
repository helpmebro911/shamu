import type {
  CIDomainEvent,
  CIJobSummary,
  CIRunSummary,
  ReviewerExcerptOptions,
} from "./types.ts";

/**
 * Token-bounded reviewer excerpt.
 *
 * Heuristic (deterministic):
 *   1. Header: runId, aggregate status, failed step count.
 *   2. For each failed job (ordered by workflow id, then job id):
 *        - job header: `<workflow> > <job> > "<failedStep>"` + failureKind
 *        - up to `maxFailingTests` failing tests
 *            - each rendered as: `- <name>` + indented errorLines (≤ maxErrorLinesPerTest)
 *        - if no parseable failing tests, fall back to tail excerpt
 *   3. Trim to token budget by dropping lowest-priority failing tests last.
 *
 * The output is ASCII + unicode, no ANSI. Newline-joined.
 */
export function buildReviewerExcerpt(
  summary: CIRunSummary,
  opts: ReviewerExcerptOptions = {},
): string {
  const maxTokens = opts.maxTokens ?? 2000;
  const maxFailingTests = opts.maxFailingTests ?? 10;

  const failedJobs = failingJobs(summary);
  if (failedJobs.length === 0) {
    return renderHeader(summary, 0).join("\n");
  }

  // Build greedily, then trim if we overflow.
  const headerLines = renderHeader(summary, failedJobs.length);
  const jobBlocks: string[][] = failedJobs.map((j) => renderJobBlock(j, maxFailingTests));

  let rendered = [...headerLines, "", ...jobBlocks.flatMap((b, i) => (i === 0 ? b : ["", ...b]))];

  if (estimateTokens(rendered.join("\n")) <= maxTokens) {
    return rendered.join("\n");
  }

  // Overflow: progressively shrink. Strategy, in order:
  //   (a) cap failing-tests per job at 3, then 1;
  //   (b) drop whole jobs from the tail.
  const shrinkStages = [3, 1];
  for (const testCap of shrinkStages) {
    const shrunk = failedJobs.map((j) => renderJobBlock(j, testCap));
    rendered = [
      ...headerLines,
      "",
      ...shrunk.flatMap((b, i) => (i === 0 ? b : ["", ...b])),
      "",
      "(excerpt truncated to fit reviewer token budget)",
    ];
    if (estimateTokens(rendered.join("\n")) <= maxTokens) return rendered.join("\n");
  }

  // Still too big — drop failing jobs from the tail, one at a time.
  let keptJobs = failedJobs.slice();
  while (keptJobs.length > 1) {
    keptJobs = keptJobs.slice(0, -1);
    const shrunk = keptJobs.map((j) => renderJobBlock(j, 1));
    const dropped = failedJobs.length - keptJobs.length;
    rendered = [
      ...headerLines,
      "",
      ...shrunk.flatMap((b, i) => (i === 0 ? b : ["", ...b])),
      "",
      `(excerpt truncated — ${dropped} more failing job(s) omitted)`,
    ];
    if (estimateTokens(rendered.join("\n")) <= maxTokens) return rendered.join("\n");
  }

  // Last resort: header only.
  return [
    ...headerLines,
    "",
    "(excerpt truncated — all per-job detail omitted; raise maxTokens to see more)",
  ].join("\n");
}

/** Project a CIRunSummary into the shamu domain-event shape. */
export function toDomainEvent(
  summary: CIRunSummary,
  opts: ReviewerExcerptOptions = {},
): CIDomainEvent {
  if (summary.status === "red") {
    return {
      kind: "CIRed",
      runId: summary.runId,
      summary,
      reviewerExcerpt: buildReviewerExcerpt(summary, opts),
    };
  }
  return { kind: "PatchReady", runId: summary.runId, summary };
}

/**
 * Character-based token estimate. For English/code, ~4 chars/token is the
 * standard rough approximation. Deliberately conservative (overestimates) so
 * we stay under the reviewer budget.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

function failingJobs(summary: CIRunSummary): CIJobSummary[] {
  const out: CIJobSummary[] = [];
  for (const wf of summary.workflows) {
    for (const job of wf.jobs) {
      if (job.status === "red") out.push(job);
    }
  }
  return out;
}

function renderHeader(summary: CIRunSummary, failedJobCount: number): string[] {
  const lines: string[] = [];
  lines.push(`agent-ci run ${summary.runId}: ${summary.status.toUpperCase()}`);
  lines.push(
    `  workflows: ${summary.workflows.length}, steps: ${summary.totalSteps}, failed jobs: ${failedJobCount}, duration: ${formatDuration(summary.durationMs)}`,
  );
  if (summary.failedSteps.length > 0) {
    lines.push("  failed steps:");
    for (const s of summary.failedSteps) {
      lines.push(`    - ${s.workflowId} > ${s.jobId} > "${s.stepName}" (${s.failureKind})`);
    }
  }
  return lines;
}

function renderJobBlock(job: CIJobSummary, maxTests: number): string[] {
  const lines: string[] = [];
  const header = job.failedStep
    ? `[${job.runnerId}] failed at "${job.failedStep}" (${job.failureKind ?? "unknown"})`
    : `[${job.runnerId}] failed`;
  lines.push(header);

  if (job.failingTests.length > 0) {
    for (const t of job.failingTests.slice(0, maxTests)) {
      lines.push(`  - ${t.name}`);
      if (t.location) lines.push(`    at ${t.location}`);
      for (const el of t.errorLines) lines.push(`      ${el}`);
    }
    if (job.failingTests.length > maxTests) {
      lines.push(`  … ${job.failingTests.length - maxTests} more failing test(s) omitted`);
    }
  } else if (job.failureExcerpt.length > 0) {
    lines.push(`  excerpt:`);
    for (const l of job.failureExcerpt) lines.push(`    ${l}`);
  }
  return lines;
}

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
}
