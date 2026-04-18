# Phase 0.D — agent-ci integration shape

## Summary

**Go.** `@redwoodjs/agent-ci` v0.10.7 ships a machine-readable run-state file
(`run-state.json`) plus per-step log files under a predictable directory layout.
Its shape is stable enough to parse deterministically today, and the 18-test
replay suite in `parser/` passes against three captured fixtures (green, red-test,
red-lint). Exit codes are meaningful. ANSI noise is the only nuisance, and is
easily stripped. The spike parser delivers a token-bounded reviewer excerpt in
well under the 2000-token budget.

Caveats: two quirks we must treat as integration concerns, not blockers:

1. The top-level `run-state.status` field often stays `"running"` on disk
   because agent-ci's `RunStateStore.save()` is an async fire-and-forget write
   and the process exits before the final flush lands. **Derive the run status
   from workflow + job statuses, not from `state.status`.**
2. `GITHUB_REPO` must be set in the environment (or via `--github-token` +
   `gh auth token`). Without it agent-ci crashes at boot with "Could not
   detect GitHub repository from git remotes." For shamu we will set this
   explicitly per run (from the worktree's `origin`).

Recommended upstream change (soft, not a blocker): a `--report=json` flag that
flushes an authoritative summary to a known path before exit would remove both
the "status frozen at running" quirk and the directory-hunting we do to find
the run dir. See the **Kill-switch findings** section for the exact spec.

## agent-ci output formats

### Invocation

```
npx @redwoodjs/agent-ci run --quiet --all [--pause-on-failure]
```

Agent-mode (`AI_AGENT=1` or `--quiet`) disables the live animated renderer
and switches to stderr transition lines — exactly what a harness wants.

### Exit codes

- `0` — all workflows green.
- `1` — at least one step failed, or a boot error (e.g., `GITHUB_REPO`
  missing, Docker not available). Boot errors print a `[Agent CI] Fatal
  error:` line to stderr with a Node stack trace.
- Non-zero exits from SIGINT/SIGTERM also observed (killing mid-run leaves
  Docker containers behind — cleanup required).

### stdout

Human text. When a run contains failures, agent-ci emits a `━━━ FAILURES ━━━`
block followed by a `━━━ SUMMARY ━━━` block. The FAILURES block contains,
per failing job: a `✗ <workflow> > <job> > "<step>"` header, then the contents
of the `failedStepLogPath` file inline. The SUMMARY is a 3-line
`Status: … / Duration: … / Root: …` block.

Example green stdout:

```
━━━ SUMMARY ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Status:    ✓ 1 passed (1 total)
  Duration:  6s
```

Example red-test stdout (abridged):

```
━━━ FAILURES ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  ✗ ci.yml > check > "Test"

> agent-ci-testrepo@0.0.1 test
> node --import tsx --test src/**/*.test.ts
TAP version 13
...
    not ok 2 - greets with a trailing period (intentional failure)
      ---
      location: '/home/runner/_work/testrepo/testrepo/src/index.test.ts:1:335'
      expected: 'Hello, Shamu.'
      actual: 'Hello, Shamu!'
      ...
```

### stderr

In agent-mode: one compact `  ✗ <stepName>` line per failed step, plus `time`
lines from the shell wrapper when enabled. Very small.

### Filesystem artefacts

This is the payload worth caring about. agent-ci writes a per-run directory
at `<workingDir>/runs/run-<timestampMs>/` and a per-runner directory at
`<workingDir>/runs/agent-ci-<n>/`.

`workingDir` default resolution (from `dist/output/working-directory.js`):

| Platform                   | Default                                                    |
|----------------------------|------------------------------------------------------------|
| macOS                      | `${TMPDIR}/agent-ci/agent-ci`                              |
| Linux (plain Docker)       | `/tmp/agent-ci/agent-ci`                                   |
| Linux + Docker Desktop     | `${XDG_CACHE_HOME:-~/.cache}/agent-ci/agent-ci`            |
| Inside container           | `${PROJECT_ROOT}/.agent-ci`                                |

Note: the `projectSlug` component is literally `agent-ci` (= the cli package
dir name), not the consumer's repo slug. This surprised us. Shamu should
point agent-ci at a stable per-run workspace via its own wrapper rather than
rely on the default.

Per-run layout we observed:

```
runs/
  run-1776469283296/
    run-state.json           ← primary structured output
    run-state.json.tmp       ← atomic-write partner (usually empty after exit)
  agent-ci-10/
    logs/
      debug.log              ← full runner debug
      timeline.json          ← GitHub-Actions timeline (per-step states)
      metadata.json          ← { workflowPath, workflowName, jobName, commitId, taskId, attempt }
      outputs.json           ← step outputs (set-output)
      steps/
        Set-up-job.log
        Install.log
        Lint.log
        Typecheck.log
        Test.log
        …
    work/                    ← runner scratch (repo checkout, etc.)
```

#### `run-state.json` schema (observed)

```jsonc
{
  "runId": "run-<ms>",
  "status": "running" | "completed" | "failed",
  "startedAt": "<ISO8601>",
  "completedAt": "<ISO8601>?",
  "workflows": [
    {
      "id": "<filename>.yml",
      "path": "<absolute path to workflow>",
      "status": "running" | "completed" | "failed" | "queued",
      "startedAt": "<ISO8601>?",
      "completedAt": "<ISO8601>?",
      "jobs": [
        {
          "id": "<job id>",
          "runnerId": "agent-ci-<n>",
          "status": "queued" | "running" | "completed" | "failed" | "paused",
          "failedStep": "<step name>?",
          "pausedAtStep": "<step name>?",
          "lastOutputLines": ["…"]?,
          "logDir": "<abs path>",
          "debugLogPath": "<abs path>",
          "startedAt": "<ISO8601>?",
          "bootDurationMs": <ms>?,
          "durationMs": <ms>?,
          "attempt": <int>?,
          "steps": [
            {
              "name": "<step name>",
              "index": <int>,
              "status": "pending" | "running" | "completed" | "failed" | "skipped",
              "startedAt": "<ISO8601>?",
              "completedAt": "<ISO8601>?",
              "durationMs": <ms>?
            },
            …
          ]
        }
      ]
    }
  ]
}
```

Everything after a successful step is persisted. On a failing job:

- `job.status = "failed"`
- `job.failedStep = "<step name>"`
- Steps after the failure have `status: "skipped"` with near-zero durations.
- Workflow status is `"failed"`.

The job-level `lastOutputLines` field is present only when agent-ci couldn't
locate the step log file (boot failures). In the common case — a step script
that exits non-zero — `logDir/steps/<stepName>.log` has the full output.

#### `timeline.json` schema

GitHub Actions–style timeline. Per-step records carry `state`, `result`
(`succeeded` | `failed`), `startTime`, `finishTime`, and a `log.id` that maps
to the numeric log file in the same `logs/` dir (e.g., `4870.log`). Redundant
with `run-state.json` for most consumers; useful as a cross-check.

#### Step log filenames

Derived from step names by replacing non-alphanumerics with `-`. Examples:

- `"Set up job"` → `Set-up-job.log`
- `"Run actions/checkout@v4"` → `Run-actions-checkout-v4.log`
- `"Lint"` → `Lint.log`

The parser's `sanitizeStepFilename` mirrors this.

#### ANSI in step logs

Step logs contain whatever the runner printed. ESLint and node:test both
force-colour under CI, so ANSI SGR codes are common. The parser strips them
with a conservative regex (`src/ansi.ts`).

## Stability assessment

Three concrete version-drift risks, ranked by how much damage they'd do:

| Risk                                                                   | Likelihood | Damage  | Mitigation |
|------------------------------------------------------------------------|------------|---------|------------|
| `run-state.json` schema additions (new fields)                         | high       | none    | We parse defensively — unknown fields ignored. |
| Step log filename sanitization changes                                 | medium     | medium  | Fall back to numeric-id logs via `timeline.json`'s `log.id` if the name-based lookup misses. Not implemented in the spike; tracked as a follow-up. |
| Top-level `state.status` suddenly becomes reliable (opposite quirk)    | medium     | none    | We already derive it from workflow statuses; a real `completed` / `failed` would just match. |
| Step log path moved or numeric-id-only                                 | low        | high    | Catch at parse time; degrade to `lastOutputLines` or step-wrapper stdout. |
| `--report=json` added upstream                                         | unknown    | good    | Switch to it as the primary input; keep run-state fallback. |
| Package renamed (`@redwoodjs/agent-ci` → something else)               | low        | low     | Wrapper already abstracts the spawn. |

Determinism is high within a version: for the same git tree the only varying
parts of `run-state.json` are timestamps, durations, `runId`, and `runnerId`.
The parser's test suite asserts byte-identical output for two passes over the
same fixture.

One real non-determinism note: **agent-ci's live-render debouncer (200 ms) +
fire-and-forget `save()` means the last state write may not reflect the final
status.** Shamu's wrapper re-reads `run-state.json` *after* the child exit
(not during) — which is when the atomic rename from `.tmp` has either landed
or isn't coming. The parser treats `state.status === "running"` as unknown
and re-derives.

## Parser design

Source: `docs/phase-0/agent-ci-spike/parser/`.

### Public API

```ts
// Subprocess driver — spawns agent-ci, finds the run dir, parses the result.
runAgentCI(opts: RunAgentCIOptions): Promise<RunAgentCIResult>

// File-driven parsing (for tests and replay).
parseRunDir(runDir: string, opts?): CIRunSummary
parseRunState(state: AgentCIRunState, opts?): CIRunSummary

// Reviewer-facing excerpt + shamu domain events.
buildReviewerExcerpt(summary, opts?): string
toDomainEvent(summary, opts?): CIDomainEvent  // "CIRed" | "PatchReady"

// Primitives.
parseStepLog(stepName, raw, opts?): { kind, failingTests }
parseTapFailures(raw, opts?): FailingTest[]
parseEslintFailures(raw, opts?): FailingTest[]
tailFailure(raw, tailLines): FailingTest[]
stripAnsi(s): string
```

### Parse strategy

1. **Locate the run dir.** The driver records the set of `run-*` directories
   in the working dir *before* spawn, then diffs after exit. The single new
   entry is the run dir. This avoids parsing agent-ci's own stdout, which
   has no machine-readable pointer to the run dir.
2. **Read `run-state.json`** for workflow + job + step structure. Defensive
   about unknown fields.
3. **Derive run status** from workflow statuses, then job statuses —
   *never* from `state.status`, which is unreliable on disk.
4. **For each failed job**, classify the failed step (`test` / `lint` /
   `typecheck` / `build` / `install` / `unknown`) by step-name keyword, then
   read `<logDir>/steps/<sanitized>.log`.
5. **Parse the step log** with a format-specific extractor:
   - **TAP 13** (node:test, tap, ava): `not ok N - <name>` followed by an
     optional `---` … `...` YAML block. Extracts `location`, `expected`,
     `actual`, and a short `error:` excerpt. Drops "subtest failed" rollups.
   - **ESLint stylish**: `<file>` header + `L:C  error  <msg>  <rule>` rows.
     Only `error` severity is reported; `warning` is suppressed.
   - **Fallback**: last N non-blank lines (ANSI-stripped) as a single
     synthetic failure record.
6. **Render excerpt** with a deterministic greedy-then-trim algorithm (see
   next section).

### Failure modes (what we tolerate)

- `run-state.json` unreadable / malformed JSON → `summary = null`, domain
  event = null, caller gets stdout/stderr/exitCode only.
- Step log missing → fall back to `job.lastOutputLines`, then empty.
- TAP with no YAML blocks → subtest names extracted without expected/actual.
- ESLint output with no `error`-severity rows → falls through to tail.
- ANSI with rare sequences not covered by the regex → left in, but wrapped
  in a token-estimator that overestimates so budget is still respected.

### Not implemented (follow-ups for Phase 5)

- **Vitest/Mocha/Jest native reporters**: if a repo uses a non-TAP reporter,
  we only get the tail fallback. Phase 5 should ship per-reporter
  extractors as they're needed — start with vitest since shamu uses it.
- **Numeric log-id fallback** via `timeline.json` `log.id`. Low priority
  unless we see a step-name-sanitization mismatch in the wild.
- **Secret redaction**: shamu's central redactor (PLAN.md § Security) runs
  on the projected `events` table. The parser doesn't redact; it feeds the
  redactor.
- **JUnit XML** ingestion. agent-ci doesn't emit JUnit today; if the wrapped
  workflow does (as an upload-artefact step), we could grab it. Not needed
  for the gate since TAP + ESLint covers 95% of what the spike cares about.

## Reviewer-excerpt extractor

**Heuristic.** Deterministic, greedy-then-shrink:

1. **Header** (always): run id, aggregate status (`GREEN`/`RED`/`UNKNOWN`),
   workflow count, step count, failed-job count, duration. If any steps
   failed, list them as `<workflow> > <job> > "<step>" (<kind>)`.
2. **Per failing job** (ordered by workflow id, then job id):
   - `[runnerId] failed at "<failedStep>" (<kind>)`
   - Up to N failing tests:
     - `- <test name>`
     - `  at <location>` (if present)
     - Up to M error lines, indented.
3. **Trim to budget.** Estimate tokens at `ceil(chars / 3.5)` (deliberately
   high so we stay under the 2000 budget). If over:
   - Shrink per-job failing tests to 3, then to 1.
   - Drop failing jobs from the tail one at a time, appending
     `(excerpt truncated — N more failing job(s) omitted)`.
   - Last resort: header only + explainer.

**Token budget.** Default 2000 tokens. With the three captured fixtures the
red-test excerpt comes in at ≈ 100 tokens, red-lint at ≈ 80, green at ≈ 15.
Headroom is enormous; the trim path fires only on pathological fan-outs.

**Worked example — red-test fixture:**

Input: `red-test-run-state.json` + `red-test-step-Test.log` (3141 bytes
of TAP output with ANSI).

Output:

```
agent-ci run run-1776470352075: RED
  workflows: 1, steps: 10, failed jobs: 1, duration: 2s
  failed steps:
    - ci.yml > check > "Test" (test)

[agent-ci-15] failed at "Test" (test)
  - greets with a trailing period (intentional failure)
    at /home/runner/_work/testrepo/testrepo/src/index.test.ts:1:335
      Expected values to be strictly equal:
      actual expected
      'Hello, Shamu!.'
      code: 'ERR_ASSERTION'
      name: 'AssertionError'
      expected: 'Hello, Shamu.'
  - add handles negatives
    at /home/runner/_work/testrepo/testrepo/src/index.test.ts:1:478
      Expected values to be strictly equal:
      -2 !== -3
      code: 'ERR_ASSERTION'
      name: 'AssertionError'
      expected: -3
      actual: -2
```

The typed `FailingTest` carries structured `expected` / `actual` fields in
addition to the rendered `errorLines`, so reviewers that want programmatic
access get both.

## Fixtures

Stored in `docs/phase-0/agent-ci-spike/fixtures/`. Committed verbatim,
regenerate by re-running the testrepo at the corresponding commit.

| File                          | Shape                                   |
|-------------------------------|-----------------------------------------|
| `green-run-state.json`        | All steps completed, `workflow.status=completed`. Top-level `state.status` is still `"running"` on disk (the agent-ci quirk). |
| `green-timeline.json`         | Reference: Actions-timeline view of a green run. |
| `green-stdout.txt`            | 5-line SUMMARY block only.              |
| `green-stderr.txt`            | Empty modulo `time` wrapper.            |
| `red-test-run-state.json`     | `workflow.status=failed`, `job.failedStep="Test"`, steps after Test `skipped`. |
| `red-test-step-Test.log`      | TAP 13 with 5 tests, 2 failing (assertion errors + Node test-runner YAML blocks). |
| `red-test-timeline.json`      | Timeline with `result: failed` on the Test task. |
| `red-test-metadata.json`      | Runner metadata block.                  |
| `red-test-stdout.txt`         | FAILURES block + inlined TAP output + SUMMARY. |
| `red-test-stderr.txt`         | One `  ✗ Test` line.                    |
| `red-lint-run-state.json`     | `workflow.status=failed`, `job.failedStep="Lint"`, Typecheck/Test/Capture-outputs all `skipped`. |
| `red-lint-step-Lint.log`      | ESLint stylish output with 2 errors (no-var, no-unused-vars) and ANSI colours. |
| `red-lint-timeline.json`      | Timeline with `result: failed` on Lint. |
| `red-lint-stdout.txt`         | FAILURES block + inlined ESLint output + SUMMARY. |
| `red-lint-stderr.txt`         | One `  ✗ Lint` line.                    |

Test driver: `parser/test/parse-run-state.test.ts` (18 cases). Run with
`cd docs/phase-0/agent-ci-spike/parser && npm test` — no Docker, no network.

Testrepo: `docs/phase-0/agent-ci-spike/testrepo/` (its own git repo, not
tracked by the outer shamu repo — ignored in `agent-ci-spike/.gitignore`).
Git history:

```
e67b55f Restore to green baseline
57b604c Induce lint failure (var + unused)
dc19c34 Induce test failure
4663155 Fix lint: use typescript-eslint parser
f8c807e Initial testrepo for agent-ci spike
```

## Kill-switch findings

**Not triggered.** agent-ci is parseable today. That said, we spec the
upstream ask we'd like to see eventually, strictly as an ergonomic
improvement, not a blocker:

### Upstream ask (soft) — `--report=json`

Propose adding a flag to `@redwoodjs/agent-ci run`:

```
agent-ci run --all --quiet --report=json [--report-path=<path>]
```

Semantics:

- After every workflow has completed (including cleanup), emit a single JSON
  document to `--report-path` (default: `<workDir>/runs/<runId>/report.json`)
  before process exit. The write is synchronous so consumers can read it on
  exit.
- Schema: same shape as the existing in-memory `RunState`, but with the
  top-level `status` + `completedAt` guaranteed filled.
- Adding per-job fields is fine; consumers parse defensively.

Why: removes the "status frozen at running" quirk (1) and the
run-dir-hunting in our wrapper (we could point at a caller-chosen path
instead of diffing `runs/`).

Shamu's integration does *not* depend on this landing — the parser already
tolerates both quirks. File the RFC during Phase 5 as part of dogfooding.

### Hard problems we did encounter (not blockers)

1. **`GITHUB_REPO` is mandatory.** agent-ci insists on resolving a GitHub
   repo slug at boot. Workaround: shamu sets `GITHUB_REPO=<owner>/<repo>`
   explicitly per run from the worktree's origin. Documented in the spike.
2. **Killing a run mid-execution orphans Docker containers.** Our interrupt
   path needs to `docker kill` agent-ci containers after SIGTERM to the
   parent, or shamu's supervisor will leak. File names we observed:
   `agent-ci-<n>`. The existing `packages/ci/gate` wrapper should call
   agent-ci's own `abort` command first, then reap containers as a safety
   net.
3. **`--pause-on-failure` blocks forever waiting on signals.** For the
   automated gate path we omit this flag. For interactive human debugging
   a separate command can enable it.

## What to change in PLAN.md

- **§ 10 Quality gate**: change "parse JUnit/JSON output" to "parse
  `run-state.json` + step logs"; JUnit XML isn't what agent-ci emits.
  Keep JUnit as a possible reviewer input *when the wrapped workflow
  includes a JUnit reporter of its own* — but it's not on the critical path.
- **§ 10 Quality gate**: add a note that the CI wrapper must set
  `GITHUB_REPO` from the worktree's `origin` remote before spawn; document
  as an invariant of the adapter, not a user responsibility.
- **§ 10 Quality gate**: add a note that the CI wrapper must reap any
  orphaned `agent-ci-<n>` Docker containers on interrupt/SIGTERM. A
  retry-safe cleanup step.
- **§ 10 Quality gate**: the reviewer-context extractor heuristic is
  **token-bounded (2000 default), deterministic, TAP/ESLint-aware with a
  tail fallback**. Move this paragraph from "handwave" to a committed
  contract surface, because the reviewer agent's prompt shape depends on it.
- **Phase 5 Track 5.A**: replace "spawn `agent-ci`, parse JUnit/JSON" with
  the observed output spec (run-state.json + per-step log files under
  `<workDir>/runs/<runId>/`) and the `CIRed` / `PatchReady` domain-event
  projection. Acceptance criterion: the three fixtures in this spike must
  parse to the same summary under the production gate package.
- **Phase 5 Track 5.C**: add an optional third enforcement path — file an
  RFC with upstream agent-ci for `--report=json`. Non-blocking; a stretch
  goal for contribution-back once the gate is stable.
- **§ Immediate next step**: add that the Phase 0 spike artifacts
  (`docs/phase-0/agent-ci-spike/parser/`) seed Phase 5's `packages/ci/`
  package. The parser module lifts directly; only the subprocess driver
  (`run-agent-ci.ts`) needs to be reshaped to Bun's `Bun.spawn` from
  Node's `child_process.spawn` when the repo moves to Bun.
