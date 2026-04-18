# Phase 0.A — Bun compatibility

**Question asked:** If we stake the Shamu harness on Bun 1.3.11, what's the size of the footgun?

**Verdict: GO, with two caveats.** Bun is safe to pick as the default runtime for the harness on macOS arm64. No segfaults, no WAL corruption, no event loss in any realistic scenario. The two caveats are (a) Claude Agent SDK ships a 200 MB per-platform native sidecar (`claude` binary) that `bun build --compile` cannot and should not absorb, and (b) Test 5 (live SDK turn) is **BLOCKED ON KEYS** — no `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `CODEX_API_KEY` in the environment.

## Environment
- Host: macOS 26.4 (Darwin 25.4.0) on arm64
- Bun 1.3.11
- Node 25.9.0
- `@anthropic-ai/claude-agent-sdk` **0.2.113**
- `@openai/codex-sdk` **0.121.0**
- `better-sqlite3` **11.10.0** (Node reference)

## Summary

| Area | Verdict | Notes |
| --- | --- | --- |
| Test 1 — `Bun.spawn` + JSONL | GO | Zero loss, sub-ms delivery p99 at 100k events. Bun throughput ~1M events/s vs Node ~390k/s. |
| Test 2 — SQLite WAL concurrency | GO | 1 writer + 10 readers at 100/s and 500/s for 60 s: no errors, no regressions, `PRAGMA integrity_check = ok`. Writer p99 < 1 ms under Bun. |
| Test 3 — `bun build --compile` | GO for CLI/TUI | 58 MB standalone, embeds `bun:sqlite`, spawns subprocesses, cold start ~10 ms in-process. **Does not** ship vendor CLI sidecars (Claude's 200 MB `claude` binary has to stay external). |
| Test 4 — SDK imports (no calls) | GO | Both SDKs import cleanly under Bun and Node. Codex constructs (`Codex` class, `startThread`/`resumeThread`). Claude SDK surface **has changed** — no `ClaudeSDKClient` export exists in 0.2.113; adapter must use `query()` or `unstable_v2_*` session APIs. See contract findings. |
| Test 5 — Live SDK turn | **BLOCKED ON KEYS** | No vendor API key available. Re-run before Phase 2. |
| Bonus — subprocess signal reaping | GO | `proc.kill('SIGINT'/'SIGTERM'/'SIGKILL')` delivers within 1–7 ms to Bun/Node children with custom handlers; exit codes propagate correctly. |

## Test 1 — `Bun.spawn` + JSONL streaming

**Methodology.** A producer script (`src/jsonl-producer.ts`) emits N JSONL events with a high-resolution per-event wall-time stamp (`process.hrtime.bigint()` rebased to `Date.now()` at process start). Two consumers (`src/jsonl-consumer-bun.ts`, `src/jsonl-consumer-node.ts`) spawn the producer as a child, read stdout, line-split, parse, and diff emit-time vs receive-time. Under Bun the consumer uses `Bun.spawn` with `stdout: "pipe"` and a `ReadableStreamDefaultReader`; under Node it uses `child_process.spawn` + `readline.createInterface`. The producer respects `process.stdout.write` backpressure (returns a promise that awaits `drain`).

**Important measurement caveat.** Latencies below ~0.5 ms are noise dominated by cross-process clock skew — the producer and consumer each compute their own `wallOrigin = Date.now()` at startup, and small deltas (~100 μs) between those origins show up as slightly negative per-event latency at the 50th percentile. Treat latency numbers below 1 ms as "sub-millisecond" rather than exact.

**Measurements.**

| Events | Runtime | Wall (ms) | p50 (μs) | p95 (μs) | p99 (μs) | max (μs) | Throughput/s | Max RSS (MB) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 000 | bun | 15.5 | sub-ms | 47 | 61 | 74 | 64 361 | 30.8 |
| 1 000 | node | 78.4 | sub-ms | sub-ms | sub-ms | 188 | 12 760 | 72.8 |
| 10 000 | bun | 24.1 | 497 | 740 | 786 | 827 | 415 600 | 55.8 |
| 10 000 | node | 98.1 | 566 | 628 | 772 | 1 269 | 101 915 | 77.7 |
| 100 000 | bun | 98.2 | 322 | 615 | 792 | 994 | 1 018 776 | 64.6 |
| 100 000 | node | 258.9 | sub-ms | sub-ms | 59 | 2 137 | 386 316 | 97.8 |

No event loss, no ordering gaps, exit code 0 across all runs. Raw results: `bun-compat-spike/results/jsonl-{bun,node}-{count}.json`.

**Slow-consumer backpressure (10 000 events, 5 ms producer jitter, 50 ms consumer stall every 1 000 events):**

| Runtime | Wall (ms) | p50 (μs) | p95 (μs) | p99 (μs) | Throughput/s | Max RSS (MB) | Events lost |
| --- | --- | --- | --- | --- | --- | --- | --- |
| bun | 555 | 122 823 | 249 154 | 259 352 | 18 002 | 40.9 | 0 |
| node | 617 | 50 651 | 104 990 | 114 546 | 16 195 | 76.1 | 0 |

Neither runtime lost events. Bun's apparent p99 is higher because `Bun.spawn`'s `ReadableStream` doesn't surface a `drain` event the Node way, so the producer keeps buffering rather than pausing; the "latency" is therefore queue dwell time, not delivery latency. **No backpressure death or memory runaway in either runtime.** Bun's RSS under backpressure was nearly half of Node's (41 vs 76 MB).

**Footgun surfaced (at `jsonl-producer.ts`, not in Bun itself).** A producer that writes blindly with `process.stdout.write(...)` and does *not* await the Node `drain` event will **appear to hang forever** under a slow Node consumer. Fix is trivial — wrap in a `write` helper that awaits `once('drain')` on `false` — and is already in the spike. Bun handles this transparently. The Shamu subprocess-with-JSONL helper (Phase 1, Track 1.C) must do the Node-style backpressure wait regardless of host runtime, because the child may be Node-based.

**Verdict:** GO. Bun's spawn + stream APIs are faster than Node's and lose no events. Plan for the backpressure helper in the adapter base.

## Test 2 — SQLite WAL concurrency

**Methodology.** `src/sqlite-wal-bun.ts` (and its Node twin) are three-role scripts: orchestrator, writer, reader. The orchestrator spawns 1 writer subprocess + N reader subprocesses (10 by default), each opening the same on-disk SQLite database with `journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=5000`. The writer inserts `(run_id, kind, seq, ts_ns, payload)` at a target rate for a fixed duration. Readers spin on `SELECT COUNT(*)` + `SELECT ... ORDER BY id DESC LIMIT 50`. Each worker reports p50/p95/p99 latency and any errors; the orchestrator verifies final row count, max `seq`, and `PRAGMA integrity_check`.

**Bun under `bun:sqlite`:**

| Target rate | Actual rate | Writer p50 (ms) | Writer p95 (ms) | Writer p99 (ms) | Writer max (ms) | Reader p50 (ms) | Reader p99 (ms) | Reader max (ms) | Errors | Seq regressions | Integrity |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 100/s | 100.0 | 0.43 | 0.67 | 0.89 | 5.63 | 0.20 | 0.74 | 7.13 | 0 | 0 | ok |
| 500/s | 500.0 | 0.35 | 0.56 | 0.89 | 9.65 | 0.41 | 3.96 | 15.86 | 0 | 0 | ok |

**Node under `better-sqlite3`:**

| Target rate | Actual rate | Writer p50 (ms) | Writer p95 (ms) | Writer p99 (ms) | Writer max (ms) | Reader p50 (ms) | Reader p99 (ms) | Reader max (ms) | Errors | Seq regressions | Integrity |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 100/s | 100.0 | 0.18 | 0.28 | 0.39 | 7.78 | 0.16 | 0.71 | 12.62 | 0 | 0 | ok |
| 500/s | 500.0 | 0.12 | 0.22 | 0.32 | 4.24 | 0.37 | 3.43 | 6.18 | 0 | 0 | ok |

**Key findings:**

1. **Zero SQLITE_BUSY, zero retries, zero corruption** across 60-second 10-reader runs at both 100/s and 500/s under both runtimes. `bun:sqlite` in WAL mode is production-viable for the harness volume.
2. Node + `better-sqlite3` is roughly 2–3× faster at write p99 (0.32 vs 0.89 ms at 500/s), almost certainly because the N-API bindings avoid JS↔C marshaling overhead that Bun's FFI still incurs. At Shamu's expected write volume (tens to low hundreds per second across 5–10 agents), this delta is irrelevant — both are within the "imperceptible" band.
3. Reader counts and integrity match perfectly on both runtimes: 6 000 rows at 100/s, 30 000 rows at 500/s, `integrity_check = ok`, no readers ever saw their observed max seq go backwards.
4. `bun:sqlite` behaved identically whether invoked from the main module or from a child `bun` process. Cross-process WAL shared-memory (`-shm`) worked as SQLite intends.

**Verdict:** GO. No kill-switch conditions triggered. If a later benchmark at the 1000/s+ tier shows daylight, we can still wrap `bun:sqlite` behind a `packages/persistence` adapter and drop in `better-sqlite3` on Node without touching callers.

## Test 3 — `bun build --compile`

**Methodology.** `src/standalone.ts` is a 50-line program that (a) imports `bun:sqlite`, (b) opens a fresh WAL database in `tmpdir`, (c) inserts 100 rows via a prepared statement, (d) reads the count back, (e) spawns `/bin/echo hello-from-standalone` via `Bun.spawn` and parses its stdout, (f) prints a single-line JSON summary and exits 0. Built with `bun build --compile --target=bun-darwin-arm64 --outfile=results/standalone src/standalone.ts`.

**Measurements.**

| Item | Value |
| --- | --- |
| Binary size | 58 MB (61 069 216 bytes) |
| File type | `Mach-O 64-bit executable arm64` |
| Cold-start (first run, page cache empty) wall time | 660 ms |
| Warm cold-start (subsequent runs) | ~20 ms wall, ~7-12 ms in-process |
| Peak RSS | ~29 MB |
| Result | `{"ok":true,"pingRowCount":100,"subprocess":"hello-from-standalone","coldStartMs":10}` |

**Verdict:** GO for the CLI/TUI single-binary story described in Phase 8. **But** — Shamu's Claude adapter will invoke the Claude Agent SDK which in turn spawns a per-platform `claude` Mach-O binary (200 MB on darwin-arm64). That binary must be distributed out-of-band (npm install resolves the right `@anthropic-ai/claude-agent-sdk-<platform>` optional dep at runtime) or prefetched by a post-install step. `bun build --compile` cannot usefully bundle a separate 200 MB executable — Phase 8 single-binary release needs to ship Shamu's own binary plus a bootstrapper that `npm install`s vendor SDKs on first run, OR document that vendor CLIs come in via `brew`/`npm`.

## Test 4 — SDK imports (no API calls)

**Methodology.** `src/sdk-imports.ts` dynamically imports both SDKs, reads their module keys, tries constructing the primary handle type, and introspects the prototype chain.

**Results (`results/sdk-imports.json`).**

- **Codex SDK (`@openai/codex-sdk` 0.121.0):** Imports cleanly. Exports two names: `Codex` (class), `Thread` (class). `new Codex()` constructs without a key (constructor doesn't validate upfront). Prototype methods: `startThread`, `resumeThread`. Matches the plan assumption.
- **Claude Agent SDK (`@anthropic-ai/claude-agent-sdk` 0.2.113):** Imports cleanly. Module export surface is **not** what PLAN.md Track 2.A assumes. The package no longer exports a `ClaudeSDKClient` class. Exports present in 0.2.113 include:
  - Primary entry: `query({ prompt, options })` → returns a `Query` (async generator + control methods — `interrupt`, `setModel`, `setPermissionMode`, `rewindFiles`, etc. based on `.d.ts`)
  - Session v2 (unstable): `unstable_v2_createSession`, `unstable_v2_prompt`, `unstable_v2_resumeSession`
  - Session admin: `forkSession`, `deleteSession`, `renameSession`, `listSessions`, `getSessionInfo`, `getSessionMessages`, `importSessionToStore`, `listSubagents`, `getSubagentMessages`, `tagSession`
  - MCP: `createSdkMcpServer`, `tool`
  - Direct connect (browser scenarios): `DirectConnectError`, `DirectConnectTransport`, `parseDirectConnectUrl`
  - Misc: `AbortError`, `InMemorySessionStore`, `HOOK_EVENTS`, `EXIT_REASONS`, `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`, `startup`
  - 27 hook event kinds (enumerated in `HOOK_EVENTS`): `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Notification`, `UserPromptSubmit`, `SessionStart`, `SessionEnd`, `Stop`, `StopFailure`, `SubagentStart`, `SubagentStop`, `PreCompact`, `PostCompact`, `PermissionRequest`, `PermissionDenied`, `Setup`, `TeammateIdle`, `TaskCreated`, `TaskCompleted`, `Elicitation`, `ElicitationResult`, `ConfigChange`, `WorktreeCreate`, `WorktreeRemove`, `InstructionsLoaded`, `CwdChanged`, `FileChanged`.
- **Native sidecar.** The Claude Agent SDK pulls a per-platform `optionalDependencies` entry (e.g. `@anthropic-ai/claude-agent-sdk-darwin-arm64` → `/node_modules/.../claude`, a 200 MB Mach-O binary). The TypeScript SDK is a wrapper that subprocess-spawns this binary and exchanges JSONL. This is exactly the adapter shape PLAN.md already assumes for Shamu — the SDK is doing under the hood what we'll be doing in an adapter.

**TypeScript typecheck.** Ran `tsc --noEmit` on the spike with `strict: true`, `moduleResolution: bundler`, `types: [bun-types, node]`. Passes cleanly against both SDKs.

**Import times (both clean, no native-addon compile step required):**

| SDK | Runtime | Import (ms) |
| --- | --- | --- |
| Claude Agent SDK | Bun | ~26 |
| Claude Agent SDK | Node | ~36 |

**Verdict:** GO for imports. But Phase 2 (Track 2.A) should update the plan to wrap `query()` (and `unstable_v2_*` if warm-resume matters) rather than `ClaudeSDKClient`. The capability surface we'd want — `setModel`, `setPermissionMode`, `interrupt`, `rewindFiles` — still exists, just on the `Query` object returned by `query()` rather than on a long-lived `ClaudeSDKClient`. No Bun-specific issues.

## Test 5 — SDK spawn smoke (live turn)

**BLOCKED ON KEYS.** Environment has no `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `CODEX_API_KEY`. Not attempted.

