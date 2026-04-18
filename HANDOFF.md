# Shamu — Session Handoff

**Last updated:** 2026-04-18 (Phase 6 partial: 6.A + 6.B landed via PR #3 + #4; 6.C + 6.D next).

Any fresh session starts here. Load the `shamu-dev` skill (`.claude/skills/shamu-dev/SKILL.md`) to get the full pipeline; this file is the snapshot of *where we are right now*.

## TL;DR

Phase 6 kicked off and is half-landed:

- **Phase 6.A** (`@shamu/linear-client`) shipped via **PR #3 → `d095040`** — typed Linear GraphQL client for the operations the canonical flow uses (issue read, label add/remove, comment create/update, status change) + env-first personal-API-key resolver with `@shamu/shared/credentials` persist-back. **Pivoted from PLAN's OAuth 2.1 DCR scope** to personal-API-key + GraphQL at kickoff; the user supplied a personal key and GraphQL is a strict subset of what we need. OAuth DCR is deferred as a followup (see #1 below); credential-store coordinates exported so a future OAuth adapter can sibling the same account row without migration.
- **Phase 6.B** (`@shamu/linear-webhook`) shipped via **PR #4 → `a540946`** — Bun HTTP receiver with HMAC-SHA256 + ±5-min timestamp window + 10-min nonce-LRU replay protection, typed event union for `issue-label-added` / `comment-created` / `status-changed`, and the `shamu linear tunnel` cloudflared wrapper (scope enforced at the listener: 404 for every non-`/webhooks/linear` route; cloudflared itself can't path-filter).
- **No runtime dependency between the two** — 6.C will wire both into `@shamu/core-composition`.

17 workspace packages (adds `@shamu/linear-client` + `@shamu/linear-webhook`), 977 tests (+113: 53 from 6.A, 60 from 6.B; CLI test count unchanged — one stub test rewritten in place).

**Workflow is stable:** 6.A and 6.B both used the post-Phase-5 pattern — feature branch → PR → squash-merge with `ubuntu-latest` green. Both merges auto-signed by GitHub via web-flow. Agents worked in the main working tree on non-overlapping paths; parent split into sibling branches at review time via `git worktree add ... origin/main` per PR (cleanest way to isolate each branch's `bun.lock`).

## Read-first order for a fresh session

1. This file.
2. `git log --oneline | head -25` — shape of what's landed.
3. `PLAN.md` §§ "Core architecture", "Phased delivery → Phase 6".
4. Load `shamu-dev` skill for the pipeline mechanics.

## Where we are

| Phase | Scope | Status |
|-------|-------|--------|
| 0 | De-risking spikes | ✅ all 5, writeups in `docs/phase-0/` |
| 1 | Foundations | ✅ all 5 tracks |
| 2 | Claude + Codex adapters | ✅ all 3 tracks |
| 3 | Supervisor, worktrees, mailbox, watchdog | ✅ 4/4 tracks |
| 4 | Plan → Execute → Review flow + composition | ✅ 4/4 tracks |
| 5 | agent-ci gate | ✅ 3/3 tracks; branch protection applied |
| 6 | Linear integration | **partial: 6.A ✅ (#3), 6.B ✅ (#4); 6.C + 6.D next** |
| 7 | Adapter fan-out + web dashboard + egress broker | ⬜ |
| 8 | Autonomous mode + A2A + ops polish | ⬜ |

## Workspace packages (Phase 6.A + 6.B landed)

17 packages. Phase 6.A adds **`@shamu/linear-client`**; Phase 6.B adds **`@shamu/linear-webhook`** and rewires `shamu linear tunnel` from its Phase-1 stub to a real `startTunnel` call.

- `@shamu/shared` — events/IDs/Result/logger/**credentials** (now referenced by linear-client)/redactor/errors/capabilities
- `@shamu/persistence` — SQLite schema, migrations (v1 + v2 `flow_runs`), HMAC-chained audit, prepared-statement queries
- `@shamu/adapters-base`, `@shamu/adapter-echo`, `@shamu/adapter-claude`, `@shamu/adapter-codex` — adapter contract + production adapters
- `@shamu/cli` — **now wires `shamu linear tunnel` through `@shamu/linear-webhook`**; unchanged elsewhere
- `@shamu/core-supervisor`, `@shamu/worktree`, `@shamu/mailbox`, `@shamu/watchdog` — Phase 3 primitives
- `@shamu/core-flow`, `@shamu/flows-plan-execute-review`, `@shamu/core-composition` — Phase 4 flow engine + canonical plan → execute → ci → review flow
- `@shamu/ci` — Phase 5 agent-ci wrapper + CI domain events
- **`@shamu/linear-client` (NEW, Phase 6.A)** — personal-API-key resolver (env-first, credential-store persist-back) + typed `LinearClient` covering `getIssue` / `listLabels` / `listStates` / `addLabel` / `removeLabel` / `createComment` / `updateComment` / `setIssueStatus`; per-team label/state name→id caches; `Result<T, LinearError>` returns; rate-limit detection covers both 429+Retry-After and Linear's documented 400+RATELIMITED+X-RateLimit-*-Reset shape
- **`@shamu/linear-webhook` (NEW, Phase 6.B)** — HMAC-SHA256 verify (constant-time via `node:crypto.timingSafeEqual`) + timestamp-window + nonce-LRU; typed event discriminated union (`issue-label-added | comment-created | status-changed`); server surfaces events via async iterator on `handle.events`; `startTunnel` wraps cloudflared with injectable `spawnImpl`; `TunnelBootError` when `cloudflared` is absent

977 tests across 17 packages (+113 over end-of-Phase-5): `@shamu/linear-client` 53 (auth 11 / errors 12 / client 30), `@shamu/linear-webhook` 60 (verify 21 / events 15 / server 14 / tunnel 10). CLI test count unchanged (one stub-assertion test rewritten to the cloudflared-missing error path).

## What's in flight

Nothing. 6.A + 6.B fully merged. 6.C + 6.D not started.

## Owed manual steps

None.

## Phase 6 remaining (from PLAN.md)

**Track 6.C — Work-intake conventions (Serial after 6.A + 6.B):**
- Labels `shamu:ready` / `shamu:in-progress` / `shamu:review` / `shamu:blocked`.
- Rolling-comment updater (one comment per run, edited in place with checkpoint appends).
- PR link as Linear attachment on completion.
- Escalation path: watchdog-trip (including **`WatchdogCiTripwire` events from Phase 5.C — followup #9 below is the blocking prerequisite**) flips status to `shamu:blocked` + incident-summary comment.

**Track 6.D — Integration test (Serial after 6.C):**
- E2E against a throwaway Linear workspace: label → pickup → PR → status flip. Linear personal API key is in `.env` at repo root (gitignored). Webhook path uses `shamu linear tunnel` + cloudflared.

**Exit:** a Linear issue with `shamu:ready` gets picked up, worked, and ends with a PR link + status flip, entirely webhook-driven.

## Followups to absorb in 6.C / 6.D / later

### From Phase 6.A (new)

1. **OAuth 2.1 DCR against `mcp.linear.app/mcp`** — deferred at 6.A kickoff. Revisit when shamu is hosted multi-tenant. Credential-store coordinates (`LINEAR_CREDENTIAL_SERVICE` / `LINEAR_CREDENTIAL_ACCOUNT`) are stable + exported so a future OAuth adapter can sibling the same account row.
2. **Rate-limit shape monitoring** — Linear's current rate-limit response is HTTP 400 (not 429) with `extensions.code: RATELIMITED` + `X-RateLimit-Requests-Reset`. `@shamu/linear-client` handles both conventions, but callers that inspect `LinearError.detail.status` must not assume 429.
3. **First caller not yet wired** — `@shamu/linear-client` has no consumers yet. 6.C plugs it into `@shamu/core-composition` (or a new `packages/linear/integration`).

### From Phase 6.B (new)

4. **Async-iterator event surface is unbounded** — `handle.events` buffers without back-pressure. 6.C should drain continuously or cap via drop-oldest when wiring into the supervisor bus.
5. **In-memory nonce cache** — survives only a single process. Cross-process replay protection would need a `webhook_nonces` table in `@shamu/persistence` with TTL pruning. Low priority until the Phase 8 daemon.
6. **Linear `AgentSessionEvent` subscription** — not in the current typed union. Phase 7 may want agent-session routing once adapter fan-out lands.
7. **Live cloudflared smoke** — `tunnel.test.ts` mocks `spawnImpl`. A `SHAMU_LINEAR_LIVE=1` gate that spawns real cloudflared against a loopback server would exercise the full path end-to-end.
8. **WebCrypto swap** — we use `node:crypto.timingSafeEqual` for sync ergonomics; if a non-Bun runtime ever enters scope, swap to Web Crypto. Not a concern while we're Bun-only.

### Carried from Phase 5.A (still open)

9. **Artifact capture to SQLite** (PLAN bullet unticked). `GateResult.runDir` exists; needs a `run_artifacts` table or a reuse of an eventual `run-metadata` column. Schema migration scoped out of 5.A.
10. **Redactor pass on CI excerpts** — `@shamu/shared/redactor` not wired into `buildReviewerExcerpt`. Seam is `parseRunState`'s `summarizeJob` boundary.
11. **Agent-ci programmatic abort** — swap SIGTERM for official `abort()` when `@redwoodjs/agent-ci` exposes one.
12. **Richer live gate smoke** — `gate.test.ts`'s `SHAMU_CI_LIVE=1` block is exit-code only.

### Carried from Phase 5.B

13. **`CINodeOutput` cast safety on rehydration** — revisit when flow-run resumability tests exercise CI output.
14. **Engine-side Loop body re-execution** (inherited from 4.A) — once the engine re-invokes body nodes per iteration, collapse the reviewer-internal revise loop.
15. **Persistence `flow_run_id` ↔ CI run linkage** — observability correlation is a separate migration job.
16. **RFC upstream filing** — `docs/phase-5/rfc-report-json.md` draft. User owns whether to file on `@redwoodjs/agent-ci`.

### Carried from Phase 5.C (blocking for 6.C)

17. **CI-tripwire caller wiring** — `@shamu/watchdog/ci-tripwire` mechanism exists; nothing calls `observe()` yet. `@shamu/core-composition` is the natural home — instantiate `createCiTripwire({ emitter })` per flow-run, subscribe to `CIRed` / `PatchReady` (or `CINodeOutput.summary.status` from the flow), forward `emitCiTripwire` → supervisor bus. **This is a direct 6.C prerequisite** since the Linear sink needs `watchdog.ci_tripwire` → `shamu:blocked` status flips.
18. **`shellcheck` gate in CI** — not installed locally during 5.C; if `scripts/setup-branch-protection.sh` grows, add shellcheck on ubuntu-latest.
19. **Branch-protection script idempotency proof** — dry-run only verifies payload shapes.

### Carried from earlier phases (non-blocking)

20. **ParallelFanOut + Join node kinds** (4.A).
21. **Skipped-branch status propagation** (4.A).
22. **Richer `flow status` output** (4.C).
23. **Flow discovery** (4.C) — `shamu flow run <name>` without explicit module-spec.
24. **Progress streaming** (4.C).
25. **Paused exit code** (4.C) — taxonomy lacks `NEEDS_HUMAN`.
26. **Extend `EscalationCause`** (4.D) — add `"watchdog_agreement"` + `"lease_reclaim_refused"` + `"ci_tripwire"` variants.
27. **TTL-refresh API on leases** (3.C).
28. **Recipient-list expansion in `mailbox.broadcast`** (3.C).
29. **Non-`main` base-branch discovery** (3.B).
30. **Subprocess auto-restart for the watchdog** (3.D).
31. **Phase 0 fixture regeneration** (2.x).
32. **Resume-through-expired-session E2E coverage** (2.x).
33. **`shamu cost <run-id>` subcommand** (2.x).
34. **Live subprocess real-spawn coverage in `adapters-base`** (2.x).

## Open questions for the user

None blocking.

## Already-answered decisions (don't re-litigate)

Phase 6 additions:

- **6.A auth path** — personal API key + GraphQL instead of OAuth 2.1 DCR. User-provided key; GraphQL is a strict subset of the operations the canonical flow uses; single-tenant shamu doesn't benefit from DCR. OAuth DCR is deferred as a followup (see #1 above).
- **Linear API endpoint** — `https://api.linear.app/graphql`. Authorization header is the bare API key (Linear personal-key convention — no `Bearer ` prefix; enforced by a test).
- **Credential storage** — `@shamu/shared/credentials` under service `shamu`, account `linear-api-key`. Env-first (caller-wired, library never reads `process.env` on its own); persist-back only when the stored value differs; store failures are non-fatal with a logger hook.
- **Rate-limit handling** — `@shamu/linear-client` normalises both 429+Retry-After and Linear's 400+`extensions.code: RATELIMITED` shapes into `LinearError.detail.retryAfterSeconds` / `resetAtMs`. No retries inside the client; callers own the policy.
- **6.B event surface** — async iterator on `handle.events` (unbounded, FIFO). Back-pressure lives with the consumer (supervisor bus in 6.C). Callback-API decision rejected as redundant; a callback shim over the iterator is trivial if 6.C disagrees.
- **Unsupported event types → 202** — accept-and-drop so Linear stops retrying; they aren't surfaced to consumers. Logged at `info`.
- **Webhook path scope enforcement** — receiver 404s every non-`/webhooks/linear` route (cloudflared can't filter by path; scope enforcement is the listener's job per G10).
- **Timestamp tolerance** — ±5 min (`DEFAULT_TIMESTAMP_SKEW_MS = 300_000`). Linear's `webhookTimestamp` lives in the body, not a header.
- **Nonce cache shape** — in-memory `Map`, `maxEntries=10_000`, `windowMs=10 min`, insertion-order LRU, lazy expiry. Persistence deferred (followup #5).
- **Workspace glob** — root `package.json` adds `packages/linear/*`. Future Linear-related packages (e.g. `packages/linear/integration` in 6.C) slot in automatically.

Historical Phase 5 decisions still hold (DAG shape `plan → execute → ci → review → loop`; verdict enum `{approve, revise, requires_ci_rerun}`; `FLOW_VERSION: 2`; CI node `maxRetries: 0`; env allowlist for agent-ci subprocess; `GITHUB_REPO` resolution order; CI tripwire parallel to agreement buffer; `emitCiTripwire` optional on `WatchdogEmitter`; branch protection user-applied; CI workflow actions SHA-pinned; required status check `ubuntu-latest`).

## Pointers

- `PLAN.md` — architecture + phased delivery + decisions + open questions (Phase 6 Track 6.A bullets now ticked with the pivot note; 6.B bullets ticked)
- `.env` at repo root (gitignored) — holds `LINEAR_API_KEY` for local dev
- `packages/linear/client/` + `packages/linear/webhook/` — Phase 6.A + 6.B deliverables
- `.claude/skills/shamu-dev/SKILL.md` — the pipeline (load at session start)
- `AGENTS.md` / `CLAUDE.md` — GitNexus-generated code context
- `git log` — every phase has a detailed body

## HANDOFF maintenance

- Update at every phase boundary (end of Phase N → flip status, refresh "next" section, rotate followups).
- Update at any session end where work is mid-flight (note what agents are running, what files are half-done).
- Keep it short. If it grows past ~200 lines, something that should be in PLAN.md is leaking in.
