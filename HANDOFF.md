# Shamu — Session Handoff

**Last updated:** 2026-04-17 (end of Phase 2, close-out pending commit).

Any fresh session starts here. Load the `shamu-dev` skill (`.claude/skills/shamu-dev/SKILL.md`) to get the full pipeline; this file is the snapshot of *where we are right now*.

## TL;DR

Phase 2 (Claude + Codex adapters, session persistence, cost) is ✅. Phase 3 (Supervisor, worktrees, mailbox) is next. No work in flight. All gates green.

## Read-first order for a fresh session

1. This file.
2. `git log --oneline | head -25` — shape of what's landed.
3. `PLAN.md` §§ "Core architecture", "Phased delivery → Phase 3".
4. Load `shamu-dev` skill for the pipeline mechanics.

## Where we are

| Phase | Scope | Status |
|-------|-------|--------|
| 0 | De-risking spikes | ✅ all 5, writeups in `docs/phase-0/` |
| 1 | Foundations | ✅ all 5 tracks |
| 2 | Claude + Codex adapters | ✅ all 3 tracks (prelude + 2.A/2.B/2.C) |
| 3 | Supervisor, worktrees, mailbox | ⬜ next |
| 4 | Plan → Execute → Review flow | ⬜ |
| 5 | agent-ci gate | ⬜ |
| 6 | Linear integration | ⬜ |
| 7 | Adapter fan-out + web dashboard + egress broker | ⬜ |
| 8 | Autonomous mode + A2A + ops polish | ⬜ |

## Workspace packages (end of Phase 2)

- `@shamu/shared` — events/IDs/Result/logger/credentials/redactor/errors/capabilities
- `@shamu/persistence` — SQLite schema, migrations, HMAC-chained audit, prepared-statement queries (now including `sessions` + `cost` aggregation)
- `@shamu/adapters-base` — contract, subprocess + Node-drain + JSONL, path-scope, shell AST gate, replay, contract suite, T17 cost-stamping helper
- `@shamu/adapter-echo` — in-memory reference adapter (13/13 contract)
- `@shamu/adapter-claude` — production adapter on `@anthropic-ai/claude-agent-sdk@0.2.113`, 13/13 contract, T9 cache-key pinned, in-process MCP
- `@shamu/adapter-codex` — production adapter on `@openai/codex-sdk@0.121.0`, 13/13 contract, snapshot pinned, API-key + ChatGPT-OAuth paths
- `@shamu/cli` — `shamu run` and `shamu resume` wired to real adapters, shared driver with T17 stamping, `run-cost` summary

444 tests pass (3 skipped: 2 platform-specific in shared, 1 Claude live, Codex live as `.test.ts.skip`).

## What's in flight

Nothing. Phase 2 fully committed. Working tree is clean after this close-out commit.

## Phase 3 plan (from PLAN.md)

**Tracks (all three fully parallel — no internal dependencies):**
- **3.A Supervisor** — `packages/core/supervisor`: OTP-shaped `Supervisor`, restart strategies (`one_for_one`, `rest_for_one`), restart-intensity bookkeeping, per-role policy config, `EscalationRaised` domain event with in-memory subscriber (no Linear coupling — that sink lands in Phase 6).
- **3.B Worktrees** — `packages/worktree`: create/destroy `.git/worktrees/shamu-<run-id>`, per-run branch naming, GC policy, lease-aware pre-commit hook installer. **Gotcha:** git 2.50 rejects `-q` on `git revert` and `git worktree prune`; redirect stdout/stderr instead.
- **3.C Mailbox & leases** — `packages/mailbox`: SQLite-backed `mailbox` + `leases` tables with `holder_run_id`/`holder_worktree_path`, `broadcast`/`whisper`/`read`/`mark_read` primitives. **`from_agent` is orchestrator-assigned from authenticated run context (G6) — never accepted from the writer's payload.**

Exit criterion: a two-agent run in separate worktrees can exchange messages; leases prevent races; pre-commit guard works; escalations surface.

## Followups to absorb in Phase 3