**What to re-run before Phase 2 kickoff (roughly 5 minutes of work):**

1. Export one of the keys.
2. Under Bun, run: `query({ prompt: "say hello", options: { maxTurns: 1 } })` and iterate the async generator. Record: does it emit an `SDKAssistantMessage` with a non-empty content block? Does the process exit cleanly? Do the event kinds match the `SDKMessage` union in `sdk.d.ts`?
3. Under Bun, run: `const codex = new Codex(); const thread = codex.startThread(); const turn = await thread.runStreamed("say hello");` then iterate. Same questions.
4. Verify the Claude child `claude` binary is the one from `@anthropic-ai/claude-agent-sdk-darwin-arm64/claude` (path should appear in `ps` during the run), and that SIGINT from the parent process interrupts the child cleanly within the ~7 ms signal-delivery envelope measured in the signal bonus test.

If either SDK behaves differently under Bun than under Node on a real turn (it should not — both are subprocess+JSONL under the hood — but this is the whole point of Phase 0), that package declares `engine: node` per the kill-switch and we matrix it in CI.

## Bonus — subprocess signal reaping under `Bun.spawn`

PLAN.md Track 0.A calls out Codex's subprocess-reaping under SIGINT/SIGTERM specifically. Tested with `src/signal-reaping-bun.ts` across three child shapes × three signals (results in `results/signal-reaping-bun.json`):

