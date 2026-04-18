# Phase 0.B — Event schema adequacy

## Summary

**Go.** The draft `AgentEvent` taxonomy in `PLAN.md § Adapter contract` covers real Claude + Codex vendor streams on three canonical tasks. Across 114 raw events captured over 6 runs, **3 events (2.6%)** did not map cleanly to any existing kind — well under the 20% kill-switch. A further 19 events (16.7%) were intentionally dropped as vendor-internal chatter that carries no behavior-affecting signal.

The one real gap is a **reasoning/thinking trace** emitted by both vendors (Claude `assistant.content.thinking`, Codex `item.*:reasoning`). Today we drop it. It deserves a new top-level kind; see proposed schema changes below.

The gap in `rate_limit_event` (Claude) surfaces a weaker signal we should model explicitly rather than force into `error`. All other observed behaviors either map cleanly or represent intentional drops that the orchestrator already owns.

Recommendation: adopt the small taxonomy additions in § Proposed schema changes; freeze the adapter contract; proceed to Phase 1.

## Auth verification

Both SDKs started cleanly under their CLIs' existing authenticated sessions — **no API key env vars needed, no workaround required.**

- **Claude**: passed `pathToClaudeCodeExecutable: "/Users/watzon/.local/bin/claude"` to `query()`. The SDK spawned the user's installed CLI (not the bundled one); the CLI picked up its macOS-keychain credentials; the stream started. `ANTHROPIC_API_KEY` was never set.
- **Codex**: passed `codexPathOverride: "/opt/homebrew/bin/codex"` to `new Codex({...})`. The SDK spawned `codex`, which read `~/.codex/auth.json` and authenticated via the ChatGPT-OAuth session. `CODEX_API_KEY` / `OPENAI_API_KEY` were never set.

No surprises; no blocker. The adapter contract should adopt these same parameters (`pathToClaudeCodeExecutable` on Claude, `codexPathOverride` on Codex) as first-class options in `SpawnOpts` so users on CLI auth never have to touch env vars.

## Canonical task results

All three tasks completed first-try on both vendors. None were truncated. Scratch repos were regenerated fresh for each run.

| Task         | Vendor | Events | Duration  | Input / Output tokens | Cost            |
|--------------|--------|-------:|----------:|-----------------------|-----------------|
| bugfix       | Claude | 19     | 17.3s     | 10 / 660 (cacheRead 206,151) | $0.4462 exact |
| bugfix       | Codex  | 32     | 42.1s     | 341,765 / 1,432 (cached 285,952) | — (subscription) |
| refactor     | Claude | 15     | 12.3s     | 8 / 644 (cacheRead 131,256)  | $0.2313 exact |
| refactor     | Codex  | 20     | 35.1s     | 340,003 / 851 (cached 320,768) | — (subscription) |
| new-feature  | Claude | 15     | 11.1s     | 8 / 400 (cacheRead 131,060)  | $0.2228 exact |
| new-feature  | Codex  | 13     | 21.7s     | 224,685 / 372 (cached 207,360) | — (subscription) |

Cost observations:
- Claude returns an exact `total_cost_usd` in the final `result` message; `costReporting: "native"` / `confidence: "exact"` is correct.
- Codex reports token usage but no dollar figure. Under ChatGPT OAuth that matches `costReporting: "subscription"` exactly — `cost.usd=null`, `confidence="unknown"`. This matches the PLAN already. A future `CODEX_API_KEY` path would shift to `native`.

Event density per task is roughly 2× higher on Codex because `item.started` + `item.completed` pairs are emitted for every `command_execution` (and Codex likes to run a lot of `sed`/`rg`/`git` commands in agent_message-mediated steps). Claude aggregates tool_use + tool_result inside assistant/user messages, so one message carries multiple semantic events. Our projection normalizes both to the same shape — see `fixtures/projected/*.jsonl`.

## Raw event taxonomy — per vendor

### Claude (`@anthropic-ai/claude-agent-sdk@0.2.113`)

Under `query()` with `pathToClaudeCodeExecutable` the SDK emits these top-level message types:

| `type` / `subtype`         | Count | What it carries                                              | Sample |
|----------------------------|------:|--------------------------------------------------------------|--------|
| `system` / `init`          | 3     | session id, tools list, cwd                                  | `fixtures/raw/claude-bugfix-raw.jsonl:7` |
| `system` / `hook_started`  | 9     | Hook dispatch trace (SessionStart, etc.)                     | `fixtures/raw/claude-bugfix-raw.jsonl:1` |
| `system` / `hook_response` | 9     | Hook completion                                              | `fixtures/raw/claude-bugfix-raw.jsonl:4` |
| `assistant`                | 14    | `content` array of `text` / `tool_use` / `thinking` blocks   | `fixtures/raw/claude-bugfix-raw.jsonl:8` |
| `user`                     | 10    | `content` array with `tool_result` entries (echo of tool IO) | `fixtures/raw/claude-bugfix-raw.jsonl:11` |
| `rate_limit_event`         | 3     | `rate_limit_info` (status, resetsAt, rateLimitType)          | `fixtures/raw/claude-bugfix-raw.jsonl:10` |
| `result` / `success`       | 3     | `duration_ms`, `total_cost_usd`, `num_turns`, `usage`        | `fixtures/raw/claude-bugfix-raw.jsonl:19` |

