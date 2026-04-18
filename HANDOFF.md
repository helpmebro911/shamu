# Shamu — Session Handoff

**Last updated:** 2026-04-18 (end of Phase 4).

Any fresh session starts here. Load the `shamu-dev` skill (`.claude/skills/shamu-dev/SKILL.md`) to get the full pipeline; this file is the snapshot of *where we are right now*.

## TL;DR

Phase 4 (Plan → Execute → Review flow + composition exits) is ✅ at the unit+integration layer. The ONE owed manual step is the `SHAMU_FLOW_LIVE=1` smoke against real Claude + Codex CLIs — everything else is gate-green. Phase 5 (agent-ci gate) is next. No work in flight. 14 workspace packages, 778 tests (+132 since end of Phase 3).

## Read-first order for a fresh session

1. This file.
2. `git log --oneline | head -25` — shape of what's landed.
3. `PLAN.md` §§ "Core architecture", "Phased delivery → Phase 5".
4. Load `shamu-dev` skill for the pipeline mechanics.

## Where we are

| Phase | Scope | Status |
|-------|-------|--------|
| 0 | De-risking spikes | ✅ all 5, writeups in `docs/phase-0/` |
| 1 | Foundations | ✅ all 5 tracks |
| 2 | Claude + Codex adapters | ✅ all 3 tracks |
| 3 | Supervisor, worktrees, mailbox, watchdog | ✅ 4/4 tracks; composition exits carried into Phase 4 |
| 4 | Plan → Execute → Review flow + composition | ✅ 4/4 tracks (4.A/4.B/4.C/4.D); one manual `SHAMU_FLOW_LIVE=1` smoke still owed |
| 5 | agent-ci gate | ⬜ next |
| 6 | Linear integration | ⬜ |
| 7 | Adapter fan-out + web dashboard + egress broker | ⬜ |
| 8 | Autonomous mode + A2A + ops polish | ⬜ |

## Workspace packages (end of Phase 4)

- `@shamu/shared` — events/IDs/Result/logger/credentials/redactor/errors/capabilities
- `@shamu/persistence` — SQLite schema, migrations (v1 + v2 `flow_runs`), HMAC-chained audit, prepared-statement queries (runs/sessions/events/audit/cost/mailbox/leases/flow-runs)
- `@shamu/adapters-base` — contract, subprocess + Node-drain + JSONL, path-scope, shell AST gate, replay, contract suite, T17 cost-stamping helper
- `@shamu/adapter-echo` — in-memory reference adapter (13/13 contract)
- `@shamu/adapter-claude` — production adapter on `@anthropic-ai/claude-agent-sdk@0.2.113` (13/13 contract, T9 cache-key pinned, in-process MCP)
- `@shamu/adapter-codex` — production adapter on `@openai/codex-sdk@0.121.0` (13/13 contract, snapshot pinned, API-key + ChatGPT-OAuth paths)
- `@shamu/cli` — `shamu run` / `shamu resume` / `shamu flow run` / `shamu flow status`, NDJSON telemetry, flow-module loader (Phase 4.C)
- `@shamu/core-supervisor` — OTP-shaped Supervisor/Swarm/EventBus + intensity tracker + `EscalationRaised` bus (Phase 3.A)
- `@shamu/worktree` — per-run git worktree lifecycle + GC (via `persistenceReadRun` injectable) + per-worktree `pre-commit` hook via `core.hooksPath` (Phase 3.B + 4.D test)
- `@shamu/mailbox` — trusted mailbox + lease primitives (G6 `from_agent` auth, stale-lease reclaim, materialized JSONL export) (Phase 3.C)
- `@shamu/watchdog` — out-of-process Bun subprocess reading SQLite read-only, four confidence-labeled signals, two-observation agreement rule (Phase 3.D)
- `@shamu/core-flow` — typed, serializable, resumable DAG workflow engine with content-hash dedupe and cost roll-up (Phase 4.A)
- `@shamu/flows-plan-execute-review` — canonical plan→execute→review flow: GPT-5.4 planner → Opus 4.7 executor → GPT-5.4 reviewer → loop (Phase 4.B)
- `@shamu/core-composition` — cross-primitive glue: EscalationEmitter shim + persistenceReadRun driver + diffOverlapCheck helper + Phase 0.C contract tests + two-workers-via-mailbox E2E (Phase 4.D)

778 tests pass across 14 packages (+132 over end-of-Phase-3): core-flow 57, flows-plan-execute-review 35 (+1 skipped live), CLI +13 (now 46), core-composition 28, worktree +1 (now 39).