| Child | Signal | Exit code | Reap (ms) |
| --- | --- | --- | --- |
| `sleep 30` | SIGINT | 130 | 0.29 |
| `sleep 30` | SIGTERM | 143 | 0.24 |
| `sleep 30` | SIGKILL | 137 | 0.24 |
| `node` with SIGINT/SIGTERM handlers | SIGINT | 10 (custom) | 6.36 |
| `node` with SIGINT/SIGTERM handlers | SIGTERM | 11 (custom) | 6.78 |
| `node` with SIGINT/SIGTERM handlers | SIGKILL | 137 | 1.15 |
| `bun` with SIGINT/SIGTERM handlers | SIGINT | 10 (custom) | 3.28 |
| `bun` with SIGINT/SIGTERM handlers | SIGTERM | 11 (custom) | 1.12 |
| `bun` with SIGINT/SIGTERM handlers | SIGKILL | 137 | 0.90 |

Signal delivery is clean; `proc.exited` resolves within 1–7 ms with the correct exit code, and custom handlers get a chance to run. The earlier `sh -c 'trap ... ; sleep 30'` scenario *appeared* to reap only after 30 s — that's POSIX shell-trap semantics (`sh` services traps between foreground commands) and not a Bun problem.

**Verdict:** GO. Bun's `spawn` + `kill` + `exited` triad is a safe basis for Shamu's supervisor.