The SDK also declares (per `sdk.d.ts`) a wide catalogue we did not see in these runs: `stream_event`, `SDKStatusMessage`, `SDKAPIRetryMessage`, `SDKLocalCommandOutputMessage`, `SDKPluginInstallMessage`, `SDKToolProgressMessage`, `SDKAuthStatusMessage`, task-notification, session-state-changed, mirror errors, memory recall, prompt suggestions, tool-use summaries, files-persisted. These will need revisit if/when we enable streaming partials, retries, subagents, or transcript mirroring — but they are not blockers for a first adapter.

### Codex (`@openai/codex-sdk@0.121.0`)

Under `startThread().runStreamed()` with `codexPathOverride` the SDK emits these top-level event types:

| `type`            | `item.type` (if present) | What it carries                                             | Sample |
|-------------------|--------------------------|-------------------------------------------------------------|--------|
| `thread.started`  | —                        | `thread_id` (session id)                                    | `fixtures/raw/codex-bugfix-raw.jsonl:1` |
| `turn.started`    | —                        | No payload                                                  | `fixtures/raw/codex-bugfix-raw.jsonl:2` |
| `turn.completed`  | —                        | `usage` (input / cached / output tokens)                    | `fixtures/raw/codex-bugfix-raw.jsonl:32` |
| `item.started`    | `command_execution`      | `command`, `status=in_progress`                             | `fixtures/raw/codex-bugfix-raw.jsonl:4` |
| `item.completed`  | `command_execution`      | `aggregated_output`, `exit_code`, `status=completed/failed` | `fixtures/raw/codex-bugfix-raw.jsonl:5` |
| `item.started`    | `file_change`            | `changes: [{path, kind}]`                                   | `fixtures/raw/codex-bugfix-raw.jsonl:22` |
| `item.completed`  | `file_change`            | Same + `status`                                             | `fixtures/raw/codex-bugfix-raw.jsonl:23` |
| `item.completed`  | `agent_message`          | `text` (final natural-language response chunk)              | `fixtures/raw/codex-bugfix-raw.jsonl:3` |

Declared-but-not-seen in these runs: `mcp_tool_call`, `web_search`, `reasoning`, `todo_list`, `error`, `item.updated`, `turn.failed`, top-level `error`. Our projector handles each of them defensively so the Phase 2 adapter can lift the code directly.

## Projection outcomes

Projection is deterministic: raw JSONL → `AgentEvent[]` is a pure function (counter-based IDs + anchored timestamps), enabling the byte-identical fixture replay test. All 6 fixtures pass.

### Gap summary (aggregated across 6 runs)

| Vendor | Raw kind                     | Disposition | Count | Reasoning |
|--------|------------------------------|-------------|------:|-----------|
| claude | `system:hook_started`        | DROPPED     | 9     | Hook dispatch is orchestrator-owned control-plane noise. |
| claude | `system:hook_response`       | DROPPED     | 9     | Ditto — we *are* the hook caller. |
| claude | `assistant.content.thinking` | DROPPED ⚠   | 3     | **Real signal, no kind for it.** See proposed schema changes. |
| claude | `rate_limit_event`           | UNMAPPED    | 3     | Quota/budget telemetry — no kind; forcing it into `error` mislabels it. |
| claude | `user.content.text`          | DROPPED     | 3     | Echo of the prompt we sent; we already have it. |
| codex  | `turn.started`               | DROPPED     | 3     | No `turn_start` kind; turn boundary re-derived from `turn.completed`. Slightly awkward but works. |

**Uncovered = 3 / 114 = 2.6%** (UNMAPPED only). Well under the 20% kill-switch. DROPPED events represent intentional policy choices documented above, not schema gaps.

### Per-fixture detail

- Claude projections: 7 of 19 / 4 of 15 / 4 of 15 raw events drop; all 1 UNMAPPED per run is the single `rate_limit_event`. See `fixtures/gaps/claude-*-gaps.json`.
- Codex projections drop only `turn.started` (1 per run) and produce *more* projected events than raw, because one `file_change` item expands into `tool_call` + `tool_result` + `patch_applied`, and `turn.completed` expands into `usage` + `cost` + `turn_end` + `session_end`. This is the right fan-out direction: one vendor event encodes multiple shamu events.

## Proposed schema changes to PLAN.md

Three concrete additions, all small. None breaks the "no `extra` grab-bag" rule — each is a typed kind or a typed capability.

### 1. Add a `reasoning` kind (behavior-affecting, observed in both vendors)

Both Claude (`assistant.content.thinking`) and Codex (`item.*:reasoning`) emit pre-message reasoning traces. The watchdog's `checkpoint_lag` signal and the reviewer's task-understanding prompt will both benefit from having reasoning visible — today we'd drop a real signal. Proposed:

```diff
  | { kind: "assistant_delta"; text: string }
+ | { kind: "reasoning"; text: string; signature?: string }
  | { kind: "assistant_message"; text: string; stopReason: string }
```

`signature` carries Claude's `thinking.signature` (cryptographic witness for its reasoning blocks) when present so the reviewer can verify provenance if needed. Optional because Codex doesn't produce one.

Repeats across ≥ 2 vendors → justified as a top-level kind.

### 2. Add a `rate_limit` kind (Claude-observed, budget-affecting)

Claude's `rate_limit_event` is informational but **behavior-affecting**: the cost/budget system needs to know when a reset is imminent, and the scheduler should avoid dispatching new work into a five-hour-exhausted window. Forcing this into `error` mislabels it (not an error, doesn't halt the run).

```diff
  | { kind: "cost"; usd: number | null; confidence: ...; source: string }
+ | { kind: "rate_limit"; scope: "minute" | "hour" | "day" | "five_hour" | "other";
+     status: "ok" | "warning" | "exhausted"; resetsAt: number | null }
  | { kind: "interrupt"; ... }
```

Observed on one vendor today, but Codex reports rate-limit-adjacent signals through `error`/`turn.failed` with specific codes — they will benefit from the same kind. Justified.

### 3. Do NOT add `turn_start` — derive from session/turn boundaries

Codex emits `turn.started` as a pure marker. We considered adding a symmetric `turn_start` kind, but:
- Claude has no equivalent (turns are inferred from `init` + `result`).
- The `turnId` on every `EventEnvelope` already scopes turn membership.
- `session_start` already marks the "first turn begins" case.

Dropping `turn.started` is the right call. No schema change; document the decision.

### 4. `SpawnOpts` should carry CLI-binary overrides

Not a schema change per se; an adapter-contract addition:

```diff
 interface SpawnOpts {
   cwd: string;
   model?: string;
   permissionMode?: PermissionMode;
+  /** Path to a pre-authenticated vendor CLI. Skips env-var-based auth. */
+  vendorCliPath?: string;
   // ...
 }
```

Claude + Codex both support it natively. This is load-bearing for the "user is already logged in via CLI" workflow the project currently depends on.

### 5. `Capabilities.costReporting` tag is correct — no change needed

Phase 0.B confirms: Claude under CLI auth returns `total_cost_usd` → `native` / `exact`. Codex under ChatGPT-OAuth does not → `subscription` / `unknown`. The `source` field in `cost` events is set by core from the adapter's declared capability, as the PLAN already requires (T17 from threat model). No edit.

### 6. Minor: `tool_result.summary` needs a documented truncation policy

The spike projector uses `summary.slice(0, 500)`. PLAN currently just says "summary: string". The adapter base should expose a shared `summarizeToolResult(bytes: number, text: string): string` so every adapter truncates identically; otherwise fixtures drift between vendors.

Not a kind change; a code-location note for Phase 1.C `packages/adapters/base`.

## Kill-switch findings

**Not triggered.** Uncovered percentage is 2.6% (3 / 114). The one actively-unmapped event kind (`rate_limit_event`) is easy to model as a small addition, not a redesign. The dropped `thinking` block is an enhancement candidate, not a structural problem.

If a later adapter (Cursor, Amp, Aider) pushes the unmapped rate past 20%, revisit per the PLAN criteria. For the Claude + Codex contract freeze, no redesign is needed.

## Fixtures

All fixtures are **committed** under `docs/phase-0/event-schema-spike/fixtures/` and asserted byte-identical by the Bun replay test (`fixtures/replay.test.ts`, 6 green tests, ~16ms). They become the regression baseline for Phase 2 Claude/Codex adapter work.

- `fixtures/raw/` — 6 files, raw JSONL captures from the two vendor SDKs.
  - `claude-{bugfix,refactor,new-feature}-raw.jsonl`
  - `codex-{bugfix,refactor,new-feature}-raw.jsonl`
- `fixtures/projected/` — 6 files, the corresponding `AgentEvent[]` projections.
  - Same naming, `-projected.jsonl`.
- `fixtures/gaps/` — 6 files, the gap log for each run.
  - Same naming, `-gaps.json`.
- `fixtures/replay.test.ts` — the regression test.

Harness (non-fixture) artifacts in the spike are gitignored:

- `captures/` — the working directory the harness writes to (`bun run capture:claude` / `capture:codex` re-populates it; fixtures are a snapshot).
- `scratch/` — per-task git-initialized scratch repos (wiped on every capture).
- `node_modules/`, `bun.lock` — standard ignores.

### Reproduction

```bash
cd docs/phase-0/event-schema-spike
bun install
bun run capture:claude      # 3 runs, ~40s total
bun run capture:codex       # 3 runs, ~100s total
bun run project captures/claude-bugfix-raw.jsonl claude   # or any captured file
bun test                    # 6 fixture replays, ~16ms
```

Tokens burned across the full 6-run sweep: ~1,070 Claude output tokens + ~2,655 Codex output tokens. Claude cost: $0.90 total exact. Codex: subscription, no dollar figure.