## What's in flight

Nothing. Phase 4 fully committed (commits `0f3ba34`, `df9e019`, `a7008c5`, `3b862d6`).

## The one owed manual step

`packages/flows/plan-execute-review/test/live/smoke.live.test.ts` is `describe.skipIf(!SHAMU_FLOW_LIVE)`. Running it requires authenticated Claude + Codex CLIs on the local laptop. It proves:
- Planner → Executor → Reviewer round-trips against the real vendors.
- Reviewer `revise` verdict triggers a fresh executor run (reviewer-internal loop).

Recommended when: the user has a free 10-15 min block and both CLIs logged in. No blocker on Phase 5.

## Phase 5 plan (from PLAN.md)

**Tracks:**
- **5.A CI wrapper (Parallel)** — `packages/ci/gate`: spawn `@redwoodjs/agent-ci`; run-dir discovery via pre/post diff; parse `run-state.json` + per-step logs; derive status from workflow + job statuses; TAP-13 + ESLint-stylish + tail-fallback extractors; ANSI SGR strip; `toDomainEvent` → `CIRed` / `PatchReady`; interrupt path (agent-ci abort → Docker reap); replay over Phase 0.D fixtures; artifact capture. Lifts Phase 0.D parser from `docs/phase-0/agent-ci-spike/parser/`.
- **5.B Reviewer integration (Parallel with 5.A)** — Reviewer excerpt as a committed contract; reviewer input schema includes CI summary + excerpt; reviewer can require "re-run CI after changes"; flow engine blocks approval on red CI; RFC for `--report=json` (non-blocking).
- **5.C Quality bars (Serial after 5.A + 5.B)** — Per-role CI-failure counter (watchdog tripwire on 3 reds); `agent-ci.yml` required on all shamu PRs; GitHub branch protection (signed commits + linear history + required status check).

**Exit:** swarm run cannot mark a patch "approved" without green `agent-ci`; shamu's own repo enforces the gate on itself.

Natural hook points Phase 4 leaves ready for Phase 5:
- `@shamu/core-composition/diff-overlap` is done; integrate-step wiring is 5.A's to call.
- `@shamu/flows-plan-execute-review`'s reviewer runner already exposes a verdict schema (`approve | revise`) that 5.B extends with a `requires_ci_rerun` variant.
- `@shamu/core-flow` engine's `AgentStep` + runner registry is vendor-opaque; 5.A wires a `ci` runner that spawns agent-ci as a node.

## Followups to absorb in Phase 5 (or later)

### From Phase 4.A

1. **ParallelFanOut + Join node kinds** — PLAN § 8 lists them; 4.A is sequential-only. Add when the flow engine needs true parallel branch execution.
2. **Per-iteration Loop body execution** — 4.A's Loop only re-evaluates the `until` predicate; 4.B's reviewer works around this by driving executor re-runs internally. Upgrade the engine so the Loop re-invokes body nodes; then collapse the reviewer-internal loop.
3. **Skipped-branch status propagation** — conditional-skipped nodes stay `pending` in `state.nodeStatus`. A post-walk pass to mark them `skipped` would make dashboards clearer.
4. **CLI/driver wiring engine ↔ `queries/flow-runs`** — 4.C wires `shamu flow run` to persist; any future driver (daemon, web dashboard) follows the same pattern.

### From Phase 4.B

5. **Live smoke enablement** — the `SHAMU_FLOW_LIVE=1` test under `packages/flows/plan-execute-review/test/live/` awaits a manual run.
6. **Prompt shrink-to-schema** — if models emit trailing commentary after the fenced json block, `parseLastJsonBlock` may need a shrink pass.
7. **`__adapterOverride` as a semi-public seam** — underscore-prefixed today; if workspace-level integration tests need scripted adapters, they import from the `/runners` subpath.
8. **Iteration-counter Map eviction** — keyed on `flowRunId`, never evicted. Fine for process-scoped CLI; a long-lived daemon needs eviction.

### From Phase 4.C

9. **Richer `flow status` output** — per-node cost breakdown + event replay.
10. **Flow discovery** — `shamu flow run <name>` without explicit module-spec (registry config / `shamu.config.ts`).
11. **Progress streaming** — when runners emit intra-node progress, surface via the NDJSON sink.
12. **Correlation between `flow_runs` and `runs`** — AgentStep runners spawn adapter subprocesses that write `runs` rows; link them via a `flow_run_id` column on `runs` (additive migration) or a join table.
13. **Paused exit code** — `shamu flow run` uses USAGE(2) for paused because the taxonomy lacks a `NEEDS_HUMAN` code; add one when human-gate UX surfaces it.