## Kill-switch findings

1. **GO on Bun as the default runtime.** No test triggered a kill-switch condition.
2. **`bun build --compile` cannot absorb vendor CLIs.** Phase 8 single-binary release plan needs an explicit sidecar story for the Claude Agent SDK's 200 MB platform-specific `claude` binary (and any future equivalents from other vendors). Either (a) the Shamu installer runs `npm install @anthropic-ai/claude-agent-sdk` on first run to pull the matching optional dependency, or (b) Shamu ships one compiled binary + a download manifest + a `shamu doctor` step that fetches and verifies vendor sidecars. Choose before Phase 8.
3. **PLAN.md Track 2.A assumes a `ClaudeSDKClient` class that no longer exists in `@anthropic-ai/claude-agent-sdk` 0.2.113.** The wrapping target is `query(...)`→`Query` (or `unstable_v2_*` if warm-resume becomes a hard requirement). The capabilities the adapter needs (`setModel`, `setPermissionMode`, `interrupt`, hooks, MCP injection) all still exist, just reshaped. This should be updated in Phase 2 planning.
4. **The subprocess-with-JSONL helper (Track 1.C) must handle Node-style `drain` backpressure even when the child is a vendor CLI.** A blind `write` producer hangs a Node-based child under a slow consumer; the Shamu adapter framework cannot assume the child respects backpressure on its own.
5. **Bun's `Bun.spawn` stream does not surface a `drain` event on the parent side.** That's fine for the consumer (we just pull from the `ReadableStream` at our own pace), but worth knowing when comparing to Node semantics in documentation.
6. **`bun:sqlite` write latency is ~2-3× higher than `better-sqlite3`.** At Shamu's volumes this is a rounding error. If a later phase runs into 1000+/s writes (unlikely for a single-box 10-agent harness), `packages/persistence` is the chokepoint where a `better-sqlite3` fallback would plug in behind a flag.

