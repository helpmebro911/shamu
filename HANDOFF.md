# Shamu — Session Handoff

**Last updated:** 2026-04-18 (end of Phase 3).

Any fresh session starts here. Load the `shamu-dev` skill (`.claude/skills/shamu-dev/SKILL.md`) to get the full pipeline; this file is the snapshot of *where we are right now*.

## TL;DR

Phase 3 (Supervisor, Worktrees, Mailbox, Watchdog) is ✅ at the primitive layer. Phase 4 (Plan → Execute → Review flow) is next, and also absorbs the cross-primitive composition exits that PLAN originally listed under Phase 3 but genuinely needed the flow engine. No work in flight. All gates green. Naming confirmed: `shamu`.

## Read-first order for a fresh session

1. This file.
2. `git log --oneline | head -25` — shape of what's landed.
3. `PLAN.md` §§ "Core architecture", "Phased delivery → Phase 4".
4. Load `shamu-dev` skill for the pipeline mechanics.

## Where we are

| Phase | Scope | Status |
|-------|-------|--------|
| 0 | De-risking spikes | ✅ all 5, writeups in `docs/phase-0/` |
| 1 | Foundations | ✅ all 5 tracks |
| 2 | Claude + Codex adapters | ✅ all 3 tracks (prelude + 2.A/2.B/2.C) |
| 3 | Supervisor, worktrees, mailbox, watchdog | ✅ 4/4 tracks (3.A/3.B/3.C/3.D); composition-level exits deferred to Phase 4 |
| 4 | Plan → Execute → Review flow | ⬜ next (inherits Phase 3 composition exits) |
| 5 | agent-ci gate | ⬜ |
| 6 | Linear integration | ⬜ |
| 7 | Adapter fan-out + web dashboard + egress broker | ⬜ |
| 8 | Autonomous mode + A2A + ops polish | ⬜ |

## Workspace packages (end of Phase 3)

- `@shamu/shared` — events/IDs/Result/logger/credentials/redactor/errors/capabilities
- `@shamu/persistence` — SQLite schema, migrations, HMAC-chained audit, prepared-statement queries (runs/sessions/events/audit/cost/mailbox/leases)
- `@shamu/adapters-base` — contract, subprocess + Node-drain + JSONL, path-scope, shell AST gate, replay, contract suite, T17 cost-stamping helper
- `@shamu/adapter-echo` — in-memory reference adapter (13/13 contract)
- `@shamu/adapter-claude` — production adapter on `@anthropic-ai/claude-agent-sdk@0.2.113`, 13/13 contract, T9 cache-key pinned, in-process MCP
- `@shamu/adapter-codex` — production adapter on `@openai/codex-sdk@0.121.0`, 13/13 contract, snapshot pinned, API-key + ChatGPT-OAuth paths
- `@shamu/cli` — `shamu run` / `shamu resume` wired to real adapters, shared driver with T17 stamping, `run-cost` summary
- `@shamu/core-supervisor` — OTP-shaped Supervisor/Swarm/EventBus + intensity tracker + `EscalationRaised` bus (Phase 3.A)
- `@shamu/worktree` — per-run git worktree lifecycle + GC + per-worktree `pre-commit` hook via `core.hooksPath` (Phase 3.B)
- `@shamu/mailbox` — trusted mailbox + lease primitives (G6 `from_agent` auth, stale-lease reclaim, materialized JSONL export) (Phase 3.C)
- `@shamu/watchdog` — out-of-process Bun subprocess reading SQLite read-only, four confidence-labeled signals, two-observation agreement rule (Phase 3.D)

646 tests pass across 11 packages (+202 over end-of-Phase-2): core-supervisor 48, worktree 38, mailbox 52, watchdog 64. Same platform skips as Phase 2 (4 skipped: 2 platform-specific in shared, 1 Claude unit-skip, 1 Claude live; Codex live as `.test.ts.skip`).

## What's in flight

Nothing. Phase 3 fully committed.

## Phase 4 plan (from PLAN.md)

**Tracks:**
- **4.A Flow engine (Serial)** — `packages/core/flow`: typed DAG nodes (`AgentStep`, `Conditional`, `Loop`, `HumanGate`), serializable/resumable state, per-node progress + cost roll-up events. Lifts content-hashed node-output dedupe per PLAN § 8.
- **4.B Canonical flow (Serial after 4.A)** — `flows/plan-execute-review.ts`: GPT-5.4 planner → Opus 4.7 executor → GPT-5.4 reviewer → loop until approve / max-iterations; approve/revise verdict schema.
- **4.C CLI + telemetry (Parallel with 4.B)** — `shamu flow run <name> --task "..."`, `shamu flow status <flow-run>`, structured JSON flow-run logs.