### From Phase 4.D

14. **Extend `EscalationCause`** in `@shamu/core-supervisor` with `"watchdog_agreement"` + `"lease_reclaim_refused"` variants so sinks can switch on shape rather than parse `reason`. Today's catch-all `"policy_violation"` is lossy.
15. **`@shamu/worktree/src/gc.ts` docstring** still says "trusts caller's baseBranch"; GC actually consults run status + `updatedAt` via `persistenceReadRun`. Minor doc cleanup.
16. **`gitDiffNames` defensive TypeErrors** in `diff-overlap.ts` — 3 unreachable lines kept for internal-misuse safety. Delete if strict-coverage is wanted.

### Carried from Phase 2 (still non-blocking)

17. **Phase0-fixtures regeneration** — capture scripts predate `@shamu/adapter-{claude,codex}`; rewrite once a live auth path is available.
18. **Claude adapter factory hooks** — expose `newTurnId` + `newToolCallId` injection (parity with Codex) so the snapshot test can pin those fields.
19. **Resume-through-expired-session E2E coverage.**
20. **`shamu cost <run-id>` subcommand** — `emitRunCostSummary` ready to reuse.
21. **Live subprocess real-spawn coverage in `adapters-base`** — ~76% branch coverage in default CI; `SHAMU_CLAUDE_LIVE=1` closes the gap.

### Carried from Phase 3 (still non-blocking)

22. **Role backfill on `events` rows** — watchdog buckets by `(runs.role || vendor)` today; swap to authoritative role once the flow engine assigns one per event. (Partially resolved by 4.C wiring `flow_run_id` into contexts; full backfill is a migration job.)
23. **TTL-refresh API on leases** — `@shamu/mailbox` has `acquireLease` / `releaseLease` / `reclaimIfStale` but no `renewLease`. Long-running executors need it.
24. **Recipient-list expansion in `mailbox.broadcast`** — requires a "who's in this swarm right now?" helper.
25. **`@shamu/shared/logger` wiring inside `core-supervisor`** — swallowed `stop()` rejections use `console.error`; replace with the structured logger.
26. **`one_for_all` restart strategy** — not implemented; add only if a role needs it.
27. **Non-`main` base-branch discovery** — `worktree.createWorktree` trusts the caller's `baseBranch`; a helper for `origin/HEAD` removes the hardcoding.
28. **Signing-hook coexistence (Phase 5)** — pre-commit slot is singular; chain multiple checks or split into `pre-commit` + `commit-msg` before the agent-ci gate lands.
29. **Subprocess auto-restart for the watchdog** — `spawnWatchdogSubprocess` has no liveness poll; wrap under supervisor policy.
30. **Promote `ReadOnlyWatchdogDatabase` to `@shamu/persistence`** if any second out-of-process consumer needs SELECT-only access.
31. **bun:sqlite null-vs-undefined quirk** — mailbox tests use `== null` instead of `toBeUndefined()`; consider normalizing in persistence `mapRow` helpers.
32. **Batch materialization for `.shamu/mailbox/*.jsonl`** — per-row open+fsync+rename fine at human volume; replace with `O_APPEND|O_SYNC` WAL if volume grows.
33. **Additive supervisor lifecycle events** — `ChildStarted | ChildStopped | ChildRestarted` already published; CLI/TUI tree view can consume.

## Open questions for the user