## What's deferred

- **Test 5 (live turn through Claude and Codex SDKs)** is BLOCKED ON KEYS. Re-run before Phase 2 starts.
- **Linux x86_64 compile smoke.** PLAN.md Track 0.A asks for it; the spike ran on darwin-arm64 only (host limitation). Re-run `bun build --compile --target=bun-linux-x64` in CI once the workspace exists.
- **Bun-vs-Node on the same vendor CLI.** The Claude Agent SDK spawns its own `claude` binary from either runtime; they should look identical end-to-end, but we should confirm after Test 5 is unblocked.

## Spike artifacts

All scripts and raw results are under `docs/phase-0/bun-compat-spike/`:

- `package.json` / `tsconfig.json` — spike project
- `src/jsonl-producer.ts` — backpressure-aware JSONL producer (shared by Bun and Node consumers)
- `src/jsonl-consumer-bun.ts` / `src/jsonl-consumer-node.ts` — Test 1 consumers
- `src/sqlite-wal-bun.ts` / `src/sqlite-wal-node.ts` — Test 2 orchestrator + writer + reader roles
- `src/standalone.ts` — Test 3 target for `bun build --compile`
- `src/sdk-imports.ts` — Test 4 construct-only smoke
- `src/signal-reaping-bun.ts` — bonus signal-reaping test
- `results/*.json` — raw per-test outputs

Run any test with `bun` / `node --experimental-strip-types` directly; see `package.json` scripts for canonical invocations. Generated `results/*.db*` and `results/standalone` are gitignored.
