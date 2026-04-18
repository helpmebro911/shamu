# Shamu — Session Handoff

**Last updated:** 2026-04-17 (end of Phase 1, commit `586e162`).

Any fresh session starts here. Load the `shamu-dev` skill (`.claude/skills/shamu-dev/SKILL.md`) to get the full pipeline; this file is the snapshot of *where we are right now*.

## TL;DR

Phase 1 (foundations) is ✅. Phase 2 (Claude + Codex adapters) is next. No work in flight. All gates green.

## Read-first order for a fresh session

1. This file.
2. `git log --oneline | head -25` — shape of what's landed.
3. `PLAN.md` §§ "Core architecture", "Phased delivery → Phase 2".
4. Load `shamu-dev` skill for the pipeline mechanics.

## Where we are

| Phase | Scope | Status |
|-------|-------|--------|
| 0 | De-risking spikes | ✅ all 5, writeups in `docs/phase-0/` |
| 1 | Foundations | ✅ all 5 tracks |
| 2 | Claude + Codex adapters | ⬜ next |
| 3 | Supervisor, worktrees, mailbox | ⬜ |
| 4 | Plan → Execute → Review flow | ⬜ |
| 5 | agent-ci gate | ⬜ |
| 6 | Linear integration | ⬜ |
| 7 | Adapter fan-out + web dashboard + egress broker | ⬜ |
| 8 | Autonomous mode + A2A + ops polish | ⬜ |

PLAN.md has the checkboxes (`grep -cE "^- \[x\]" PLAN.md` → 51, `^- \[ \]` → 123 as of this commit).

## Workspace packages (end of Phase 1)

- `@shamu/shared` — events/IDs/Result/logger/credentials/redactor/errors/capabilities
- `@shamu/persistence` — SQLite schema, migrations, HMAC-chained audit, prepared-statement queries
- `@shamu/adapters-base` — contract, subprocess + Node-drain + JSONL, path-scope, shell AST gate, replay, contract suite
- `@shamu/adapter-echo` — in-memory reference adapter (13/13 contract scenarios pass)
- `@shamu/cli` — 11 command scaffolds; `run`/`status`/`logs` wired to real SQLite

## What's in flight

Nothing. All agents completed. Working tree is clean. Last commit `586e162`.

## Phase 2 plan (from PLAN.md)

**Tracks:**
- **2.A Claude adapter** (parallel) — `packages/adapters/claude` wrapping `query()` + `unstable_v2_createSession`; hook bridge; in-process MCP; cache-key-with-runId contract test.
- **2.B Codex adapter** (parallel with 2.A) — `packages/adapters/codex` wrapping `startThread`/`runStreamed`; ChatGPT-OAuth + API-key paths.
- **2.C Session persistence + cost** (serial after either 2.A or 2.B lands) — `session_id ↔ run_id` mapping; `shamu resume <run>`; usage/cost aggregation; vendor-stream snapshot tests.

Both adapters use the Phase 0.B-confirmed CLI-auth path via `SpawnOpts.vendorCliPath`.

Phase 2 exit criterion (PLAN.md): single-agent runs for both vendors; `shamu resume` produces cache-warm follow-up turns (verified by `cache_read_input_tokens > 0`).

## Followups to absorb in Phase 2

1. **Regenerate 0.B event fixtures** against the final schema shape; drop the replay shim in `packages/adapters/base/test/phase0-fixtures.test.ts`.
2. **`runId` injection via `SpawnOpts`.** Phase 1 echo adapter mints its own; Phase 2 vendor adapters must accept orchestrator-supplied ids.
3. **Exercise `subprocess.ts` real-spawn paths.** Adapters/base sits at 75.7% branch coverage because Phase 1 unit tests stub Bun; live vendor CLIs close the gap.
4. **Cache-key contract test** for Claude adapter: two runs with different system prompts must not share a cache hit (T9 from threat model).
5. **Set `STRESS_ITERATIONS=100`** in vendor adapter CIs to hit the contract-suite "100-run stress" row.

## Open questions for the user

From PLAN.md § "Remaining open questions":

1. **Naming** — keep `shamu` or workshop alternatives?
2. **A2A in v1** — must-ship or defer? (Phase 8 Track 8.B)

## Already-answered decisions (don't re-litigate)

- MIT license
- macOS + Linux, both first-class
- On-device single-user; no OIDC / no team mode / no multi-tenant
- Never runs inside GitHub Actions — always dev-laptop
- Keychain marked "always allow this app" — documented tradeoff
- Full autonomy is the design goal (not a v2 feature)

## Micro-decisions that aren't in PLAN.md but matter

- `@shamu/persistence` uses `bun test`, not Vitest. `bun:sqlite` can't load under Vitest's Node workers. Wired through `turbo run test` at the root. Don't port back.
- SQL-concat ban in `packages/persistence` is enforced by a unit test (greps source), not a Biome rule. Simpler and runs on every CI.
- `agent-ci.yml` at repo root is a dogfood marker, not a consumed config — agent-ci auto-discovers `.github/workflows/*.yml`.
- GitNexus hook fires after every commit; `npx gitnexus analyze` runs in the background. Low-friction. Leave it unless it becomes noisy.
- Placeholder `packages/shamu-smoketest/` was deleted in Phase 1.B; the toolchain canary served its purpose.

## Pointers

- `PLAN.md` — architecture + phased delivery + decisions + open questions
- `PLAN_REVIEW.md` — adversarial review (historical; shows why choices stand)
- `docs/phase-0/*.md` — spike writeups, go/no-go findings, evidence
- `docs/phase-0/event-schema-spike/fixtures/` — 0.B event captures, baseline regression data
- `.claude/skills/shamu-dev/SKILL.md` — the pipeline (load at session start)
- `AGENTS.md` / `CLAUDE.md` — GitNexus-generated code context
- `git log` — every phase has a detailed body explaining what landed

## HANDOFF maintenance

- Update at every phase boundary (end of Phase N → flip status, refresh "next" section, rotate followups).
- Update at any session end where work is mid-flight (note what agents are running, what files are half-done).
- Keep it short. If it grows past ~150 lines, something that should be in PLAN.md is leaking in.