**Composition exits carried over from Phase 3 (now part of Phase 4's exit):**
- Two real workers in parallel worktrees coordinate via the mailbox end-to-end.
- Remaining Phase 0.C manufactured scenarios reproduced as contract tests against the live flow (clean concurrent, overlapping lines, non-overlapping same-file, cross-file semantic, 10-worktree cleanup cost).
- Diff-overlap check wired into the integrate step of the patch lifecycle.
- `EscalationEmitter` shim wiring `@shamu/mailbox` + `@shamu/watchdog` alerts into the `@shamu/core-supervisor` bus.
- `persistenceReadRun` driver wiring `@shamu/worktree` GC to real run rows.

## Followups to absorb in Phase 4 (or later)

Carried forward from Phase 3:

1. **Role backfill on `events` rows.** `@shamu/watchdog` buckets signals by `(runs.role || vendor)` today. Once the flow engine assigns a role to each event, swap in the authoritative field and update `observation.detail.roleKey`.
2. **TTL-refresh API on leases.** `@shamu/mailbox` has `acquireLease` / `releaseLease` / `reclaimIfStale` but no `renewLease(ctx, id, ttlMs)`. Long-running executors need it.
3. **Recipient-list expansion.** `mailbox.broadcast` requires explicit `toAgents`. Orchestrator needs a "who's in this swarm right now?" helper before this can be a one-arg call.
4. **`@shamu/shared/logger` wiring inside `core-supervisor`.** The supervisor swallows `stop()` rejections and uses `console.error` for bus listener errors — replace with the structured logger once the flow layer's logging sink exists.
5. **`one_for_all` restart strategy.** Not implemented in `core-supervisor`; add only if a role needs it.
6. **Non-`main` base branch discovery.** `worktree.createWorktree` trusts the caller's `baseBranch`. A helper for `origin/HEAD` removes the hardcoding.
7. **Signing-hook coexistence (Phase 5).** Pre-commit slot is singular. Either chain multiple checks or split into `pre-commit` + `commit-msg` before the agent-ci gate lands.
8. **Subprocess auto-restart for the watchdog.** `spawnWatchdogSubprocess` returns `exited` but has no liveness poll — wrap under the supervisor policy once the orchestrator composes them.
9. **Promote `ReadOnlyWatchdogDatabase` to `@shamu/persistence`** if any second out-of-process consumer needs SELECT-only access.
10. **bun:sqlite null-vs-undefined quirk.** Mailbox tests use `== null` instead of `toBeUndefined()`; consider normalizing in persistence `mapRow` helpers.
11. **Batch materialization for `.shamu/mailbox/*.jsonl`.** Per-row open+fsync+rename is fine at human volume; replace with an `O_APPEND|O_SYNC`-backed WAL if volume grows.
12. **Additive supervisor lifecycle events.** `ChildStarted | ChildStopped | ChildRestarted` are published alongside `EscalationRaised`; CLI/TUI supervisor-tree view can consume them without another revision.

Carried from Phase 2 (not yet done; still non-blocking):

13. **Phase0-fixtures regeneration** — capture scripts predate `@shamu/adapter-{claude,codex}`; rewrite once a live auth path is available.
14. **Live cache-warm assertion** — `packages/adapters/claude/test/live/live-smoke.test.ts` under `SHAMU_CLAUDE_LIVE=1` awaits a manual run against a real Claude CLI.
15. **Claude adapter factory hooks** — expose `newTurnId` + `newToolCallId` injection (parity with Codex) so the Claude snapshot test can pin those fields.
16. **Resume-through-expired-session E2E coverage.**
17. **`shamu cost <run-id>` subcommand** — `emitRunCostSummary` is ready to reuse.
18. **Live subprocess real-spawn coverage in `adapters-base`** — ~76% branch coverage in default CI; `SHAMU_CLAUDE_LIVE=1` closes the gap.

## Open questions for the user

From PLAN.md § "Remaining open questions":

1. **A2A in v1** — must-ship or defer? (Phase 8 Track 8.B)

Does not block Phase 4.

## Already-answered decisions (don't re-litigate)

- MIT license
- **Naming: `shamu` (confirmed 2026-04-17)**
- macOS + Linux, both first-class
- On-device single-user; no OIDC / no team mode / no multi-tenant
- Never runs inside GitHub Actions — always dev-laptop
- Keychain marked "always allow this app" — documented tradeoff
- Full autonomy is the design goal (not a v2 feature)
- `runId` is orchestrator-owned from Phase 2 onward (`SpawnOpts.runId` required; handle must equal)
- T17 cost-confidence/source stamping lives in the CORE via `stampCostEventFromCapability`, applied by the CLI's event-ingestion loop — never trusted from adapter output
- **`from_agent` (G6) is a code-level invariant in `@shamu/mailbox`** — no public API accepts a `from` parameter; the only path into `from_agent` is `AuthContext.agent`
- **Watchdog runs out-of-process, SQLite read-only** — a stalled main process cannot silence it
- **`.shamu/worktrees/<run-id>` + `shamu/<run-id>` branch** — locked in (PLAN originally listed both path forms; chose the project-managed-namespace one per Security § Filesystem)
- **Per-worktree `pre-commit` hook installs to `GIT_DIR/shamu-hooks/pre-commit` via `core.hooksPath`** — git 2.50 silently ignores per-worktree admin-dir hooks; `core.hooksPath` is the only per-worktree mechanism git honors

## Micro-decisions that aren't in PLAN.md but matter

- `@shamu/persistence` and `@shamu/mailbox` and `@shamu/watchdog` use `bun test`, not Vitest. `bun:sqlite` can't load under Vitest's Node workers. Wired through `turbo run test` at the root. Don't port back.
- SQL-concat ban in `packages/persistence` is enforced by a unit test (greps source), not a Biome rule.
- `agent-ci.yml` at repo root is a dogfood marker, not a consumed config — agent-ci auto-discovers `.github/workflows/*.yml`.
- GitNexus hook fires after every commit; `npx gitnexus analyze` runs in the background. Low-friction. Leave it unless it becomes noisy.
- Codex adapter declares `costReporting: "subscription"` (not `"native"`): `@openai/codex-sdk@0.121.0` surfaces only token counts on both auth paths.
- Biome's `recommended: true` includes `noNonNullAssertion` as warn — repo standard is zero `!` in both src and tests. Test-site pattern: `const ev = xs[0]; if (!ev) throw new Error("...");`.
- CLI spawn path mints `runId` at the orchestrator boundary (`apps/cli/src/commands/run.ts`); asserts `handle.runId === runId` and refuses to continue on mismatch.
- `shamu resume` mints a FRESH `runId` (per G8); the vendor session id from the previous run is the only thing carried forward.
- **Root `package.json` `workspaces` glob includes `packages/core/*`** (added with 3.A for `@shamu/core-supervisor`). Phase 4's `@shamu/core-flow` will sit alongside it at `packages/core/flow/`.
- **`WatchdogAlert` and `MailboxEscalationRaised` are structurally compatible with `core-supervisor`'s `EscalationRaised`** but neither `@shamu/watchdog` nor `@shamu/mailbox` imports `core-supervisor`. Composition-layer shims wire the buses in Phase 4.
- **`@shamu/watchdog.runWatchdog` is pure.** `now`, `emit`, and `state` are injected. No timers/intervals inside the core — those live only in `subprocess.ts` and `entry.ts`.

## Pointers

- `PLAN.md` — architecture + phased delivery + decisions + open questions
- `PLAN_REVIEW.md` — adversarial review (historical; shows why choices stand)
- `docs/phase-0/*.md` — spike writeups, go/no-go findings, evidence
- `docs/phase-0/event-schema-spike/fixtures/` — 0.B event captures, baseline regression data (shim still active pending regen)
- `.claude/skills/shamu-dev/SKILL.md` — the pipeline (load at session start)
- `AGENTS.md` / `CLAUDE.md` — GitNexus-generated code context
- `git log` — every phase has a detailed body explaining what landed

## HANDOFF maintenance

- Update at every phase boundary (end of Phase N → flip status, refresh "next" section, rotate followups).
- Update at any session end where work is mid-flight (note what agents are running, what files are half-done).
- Keep it short. If it grows past ~150 lines, something that should be in PLAN.md is leaking in.