None blocking. (PLAN's "Remaining open questions" is now empty; A2A-in-v1 answered 2026-04-18 — must-ship, Phase 8 Track 8.B is v1 scope.)

## Already-answered decisions (don't re-litigate)

- MIT license
- Naming: `shamu` (confirmed 2026-04-17)
- macOS + Linux, both first-class
- On-device single-user; no OIDC / team mode / multi-tenant
- Never runs inside GitHub Actions — always dev-laptop
- Keychain marked "always allow this app" — documented tradeoff
- Full autonomy is the design goal (not a v2 feature)
- `runId` is orchestrator-owned from Phase 2 onward (`SpawnOpts.runId` required; handle must equal)
- T17 cost-confidence/source stamping lives in the CORE via `stampCostEventFromCapability`, applied by the CLI's event-ingestion loop — never trusted from adapter output
- `from_agent` (G6) is a code-level invariant in `@shamu/mailbox` — no public API accepts a `from` parameter
- Watchdog runs out-of-process, SQLite read-only — a stalled main process cannot silence it
- `.shamu/worktrees/<run-id>` + `shamu/<run-id>` branch — locked in
- Per-worktree `pre-commit` hook installs to `GIT_DIR/shamu-hooks/pre-commit` via `core.hooksPath` — git 2.50 silently ignores per-worktree admin-dir hooks
- **`diffOverlapCheck` diffs `<mergeBase>..<runBranch>`** to isolate each run's own contribution (not `integrationBranch`, which would conflate later runs into earlier ones' path sets). `RunMergeRecord` carries `branch` so the caller supplies the ref. PLAN § Patch lifecycle updated in phase-4 close-out.
- **Canonical flow module contract** is `{ flowDefinition, registerRunners, name?, parseOptions? }` — `@shamu/flows-plan-execute-review` is the reference implementation; `shamu flow run --flow <module-spec>` is the consumer.
- **Composition layer lives in `@shamu/core-composition`** — not inside `@shamu/core-supervisor` / `@shamu/mailbox` / `@shamu/watchdog`, so none of those primitives drag in each other's event taxonomies.
- **A2A is v1 scope (confirmed 2026-04-18).** Phase 8 Track 8.B is no longer optional. G11 (Signed Agent Cards + bearer-token binding + JSON-RPC + SSE transport hardening) joins G2/G3/G4/G6/G7 as an autonomous-daemon go-live blocker.

## Micro-decisions that aren't in PLAN.md but matter

- `@shamu/persistence`, `@shamu/mailbox`, `@shamu/watchdog`, `@shamu/core-composition` use `bun test`, not Vitest. `bun:sqlite` can't load under Vitest's Node workers. Wired through `turbo run test` at the root. Don't port back.
- SQL-concat ban in `packages/persistence` is enforced by a unit test (greps source), not a Biome rule.
- `agent-ci.yml` at repo root is a dogfood marker, not a consumed config — agent-ci auto-discovers `.github/workflows/*.yml`.
- GitNexus hook fires after every commit; `npx gitnexus analyze` runs in the background. Low-friction.
- Codex adapter declares `costReporting: "subscription"` (not `"native"`): `@openai/codex-sdk@0.121.0` surfaces only token counts.
- Biome's `recommended: true` includes `noNonNullAssertion` as warn — repo standard is zero `!` in both src and tests.
- CLI spawn path mints `runId` at the orchestrator boundary; asserts `handle.runId === runId` and refuses on mismatch.
- `shamu resume` mints a FRESH `runId` (per G8); the vendor session id is the only thing carried forward.
- Root `package.json` `workspaces` glob includes `packages/core/*`, `packages/adapters/*`, and `packages/flows/*` (added with 4.B).
- `@shamu/core-flow` `Loop` node re-evaluates its `until` predicate but does NOT re-invoke body nodes per iteration. 4.B's reviewer runner drives revise→retry internally as a workaround; followup #2 above unwinds this once the engine upgrades.
- `@shamu/flows-plan-execute-review.__adapterOverride` is an underscore-prefixed testing seam accessible via the `/runners` subpath — not exposed from `src/index.ts`.
- `shamu flow run` exit codes: succeeded → 0, paused → 2 (USAGE, provisionally), failed → 10 (RUN_FAILED). Tests in `apps/cli/test/exit-codes.test.ts`.
- `shamu flow run --flow-opt key=value` is repeatable but citty collapses repeats; harvested from `rawArgs` via `collectFlowOpts`.
- Persistence cadence for flow runs: insert on `flow_started`, update on terminal `flow_completed` / `human_gate_reached`; intermediate node events do NOT flush state (engine-returned `finalState` is authoritative).
- `@shamu/core-composition/escalation-emitter` collapses all non-supervisor causes onto `"policy_violation"` today; followup #14 above extends the enum.

## Pointers

- `PLAN.md` — architecture + phased delivery + decisions + open questions
- `PLAN_REVIEW.md` — adversarial review (historical; shows why choices stand)
- `docs/phase-0/*.md` — spike writeups, go/no-go findings, evidence
- `docs/phase-0/worktree-merge-spike/scripts/` — scenario 1-6 ground truth for Phase 0.C ports in `@shamu/core-composition`
- `.claude/skills/shamu-dev/SKILL.md` — the pipeline (load at session start)
- `AGENTS.md` / `CLAUDE.md` — GitNexus-generated code context
- `git log` — every phase has a detailed body explaining what landed

## HANDOFF maintenance

- Update at every phase boundary (end of Phase N → flip status, refresh "next" section, rotate followups).
- Update at any session end where work is mid-flight (note what agents are running, what files are half-done).
- Keep it short. If it grows past ~200 lines, something that should be in PLAN.md is leaking in.