Carried forward from Phase 2 (all 2.A/2.B/2.C agent writeups):

1. **Phase0-fixtures regeneration** — standalone half-day track. The capture scripts in `docs/phase-0/event-schema-spike/src/capture-*.ts` predate `@shamu/adapter-{claude,codex}` and emit pre-Phase-1 event shapes via hand-rolled projectors. Regeneration needs: rewriting capture scripts to consume the real adapters, a live Claude+Codex auth/network path, and reshaping `project.ts`. Until done, `packages/adapters/base/test/phase0-fixtures.test.ts` retains its normalization shim.
2. **Live cache-warm assertion landed in live-smoke** — the Phase 2 exit-criterion assertion (`cache_read_input_tokens > 0` on resumed turn) is now codified in `packages/adapters/claude/test/live/live-smoke.test.ts`. It only runs under `SHAMU_CLAUDE_LIVE=1`. Someone should exercise it manually against a real Claude CLI to confirm end-to-end.
3. **Claude adapter factory hooks** — expose `newTurnId` + `newToolCallId` injection (as Codex already does) so the Claude snapshot test can pin those fields instead of masking them.
4. **Resume-through-expired-session E2E coverage** — the CLI handles the case (new session rows get persisted under the resumed runId) but the echo adapter always reuses the supplied session id, so this path is unexercised in default CI. Needs either a test-only adapter that simulates expiry or a live test against a vendor that enforces session expiry.
5. **`shamu cost <run-id>` subcommand** — `emitRunCostSummary` is ready to reuse for ad-hoc queries.
6. **Live subprocess real-spawn coverage** — `packages/adapters/base/src/subprocess.ts` is at ~76% branch coverage in default CI. Claude live-mode tests exercise the Node-drain paths; `SHAMU_CLAUDE_LIVE=1` runs close the gap.

## Open questions for the user

From PLAN.md § "Remaining open questions":

1. **Naming** — keep `shamu` or workshop alternatives?
2. **A2A in v1** — must-ship or defer? (Phase 8 Track 8.B)

Neither blocks Phase 3.

## Already-answered decisions (don't re-litigate)

- MIT license
- macOS + Linux, both first-class
- On-device single-user; no OIDC / no team mode / no multi-tenant
- Never runs inside GitHub Actions — always dev-laptop
- Keychain marked "always allow this app" — documented tradeoff
- Full autonomy is the design goal (not a v2 feature)
- `runId` is orchestrator-owned from Phase 2 onward (`SpawnOpts.runId` required; handle must equal)
- T17 cost-confidence/source stamping lives in the CORE via `stampCostEventFromCapability`, applied by the CLI's event-ingestion loop — never trusted from adapter output

## Micro-decisions that aren't in PLAN.md but matter

- `@shamu/persistence` uses `bun test`, not Vitest. `bun:sqlite` can't load under Vitest's Node workers. Wired through `turbo run test` at the root. Don't port back.
- SQL-concat ban in `packages/persistence` is enforced by a unit test (greps source), not a Biome rule.
- `agent-ci.yml` at repo root is a dogfood marker, not a consumed config — agent-ci auto-discovers `.github/workflows/*.yml`.
- GitNexus hook fires after every commit; `npx gitnexus analyze` runs in the background. Low-friction. Leave it unless it becomes noisy.
- Codex adapter declares `costReporting: "subscription"` (not `"native"` as PLAN originally listed): `@openai/codex-sdk@0.121.0` surfaces only token counts on both auth paths. PLAN.md §7 table reflects this correction.
- Biome's `recommended: true` includes `noNonNullAssertion` as warn — repo standard is zero `!` in both src and tests. Test-site pattern for narrowing: `const ev = xs[0]; if (ev?.kind !== "X") throw ...`.
- CLI spawn path mints `runId` at the orchestrator boundary (`apps/cli/src/commands/run.ts`); asserts `handle.runId === runId` and refuses to continue on mismatch.
- `shamu resume` mints a FRESH `runId` (per G8); the vendor session id from the previous run is the only thing carried forward.

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
