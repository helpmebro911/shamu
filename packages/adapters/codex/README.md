# @shamu/adapter-codex

Production `AgentAdapter` for the OpenAI Codex CLI, wrapping
[`@openai/codex-sdk`](https://www.npmjs.com/package/@openai/codex-sdk) pinned
at `0.121.0`. Emits schema-compliant `AgentEvent`s from the SDK's JSONL
stream, enforces path-scope + shell-gate policy before tool dispatch, and
scrubs secrets via the shared `Redactor` before events leave the handle.

## What it does

- `spawn(opts)` resolves Codex auth, constructs a `Codex` instance, and
  starts a fresh thread via `startThread()`.
- `resume(sessionId, opts)` resumes a previously-started thread via
  `resumeThread(id)`. Session ids are the Codex thread ids.
- Every `send({text})` calls `thread.runStreamed(text, { signal })` and
  projects the JSONL `ThreadEvent`s into normalized `AgentEvent`s
  (`src/jsonl-projection.ts`).
- `interrupt()` aborts the turn via the SDK's AbortSignal and emits a
  synthetic `turn_end` so the consumer loop exits promptly.
- `shutdown()` drains any in-flight turn and closes the event queue.

## Auth strategies and precedence

The adapter accepts two auth paths and chooses between them based on
`SpawnOpts`:

1. **Pre-authenticated CLI (ChatGPT-OAuth)** — pass
   `SpawnOpts.vendorCliPath` pointing at a `codex` binary the user is
   already signed in with. The SDK receives it as `codexPathOverride`
   and spawns that CLI, which reads `~/.codex/auth.json` and
   authenticates via the ChatGPT subscription. **No env var consulted.**

2. **`CODEX_API_KEY` env var** — when `vendorCliPath` is absent we look
   for `CODEX_API_KEY` in the environment and pass it to the SDK as
   `apiKey`. The SDK propagates it to the spawned CLI's environment.

**Precedence.** `vendorCliPath` wins over `CODEX_API_KEY`. When both are
present the CLI path is honored and `CODEX_API_KEY` is deliberately
ignored — this matches Phase 0.B's finding that a pre-authenticated CLI
should not be silently upgraded to API billing.

Neither auth path present → `CodexAuthMissingError`
(`code: "adapter_auth_missing"`). The CLI's exit-code mapping catches
this and surfaces a non-zero status.

## Capabilities

Loaded from `src/capabilities.json` and frozen at module load (G8 —
capabilities are immutable at runtime).

| Field | Value | Notes |
|---|---|---|
| `resume` | `true` | `resumeThread(id)` |
| `fork` | `false` | No fork surface in the SDK |
| `interrupt` | `"cooperative"` | Via `AbortSignal` on `runStreamed` |
| `permissionModes` | `["default", "acceptEdits"]` | `default` → approvalPolicy="on-request"; `acceptEdits` → approvalPolicy="never" + sandboxMode="workspace-write" |
| `mcp` | `"stdio"` | CLI supports MCP via stdio |
| `customTools` | `false` | No custom-tool registration in the SDK surface |
| `patchVisibility` | `"events"` | `file_change` items expose paths |
| `usageReporting` | `"per-turn"` | `turn.completed.usage` |
| `costReporting` | `"subscription"` | SDK returns no dollar figure on any current path; schema asserts `usd: null` + `confidence: "unknown"` |
| `sandboxing` | `"process"` | CLI enforces the sandbox |
| `streaming` | `"events"` | Full JSONL event stream |

## JSONL event projection

See `src/jsonl-projection.ts` for the complete mapping table. Highlights:

- **`thread.started`** → one `session_start` (source=spawn; resume paths
  emit a synthetic one with source=resume before the first SDK event).
- **`turn.started`** — intentionally dropped. No `turn_start` kind in
  the canonical taxonomy (PLAN.md § 1). Turn membership is scoped via
  `turnId` on every envelope.
- **`item.completed:agent_message`** → `assistant_message`.
- **`item.completed:reasoning`** → `reasoning` (added post-0.B).
- **`item.started:command_execution`** → `tool_call` (tool=`shell`).
- **`item.completed:command_execution`** → `tool_result` with parent
  linkage.
- **`item.completed:file_change`** + `status="completed"` →
  `tool_result` + `patch_applied` (two events from one vendor event).
- **`item.completed:mcp_tool_call`** → `tool_result` for
  `tool="mcp:<server>.<tool>"`.
- **`turn.completed`** → `usage` + `cost` + `turn_end`.
- **`turn.failed` / `error`** → fatal `error` event.

## Security

- **Path-scope (G4)** — every `file_change` item's paths are validated
  against the worktree root before the CLI dispatches. Rejections
  surface as an `error` event + turn abort.
- **Shell gate (G5)** — every `command_execution` item's command string
  is parsed and policy-checked. `$()`, backticks, `eval`,
  pipes-to-shell, and process substitution are rejected under the
  default policy.
- **Redaction (G1)** — every string-valued payload runs through a
  `Redactor` before events leave the handle.
- **Immutable capabilities (G8)** — manifest is loaded once and frozen.

## Running the tests

Default tests are hermetic (no live vendor calls):

```bash
cd packages/adapters/codex
bun run test
```

### Contract suite

13 scenarios from `@shamu/adapters-base/contract`. All run against a
scripted SDK double so the suite is fast. The `stress-no-leaks`
iteration count is bumped to 100 by setting `STRESS_ITERATIONS=100`:

```bash
STRESS_ITERATIONS=100 bun run test
```

### Snapshot test

`test/snapshot.test.ts` locks the normalized event stream for one
canonical scripted turn. Regenerate with:

```bash
UPDATE_SNAPSHOTS=1 bun run test
```

The snapshot lives at `test/snapshots/canonical-turn.json`.

### Live-mode tests

`test/live/live.test.ts.skip` drives the REAL SDK against a locally-
installed `codex` CLI. Disabled by default (Vitest does not collect
`.skip` files). To run:

```bash
# Rename or symlink to enable:
mv test/live/live.test.ts.skip test/live/live.test.ts

# ChatGPT-OAuth path:
SHAMU_CODEX_LIVE=1 SHAMU_CODEX_CLI=/opt/homebrew/bin/codex bun x vitest run test/live/live.test.ts

# API-key path:
SHAMU_CODEX_LIVE=1 CODEX_API_KEY=sk-... bun x vitest run test/live/live.test.ts
```

`SHAMU_CODEX_LIVE=1` is the intent gate; without it the suite self-
skips. Live tests time out generously (60s) because they wait on real
model latency.
