# RFC: `@redwoodjs/agent-ci --report=json`

**Status:** Draft (internal; not yet filed upstream)
**Authors:** Shamu project, Phase 5.B
**Scope:** Feature request on `@redwoodjs/agent-ci`. Non-blocking for Shamu.

## Motivation

Shamu's quality gate (`@shamu/ci`) wraps agent-ci and consumes its output
as a deterministic machine-readable input for an LLM reviewer. Today the
gate has to:

1. Spawn agent-ci with `--quiet` (so the animated renderer is suppressed).
2. Diff `<workDir>/runs/` before and after the spawn to discover the run
   directory (agent-ci does not emit a stable identifier on stdout).
3. Parse `<runDir>/run-state.json` defensively — the top-level `status`
   field is a fire-and-forget save that the process may exit before
   flushing, so Shamu derives aggregate status from workflow + job
   statuses instead.
4. Walk each failing job's `logDir`, strip ANSI, and run TAP-13 / ESLint-
   stylish / tail-fallback extractors to reconstruct failing-test
   records.
5. Project the result into a `CIRunSummary` → `CIRed | PatchReady`
   domain event for the reviewer.

Steps 2–4 exist because agent-ci's on-disk layout is the de-facto API.
We are consuming implementation detail, and if agent-ci reshapes it,
Shamu breaks silently (we only notice when the reviewer prompt goes
empty).

A `--report=json` flag on agent-ci would replace steps 2–4 with a single
streamed JSON document: run id, workflow/job/step status, failing step
pointer, failing-test extraction, duration, log digest. Shamu's parser
collapses to "validate and forward" rather than "reverse-engineer the
on-disk layout."

## Proposed flag

```
agent-ci run [other flags] --report=json
```

Behavior:

- When `--report=json` is set, the stable JSON document is written to
  stdout. All other output (progress, animations, partial logs) is
  suppressed as if `--quiet` were set.
- The document is flushed on process exit, not fire-and-forget; a
  SIGTERM-graceful abort still flushes a partial document with
  `status: "aborted"` and `abortedAt`.
- `--report=json --report-file=<path>` optionally mirrors the document
  to a path in addition to stdout.

### Schema (sketch)

```jsonc
{
  "schemaVersion": "1.0",
  "runId": "run-01H...",
  "status": "green" | "red" | "unknown" | "aborted",
  "startedAt": "2026-04-18T12:00:00Z",
  "completedAt": "2026-04-18T12:05:42Z",
  "durationMs": 342_000,
  "workflows": [
    {
      "id": "ci",
      "path": ".github/workflows/ci.yml",
      "status": "red",
      "jobs": [
        {
          "id": "test-suite",
          "runnerId": "ubuntu-latest",
          "status": "red",
          "failedStep": "bun run test",
          "failureKind": "test" | "lint" | "typecheck" | "build" | "install" | "unknown",
          "failingTests": [
            {
              "name": "math > adds two numbers",
              "location": "packages/math/test/add.test.ts:12:3",
              "errorLines": ["AssertionError", "expected 4 to be 3"]
            }
          ],
          "failureExcerpt": ["tail-lines fallback when extractor misses"]
        }
      ]
    }
  ]
}
```

The shape deliberately mirrors Shamu's `CIRunSummary`. If agent-ci
prefers a different internal vocabulary, Shamu adapts — the ask is a
stable, versioned surface, not this exact shape.

## Backwards-compatibility

- Opt-in flag; no existing behavior changes when the flag is absent.
- `--report=json` implies `--quiet`; callers that want both the animated
  renderer AND a JSON report can pass `--report=json --no-quiet` if we
  decide to support that combination.
- `schemaVersion` allows forward compatibility: consumers pin a major
  version and tolerate minor-version additive fields.

## Alternatives considered

- **Status quo (on-disk parsing).** Works today; couples Shamu to
  agent-ci's file layout. Every agent-ci release is a potential
  integration break.
- **Parse stdout TAP/JUnit from the underlying test runners.** Does not
  cover lint/typecheck/build; fragments across workflow shapes.
- **Out-of-band sidecar process that watches `runs/`.** Adds a second
  process, doesn't solve the "top-level status is fire-and-forget"
  problem.

## Follow-ups / adjacencies

- A follow-on flag `--report-fd=<fd>` that routes the JSON document to a
  caller-provided file descriptor would simplify spawn-under-Bun (no
  stdout interleaving). Not blocking.
- A `--report=ndjson` variant that streams per-step events instead of a
  final document would enable Shamu to surface intra-run progress on
  the flow NDJSON sink. Also not blocking.

## Shamu-side impact if adopted

- `@shamu/ci/src/gate.ts` stops calling `listRunDirNames` +
  `diffRunDirs`. The gate reads stdout and validates against the
  published schema.
- `parse-run-state.ts` + `parse-step-log.ts` collapse to a thin
  schema-validation layer.
- The reviewer excerpt builder does not change — it is already the
  last pure-function step in the pipeline.
