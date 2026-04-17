# Shamu — Multi-Agent Superharness

An agent-agnostic orchestrator that runs heterogeneous coding agents (Claude, Codex/GPT-5.4, Cursor, OpenCode, Pi, Kimi, Gemini, Amp, …) as a swarm, with inter-agent messaging, supervisor-driven watchdogs, Linear integration, and `agent-ci` as a first-class quality gate.

## Design principles

1. **Adapters, not abstractions-over-adapters.** One thin interface per vendor. No 4-layer capability model that tries to normalize "what an agent can do."
2. **SQLite is the canonical store.** One SQLite database holds events, mailbox, leases, queue, and audit log. Files on disk (worktrees, mailbox exports) are debug/human surfaces, not second sources of truth. No long-lived daemon until Phase 8 (autonomous mode); every earlier command is a short-lived process.
3. **Supervisor is the control plane.** OTP-shaped: one-for-one restarts, bounded intensity, explicit restart policy per role. Out-of-process watchdog so a stuck worker can't vouch for itself.
4. **Resumable and cheap.** Persist vendor session IDs so warm-resume is the default. Cache strategy is vendor-specific (Anthropic's 5-min TTL, Codex's thread state, OpenCode's SQLite sessions); each adapter owns its cache hygiene. The core does not pretend one model fits all vendors.
5. **Quality is a gate, not a suggestion.** Every agent patch runs through `agent-ci` before it can merge toward the integration branch. Enforcement is **branch protection + required status check + signed commits** — not a server-side `--no-verify` detector (which doesn't exist: servers can't see client-side hook flags). `--no-verify` is irrelevant if the required check fails to appear.
6. **Multi-signal stuck detection.** Progress checkpoints + state-change fingerprint + token-velocity + repeat-call fingerprint. Never single-signal.

## Why these choices (from research)

- OpenCode, ccswarm, Claude's own "Agent Teams," and mcp_agent_mail have all converged on **git-worktree + file-mailbox + lead/peer** as the minimal viable swarm substrate — not a coincidence worth fighting.
- Claude Agent SDK (`@anthropic-ai/claude-agent-sdk` v0.2.x) and Codex SDK (`@openai/codex-sdk`) are both **subprocess + JSONL event stream** under the hood. OpenCode, Pi, Amp, Gemini CLI, Aider, Q all fit the same shape. **Three adapter templates cover the entire market:** (a) subprocess + JSONL/SSE, (b) cloud REST + webhook (Cursor, Jules), (c) OpenAI-compatible chat + our own tool loop (Kimi + fallback).
- MCP 2025-11-25 for **agent↔tool**; A2A v1.0 (Signed Agent Cards, LF-governed) for **agent↔agent** if/when we leave a single box. Not ACP (dead).
- Linear MCP server + **webhooks, not polling**, as the work-intake signal. Linear's own rate-limit docs specifically tell clients not to poll.
- SQLite-as-queue beats Redis/NATS/Kafka for a single-box harness running 5–10 concurrent agents. Zero deps, durable, transactional with the rest of our state.

## Language & runtime

**TypeScript on Bun.** Every major agent SDK ships a first-class TS client (Claude, Codex, OpenCode, Pi, Amp, Gemini CLI). Bun gives fast startup, built-in SQLite, `Bun.spawn` for clean subprocess IO, and a single-binary build story (`bun build --compile`). Python would force an extra shell-out for the Codex/OpenCode/Pi native SDKs — not worth it.

**Bun is validated, not assumed.** Phase 0 runs the Claude and Codex SDKs under Bun against their real event streams and exercises SQLite WAL concurrency under 5–10 concurrent agents. Any package where Bun misbehaves declares `engine: node` and falls back; the monorepo is package-level-runtime-agnostic, and CI matrices both runtimes for adapter packages until we're confident.

## Repository layout

```
shamu/
├── apps/
│   ├── cli/                  # `shamu` CLI (run, attach, status, logs, kill)
│   └── tui/                  # optional Ink-based TUI (later)
├── packages/
│   ├── core/                 # Supervisor, scheduler, event bus, queue
│   ├── adapters/
│   │   ├── base/             # Adapter contract + shared subprocess helpers
│   │   ├── claude/           # @anthropic-ai/claude-agent-sdk adapter
│   │   ├── codex/            # @openai/codex-sdk adapter
│   │   ├── opencode/         # @opencode-ai/sdk adapter
│   │   ├── pi/               # @mariozechner/pi-coding-agent adapter
│   │   ├── cursor/           # REST + webhook adapter
│   │   ├── kimi/             # OpenAI-compatible + own tool loop
│   │   ├── gemini/           # gemini-cli-sdk adapter
│   │   └── amp/              # Sourcegraph Amp adapter
│   ├── mailbox/              # File-mailbox + advisory file leases
│   ├── worktree/             # git worktree lifecycle + cleanup
│   ├── watchdog/             # Heartbeat + stuck-detector
│   ├── linear/               # Linear MCP client + webhook receiver
│   ├── ci/                   # agent-ci integration (gate + reporter)
│   ├── persistence/          # SQLite schema, migrations, queries
│   ├── protocol/             # A2A server/client (Phase 8)
│   └── shared/               # Types, logger, errors
├── config/
│   ├── shamu.config.ts       # User config (swarm topology, roles, CI)
│   └── schemas/              # Zod schemas for config + events
├── tests/
│   ├── unit/
│   ├── integration/          # Real subprocess adapters, mocked network
│   └── e2e/                  # End-to-end with throwaway Linear project
├── .github/workflows/ci.yml  # agent-ci + lint + typecheck + tests
├── agent-ci.yml              # agent-ci config for THIS repo (dogfooding)
├── PLAN.md
└── README.md
```

## UI plan

### Philosophy

One event stream, three consumers. The core is already headless and event-sourced — every `AgentEvent` hits SQLite and an in-memory bus. The CLI, TUI, and web dashboard are **read-models over that stream**; no domain logic lives in the UI. This is what lets shamu dodge Claude Code's tmux/iTerm dependency and stay portable.

All three surfaces live in the same monorepo (TypeScript, Bun) so types, event schemas, and formatting helpers are shared.

### Surface 1 — CLI (lands Phase 1)

Headless, scriptable, CI-friendly. First-class citizen, not an afterthought.

- Commands: `run`, `resume`, `status`, `logs`, `kill`, `attach`, `flow run`, `flow status`, `doctor`, `linear tunnel`.
- Output: human text by default, `--json` for piping, `--watch` for tail-follow.
- Exit codes meaningful (distinct codes for `agent-ci` red vs supervisor escalation vs user-cancel) so shell pipelines and cron can react.
- Works over SSH with zero setup — no terminal multiplexer needed.

### Surface 2 — TUI (lands Phase 3)

Full-screen terminal dashboard built on **Ink** (React-for-terminals, Bun-compatible). Feels like `k9s` / `lazygit`: panels, keyboard-driven, vim-y bindings, mouse optional.

**Views**

- **Swarm overview (`shamu tui` home)**
  - Header: swarm name, wall-clock, aggregate cost today, active run count.
  - Left: run list, color-coded by status (running/review/blocked/done). Filterable by Linear label, vendor, flow.
  - Right: selected-run summary — current flow node, elapsed, per-role cost, latest checkpoint.
- **Run detail (`enter` on a run)**
  - Top: issue title + link, flow DAG (plan→execute→review→loop) with current node highlighted.
  - Middle: split-pane per active agent showing live event stream — assistant deltas, tool calls, tool results. Each pane is an independent `Ink` subscription; no single-stream bottleneck.
  - Bottom: mailbox (agent↔agent messages for this run), CI badge with last result, watchdog signals.
  - Controls: `i` interrupt, `m` change model, `p` change permission mode, `k` kill, `R` restart under supervisor, `f` follow-tail, `/` filter.
- **Supervisor tree (`shamu tui sup`)**
  - Visual tree of supervisor → role → worker. Restart counts, policies, last-escalation reason.
- **Mailbox inspector (`shamu tui mail`)**
  - All messages across the swarm, threaded by recipient. Useful for debugging coordination.
- **Log explorer (`shamu tui log`)**
  - Searchable event log across all runs; filter by run/agent/tool/kind/date.
- **Status bar** (every view): watchdog indicator, queued runs, API-rate-limit budget per vendor, unread escalations.

**Why Ink vs plain TTY redraw:** Ink gives us a React component model so panes are composable and events are diffed (no flicker). Components do **not** reuse in the web dashboard — terminal primitives aren't DOM and pretending otherwise leads to two half-finished UIs. What reuses across TUI and web: the event-formatter layer (`packages/shared/format`), design tokens, view models (derived from the SQLite event projection), the SSE subscription pattern, and the keyboard-binding table. Components get rewritten per surface.

### Surface 3 — Web dashboard (lands Phase 7)

For remote monitoring, sharing a run view in a PR, viewing from a phone, and team/multi-user mode. **Local-first, cloud-optional.**

- **Stack:** Hono (Bun-native HTTP) + **SolidJS** frontend. Fine-grained reactivity is a clean fit for a constantly-updating event stream; bundle is small; no virtual-DOM tax.
- **Transport:** Server-Sent Events from the Bun server, reusing the exact `AgentEvent` schema. One-way push — simpler than WebSockets and fits the read-model pattern.
- **Auth:** binds to `127.0.0.1` by default, no auth. For team mode: OIDC (GitHub/Google/Okta) + signed session cookies. No bespoke auth.
- **Storage:** read-only over the same SQLite database the CLI/TUI use — no separate store.
- **Layout:** mirrors the TUI screens but with richer affordances —
  - Flow DAG rendered as a proper graph (not ASCII), zoomable.
  - Diff viewer for patches produced by the executor (before/after, hunks highlighted).
  - CI output inline with collapsible failure groups.
  - Linear issue embed in a side-drawer (via Linear's issue-preview OEmbed).
  - Cost/usage charts (per-run, per-role, per-vendor, last 7/30 days).
- **Shareable URLs:** every run has a stable URL (`/run/<id>`); team mode puts ACL on that URL.
- **Mobile:** layouts responsive; read-only on phones (no interrupt/kill controls — too easy to fat-finger).

### Shared design elements (across TUI + web)

- **Event formatters** (`packages/shared/format`): one canonical way to render each `AgentEvent` as a line — reused by CLI logs, TUI panes, and web log views.
- **Color palette**: accessible (WCAG AA), terminal-safe subset used by TUI; extended palette for web. One source of truth (JSON tokens).
- **Copy**: terse, scanable. No emoji in default output — they're a liability in CI logs and screen readers.
- **Keyboard parity**: TUI bindings mirror vim/k9s conventions; web dashboard exposes the same bindings (and shows them in a `?` overlay).

### Task breakdown

**Phase 1 — CLI (Serial with other Phase 1 work)**
- [ ] Citty/commander command framework with per-command `--json` + `--watch`
- [ ] `run`, `resume`, `status`, `logs`, `kill`, `attach` scaffolds
- [ ] Canonical event formatter (`packages/shared/format`)
- [ ] Exit-code taxonomy documented and enforced
- [ ] `shamu doctor` env/auth health check (initially a stub; filled in each phase)

**Phase 3 — TUI (Parallel with Phase 3 supervisor/mailbox work)**
- [ ] `apps/tui` Ink bootstrap; route/view component model
- [ ] Swarm overview view (list + summary, SQLite subscription)
- [ ] Run detail view (flow DAG + per-agent panes + mailbox + CI badge)
- [ ] Supervisor tree view
- [ ] Mailbox inspector view
- [ ] Log explorer view with filter/search
- [ ] Keyboard bindings + `?` help overlay
- [ ] Accessibility: screen-reader-friendly fallback mode (`--simple`)

**Phase 7 — Web dashboard (Track 7.H — Parallel with adapter fan-out)**
- [ ] Hono server in `apps/web` with SSE endpoint over `AgentEvent`
- [ ] SolidJS frontend scaffold + router + design tokens
- [ ] Swarm overview page
- [ ] Run detail page with DAG visualization (D3 or Cytoscape)
- [ ] Diff viewer for executor patches
- [ ] CI output viewer with collapsible groups
- [ ] Cost/usage charts (last 7/30/90 days)
- [ ] Local-only auth skip + optional OIDC team mode
- [ ] Mobile responsive pass; read-only controls on narrow viewports
- [ ] Shareable run URL with ACL (team mode)

**Phase 8 — UI ops polish (folds into Track 8.C in the Phased delivery section below)**
- [ ] `bun build --compile` packages CLI + TUI + web into a single binary
- [ ] `shamu ui` command opens the web dashboard in the default browser
- [ ] Screenshot CI: every PR gets TUI + web screenshots captured via headless render (helps reviewers see UI changes)

### Non-goals for v1

- **No IDE extension.** A Zed ACP bridge or VS Code extension is plausible later, but each is a second product. Ship the three surfaces first.
- **No custom designer tool.** Flow DAGs are edited as TypeScript, not a drag-and-drop canvas.
- **No multi-tenant SaaS.** Local-first with optional OIDC; hosted mode is deliberately out of scope until there's demand.

## Core architecture

### 1. Adapter contract (`packages/adapters/base`)

```ts
export interface AgentAdapter {
  readonly vendor: string;
  readonly capabilities: Capabilities;      // declared, not inferred

  spawn(opts: SpawnOpts): Promise<AgentHandle>;
  resume(sessionId: SessionId, opts: SpawnOpts): Promise<AgentHandle>;
}

export interface AgentHandle {
  readonly runId: RunId;                    // shamu-local
  readonly sessionId: SessionId | null;     // vendor id for resume
  readonly events: AsyncIterable<AgentEvent>;

  send(message: UserTurn): Promise<void>;
  interrupt(reason?: string): Promise<void>;
  setModel(model: string): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  shutdown(reason: string): Promise<void>;
  heartbeat(): { lastEventAt: number; seq: number };
}
```

**Event model splits into raw vendor events and normalized projections.** No `extra` grab-bag — if a vendor concept affects core behavior, it gets a typed event kind or a capability flag. Every normalized event carries correlation IDs, a monotonic sequence, and a typed payload.

```ts
interface EventEnvelope {
  eventId: EventId;              // ULID, globally unique
  runId: RunId;
  sessionId: SessionId | null;
  turnId: TurnId;                // groups events belonging to one vendor turn
  parentEventId: EventId | null; // tool_result → tool_call, etc.
  seq: number;                   // monotonic within run
  tsMonotonic: number;
  tsWall: number;
  vendor: string;
  rawRef: RawEventRef | null;    // pointer into raw_events table
}

export type AgentEvent = EventEnvelope & (
  | { kind: "session_start"; source: "spawn" | "resume" | "fork" }
  | { kind: "session_end"; reason: string }
  | { kind: "assistant_delta"; text: string }
  | { kind: "assistant_message"; text: string; stopReason: string }
  | { kind: "tool_call"; toolCallId: ToolCallId; tool: string; args: unknown }
  | { kind: "tool_result"; toolCallId: ToolCallId; ok: boolean; summary: string; bytes: number }
  | { kind: "permission_request"; toolCallId: ToolCallId; decision: "pending"|"allow"|"deny"|"ask" }
  | { kind: "patch_applied"; files: string[]; stats: { add: number; del: number } }
  | { kind: "checkpoint"; summary: string }
  | { kind: "stdout" | "stderr"; text: string }
  | { kind: "usage"; model: string; tokens: Tokens; cache: CacheStats }
  | { kind: "cost"; usd: number | null; confidence: "exact"|"estimate"|"unknown"; source: string }
  | { kind: "interrupt"; requestedBy: "user"|"supervisor"|"watchdog"|"flow"; delivered: boolean }
  | { kind: "turn_end"; stopReason: string; durationMs: number }
  | { kind: "error"; fatal: boolean; code: string; message: string; retriable: boolean }
);
```

**Capabilities are declared, not inferred.** Core asks, never guesses:

```ts
interface Capabilities {
  resume: boolean;
  fork: boolean;
  interrupt: "cooperative" | "hard" | "none";
  permissionModes: PermissionMode[];
  mcp: "in-process" | "stdio" | "http" | "none";
  customTools: boolean;
  patchVisibility: "events" | "filesystem-only";
  usageReporting: "per-turn" | "per-call" | "none";
  costReporting: "native" | "computed" | "unknown";
  sandboxing: "process" | "container" | "remote" | "none";
  streaming: "events" | "final-only";
}
```

### 2. Event log (`packages/persistence/event-log`)

Two tables, one append-only, one projection.

- `raw_events(event_id, run_id, vendor, ts, payload_json)` — vendor output captured verbatim. Never migrated, never edited. Retention is configurable (default 14 days; archive to cold storage before prune).
- `events(event_id, run_id, session_id, turn_id, parent_event_id, seq, ts_monotonic, ts_wall, vendor, kind, payload_json)` — normalized projection. Schema migratable.

Writes to `events` are idempotent on `event_id`; replays of `raw_events` regenerate `events` exactly. Projection migrations run by replaying the raw log against the new projector — no destructive schema-upgrade scripts. This also means vendor SDKs can drift and we can re-derive a correct `events` table without rerunning agents.

### 3. SQLite operational rules (`packages/persistence`)

One SQLite database. **WAL mode** (`PRAGMA journal_mode=WAL`), `PRAGMA busy_timeout=5000`, `PRAGMA synchronous=NORMAL`. Exactly **one writer process** at a time — enforced by a file lock — with many lock-free readers. Queue claim uses `UPDATE ... RETURNING` against a `claimed_by`/`claimed_until` column to prevent double-pickup; every enqueued job carries an `idempotency_key` so re-enqueue is a no-op.

Migrations: schema bootstrap is protected by an advisory lock row to prevent racing runners. Backups are `VACUUM INTO` to a sibling file (WAL-safe) on a nightly cadence; the output is file-copy friendly. Compaction (`PRAGMA wal_checkpoint(TRUNCATE)`) after every VACUUM.

In-memory channels are used only for ephemeral supervisor↔worker heartbeats — not fsync'd, not replayed. They go away with the process.

### 4. Supervisor (`packages/core/supervisor`)

OTP-shaped tree. A `Swarm` supervises `Role` supervisors (`planner`, `executor`, `reviewer`, …); each role supervises workers. Restart policies per role are config-driven; defaults:

- `planner`: `{ intensity: 3 per 60s, strategy: "one_for_one", escalate: "swarm" }`
- `executor`: `{ intensity: 5 per 300s, strategy: "one_for_one", escalate: "role" }`
- `reviewer`: `{ intensity: 2 per 120s, strategy: "one_for_one", escalate: "swarm" }`

**Escalations are local domain events (`EscalationRaised`) — the supervisor never knows about Linear.** Sinks subscribe: the CLI sink surfaces them to stderr/status; the TUI sink drops a toast; the Linear sink (added in Phase 6) flips the issue to `shamu:blocked`. Core stays Linear-agnostic; Phase 3 contains no Linear stubs.

### 5. Mailbox & file leases (`packages/mailbox`)

**SQLite is the canonical store.** Tables:

- `mailbox(msg_id, swarm_id, from_agent, to_agent, body, delivered_at, read_at)`
- `leases(lease_id, swarm_id, agent, glob, acquired_at, expires_at)`

Files on disk (`.shamu/mailbox/<agent>.jsonl`) are a **transactional materialized export** for human inspection and for agents whose SDKs can't speak SQLite — updated after each DB write inside the same transaction, reconciled on boot. No dual-write: the DB is authoritative; files are regenerated from it if divergence is detected.

Advisory glob-leases only cover pre-write coordination — they do **not** prevent semantic conflicts (two agents editing independent but semantically-related areas). The **patch lifecycle** (below) owns post-edit reconciliation. The pre-commit guard rejects any commit whose author doesn't hold a live lease covering every staged path.

### 6. Watchdog (`packages/watchdog`)

Runs as a separate Bun subprocess; shares SQLite read-only so a stalled main process can't silence it. Four signals, each producing a typed observation with a **confidence value** — never a raw bool:

1. `checkpoint_lag`: no `checkpoint` event in `max(floor, 3× rolling_median_for_role)`. `confidence="unknown"` until the role has ≥ 10 checkpoints observed. Floor default 20 min.
2. `no_write_activity`: no `tool_call` matching the role's **vendor-aware write-tool allowlist** (`Edit|Write|Bash` for Claude; `apply_patch`/`shell` for Codex; per-adapter) in 15 min, and no `turn_end`.
3. `cost_velocity`: per-run cost > 4× rolling median across that role. `confidence="unknown"` for first N runs per role.
4. `tool_loop`: same `(tool, canonicalized_args_hash)` ≥ 3× consecutively. Canonicalization redacts secrets and normalizes whitespace before hashing.

Alerts require **two observations at confidence ≥ medium** to agree. Single-signal and unknown-confidence trips are logged as `watchdog.hint`, never as escalations. This is the defense against the documented "silence detector" amplification loops.

### 7. Cost accounting (`packages/persistence/cost`)

Cost is **nullable with confidence metadata** because vendor billing models don't agree:

- Anthropic and Codex report exact per-turn cost → `cost.usd` set, `confidence="exact"`, `source="vendor"`.
- Subscription-backed agents (Cursor, ChatGPT-OAuth Codex, Amp) report usage but cost is "covered by subscription" → `cost.usd=null`, `confidence="unknown"`, `source="subscription"`.
- Local-model and cache-heavy runs → `cost.usd` computed from `tokens × price_table`, `confidence="estimate"`, `source="computed"`.

Rollups surface the confidence per aggregate (`"$4.32 exact + $1.10 estimated + 2 subscription runs"`). Budgets and rate limits read from exact+estimated only; subscription runs are tracked for auditability but never block.

### 8. Workflow engine (`packages/core/flow`)

Canonical loop: `plan (GPT-5.4) → execute (Opus 4.7) → review (GPT-5.4) → loop until reviewer approves or max iterations`. Expressed as a typed, serializable DAG (`AgentStep`, `Conditional`, `Loop`, `HumanGate`, `ParallelFanOut`, `Join`) — resumable, inspectable, replayable. LangGraph-style DAG, not AutoGen-style group chat (5–6× cost for comparable accuracy per research).

Flow state persists to `flow_runs(flow_run_id, dag_version, state_json, resumed_from)`. Any flow can resume against its last completed node; node outputs are content-hashed so reruns deduplicate.

### 9. Linear integration (`packages/linear`) — an optional sink

Domain events (`EscalationRaised`, `RunStarted`, `RunCompleted`, `CIRed`, `PatchReady`) are published locally; the Linear package is one subscriber among several. If Linear isn't configured, the core is unaffected.

- OAuth 2.1 DCR against `mcp.linear.app/mcp`; tokens in OS keychain.
- Webhook receiver (Bun HTTP) for `issue-label-added` / `comment-created` / `status-changed`. HMAC signature verification required (constant-time compare). Replay protection via timestamp window (default 5 min) + nonce cache.
- One label = one swarm lane: `shamu:ready`, `shamu:in-progress`, `shamu:review`, `shamu:blocked`.
- One run = one rolling comment + status transitions + PR attachment.
- Rate-limit aware (Linear returns budget headers); back off on 429 and surface as a domain event.

### 10. Quality gate (`packages/ci`)

`packages/ci/gate.ts` wraps `agent-ci` (spawn, parse JUnit/JSON, surface failures as events on the run). No swarm patch is marked "ready" without a green run.

Three enforcement layers:

1. **Local**: pre-commit hook consults the lease table and can refuse the commit.
2. **Pre-PR**: the flow engine blocks the reviewer-approve transition on a red `agent-ci` run.
3. **Server-side (GitHub/etc.)**: protected-branch settings require the `agent-ci` status check and signed commits. A local `--no-verify` is moot — the required check simply never posts, so the branch rule blocks the merge.

Reviewer agents receive CI summaries + failure excerpts (not raw logs — token-hungry), must reason about failures, and cannot rubber-stamp. Three consecutive red runs per role trip the watchdog via the `CIRed` domain event.

---

## Security & threat model

The harness runs semi-trusted agent behavior with shell/file/network access, stores OAuth and API credentials, injects MCP tools, may open webhook receivers, and exposes a local dashboard. A threat model lands in Phase 0 and is enforced by the patterns below.

**Credential handling**

- All API keys live in the OS keychain (`security` on macOS, `libsecret` on Linux, DPAPI on Windows) — never in `.env` committed to the repo, never in the SQLite DB.
- Environment variables passed to agent subprocesses are **allowlisted** per adapter config. Default allowlist is `PATH`, `HOME`, `LANG`, `USER`, plus the single vendor-specific key the adapter needs.
- Secrets are redacted from every log sink via a central redactor (regex + exact-value hash list) applied by the event-log projector before `events` is written. Planted-secret tests are a contract-suite requirement.

**Per-agent sandbox**

- Filesystem: each worker runs in its own git worktree under `.shamu/worktrees/<run-id>/`. Writes outside the worktree fail at the pre-commit guard and are logged as policy violations.
- Network: egress allow-list per run (`allowed_hosts: [...]`). Violations are surfaced as events; enforcement requires containerization and ships in Phase 8.
- Command execution: shell tool calls are gated through `PermissionMode` in Phase 2; the permission handler consults a per-role allow/deny list of command patterns.
- Process: Bun subprocesses inherit the allowlisted env only; CWD is pinned to the worktree; signals are brokered through the adapter handle (no rogue kills).

**Webhook hardening**

- HMAC-SHA256 signature verification, constant-time compare.
- Timestamp window (default 5 min) + SQLite-backed nonce cache rejects replays.
- Per-source-IP rate limit; log-and-drop above threshold.
- `shamu linear tunnel` prints a warning banner that the tunnel is publicly reachable and rotates the subdomain per invocation.

**Dashboard**

- Binds to `127.0.0.1` by default. `0.0.0.0` requires `--unsafe-bind` and prints a banner.
- Team mode: OIDC + signed session cookies. CSRF tokens on state-changing endpoints (few: `interrupt`, `kill`, `setModel`, `setPermissionMode`, `approve`, `deny`).
- SSE endpoint rejects `Origin` headers outside the configured allow-list.
- No run secrets in query strings or path segments — everything behind auth.

**Audit log**

- Every control-plane action is persisted as a typed audit event — actor, reason, timestamp, affected entity — into a separate append-only `audit_events` table. Immutable; not co-mingled with `raw_events` or `events`.

---

## Patch lifecycle

The unit of work an executor produces. Sits between the mailbox/lease layer and the CI gate.

1. **Claim.** Executor acquires a lease over a glob before reading/writing. Stale leases (expired) can be reclaimed only after a "last touch" check against the git index — if the holding worker has uncommitted changes under the glob, the stale lease is promoted to a **conflict artifact** and an `EscalationRaised` event fires.
2. **Edit.** Worker edits within its worktree. Only paths under live leases held by this worker are allowed; pre-commit guard enforces.
3. **Commit.** Signed commit on `shamu/<run-id>`. Message includes `run_id`, `flow_run_id`, `flow_node_id`, `lease_ids`.
4. **CI.** Gate fires `agent-ci`; result attaches to the run (events + artifact rows).
5. **Review.** Reviewer agent receives diff + CI summary + lease metadata. Verdict is `approve` / `revise` / `block`.
6. **Integrate.** On approve + green CI, patch merges into the swarm's integration branch (`shamu/integration/<swarm-id>`). Integration branch reruns `agent-ci` after each merge; red → **automatic revert + `CIRed` event + reviewer re-engagement**. A post-merge **diff-overlap check** flags two approved patches that touched shared files or test/config; overlaps fan back to a reconcile node in the flow rather than silently winning last-writer-wins.
7. **Human handoff.** Integration branch → human PR against the target branch. Human merges (or closes); Linear attachment updates.

Failure paths: a patch that fails CI after N retries is marked `quarantined`, its branch is preserved, and the flow node fails over to `HumanGate`. Quarantined patches accumulate in a `shamu:quarantine` view and don't block other lanes.

---

## Adapter acceptance criteria

Every adapter — including the built-ins — must pass the shared contract suite before merging. A "yes" per row means "supported AND covered by a contract test." A "no" means the adapter must **declare** it in `Capabilities`; an undeclared "no" is a contract-suite failure.

| Criterion | Minimum expectation |
|-----------|---------------------|
| `spawn` → working handle | assistant message streams within 30s |
| `resume(sessionId)` warm-start | cache/session metrics observable; turn succeeds |
| `events` async iterable | yields `session_start`, ≥ 1 `assistant_*`, `turn_end` in order |
| `send` multi-turn | follow-up in same session produces correlated `turn_id` |
| `interrupt()` | `interrupt` event published, next `turn_end`/`error` within 10s |
| `setModel` | subsequent `usage` events report new model |
| `setPermissionMode` | `permission_request` events respect new mode |
| `shutdown(reason)` | handle completes, subprocess reaped, no orphans |
| Tool-call visibility | `tool_call` + `tool_result` with matching `toolCallId` |
| Patch metadata | `patch_applied` for every file write (unless `patchVisibility: "filesystem-only"` declared) |
| Usage + cost | `usage` per turn; `cost` with declared confidence |
| Error surfaces | `error` with `fatal` + `retriable` set accurately on forced-fail cases |
| No leaks | 100-run stress: no subprocesses, no DB locks, no orphan worktrees |
| Secret redaction | planted API-key strings in prompts/tool-args appear redacted in `events` |

Capability declarations are schema-validated; the contract suite reads `capabilities` and skips tests the adapter has opted out of — but logs the opt-out so reviewers notice when an adapter declares itself less capable over time.

---

## Phased delivery

**Nine phases (0 through 8).** Each phase ships a usable slice and is gated by its own `agent-ci` green.

Calendar time is deliberately unassigned. The review agent flagged an 8-week timeline as fantasy for a team of humans — that's true and also beside the point: shamu's premise is that an AI swarm does the work and humans review. A swarm dogfooding itself from Phase 3 onward is the point, not a nice-to-have. Phases complete when their exit criteria pass; the `agent-ci` gate plus the acceptance checks are the only speed governor we trust.

**Notation:** Tasks are grouped into **Tracks** within each phase. Tracks labeled "Parallel" can proceed concurrently (no inter-track dependencies). Tracks labeled "Serial" must complete their predecessor first. A ⇢ marker on an individual task means "blocks the next track."

### Phase 0 — De-risking spike (before any contracts freeze)

Time-boxed validation of the assumptions that cost the most if they're wrong. Every task produces a **kill-switch finding** checked into `docs/phase-0/` — a written go/no-go with evidence. Contract edits happen in response to these findings before Phase 1 starts.

**Track 0.A — Bun compatibility (Parallel)**
- [ ] Claude Agent SDK under Bun: `spawn`, JSONL streaming, hook bridge; compare event shapes to Node reference
- [ ] Codex SDK under Bun: `startThread`/`runStreamed` shape, resume, subprocess reaping under SIGINT/SIGTERM
- [ ] SQLite WAL under Bun with 5–10 concurrent readers + 1 writer; measure p50/p99 write latency under realistic event volume
- [ ] `bun build --compile` single-binary with SQLite embedded; smoke on macOS arm64 + Linux x86_64
- [ ] **Kill-switch:** if any package misbehaves, declare `engine: node` for that package and matrix both runtimes in CI

**Track 0.B — Event schema adequacy (Parallel)**
- [ ] Capture raw event streams from Claude and Codex on three canonical tasks (bug fix, refactor, new feature) — stored as fixtures
- [ ] Project into the draft normalized schema; record every field that required a new kind or extension
- [ ] Lock the `AgentEvent` taxonomy against evidence, not a priori design
- [ ] **Kill-switch:** if >20% of observed behaviors need `extra`-style grab-bag, redesign before Phase 1

**Track 0.C — Worktree merge mechanics (Parallel)**
- [ ] Manufactured conflicts: two agents edit overlapping files in separate worktrees; prove the post-merge diff-overlap check catches it
- [ ] Integration-branch rerun-CI loop with induced red patches; verify automatic revert + `CIRed` flow
- [ ] Measure cleanup cost and disk footprint with 10 concurrent worktrees
- [ ] **Kill-switch:** if reconcile loop isn't deterministic, redesign the patch lifecycle before Phase 3

**Track 0.D — agent-ci integration shape (Parallel)**
- [ ] Invoke `agent-ci` against a scratch repo; capture JSON/JUnit output structure
- [ ] Decide failure-excerpt extraction heuristic (token-bounded, deterministic)
- [ ] Write a replay harness so reviewer-context tests don't need live CI runs
- [ ] **Kill-switch:** if `agent-ci` output isn't stable enough to parse cleanly, add a structured-output request upstream before Phase 5

**Track 0.E — Threat model writeup (Parallel with everything)**
- [ ] Data-flow diagram: credentials, user prompts, webhook payloads, agent outputs
- [ ] Trust boundaries drawn (host ↔ agent, agent ↔ vendor API, local ↔ webhook sender, local ↔ dashboard client)
- [ ] Mitigations mapped to the Security & threat model section above; gaps flagged as phase blockers

**Exit:** five writeups under `docs/phase-0/`; adapter contract, event schema, patch lifecycle, CI integration, and threat model edits merged into `PLAN.md` based on findings.

---

### Phase 1 — Foundations

**Track 1.A — Repo bootstrap (Serial, blocks everything else)**
- [ ] Init Bun workspace + `turborepo` (or `moonrepo`) topology ⇢
- [ ] Wire Biome lint/format, Vitest, TypeScript strict config ⇢
- [ ] `.github/workflows/ci.yml` skeleton (lint + typecheck + test)

**Track 1.B — Shared foundations (Parallel, start after 1.A)**
- [ ] `packages/shared`: `Logger`, `Result<T,E>` helpers, error taxonomy, branded IDs
- [ ] `packages/shared`: Zod schemas for `AgentEvent`, `SpawnOpts`, `Capabilities`
- [ ] `packages/persistence`: SQLite schema + migration runner
- [ ] `packages/persistence`: tables for `runs`, `sessions`, `events`, `checkpoints`, `mailbox`, `leases`, `linear_issues`, `ci_runs`
- [ ] `packages/persistence`: typed query helpers (no ORM — prepared statements)

**Track 1.C — Adapter contract (Serial after 1.B shared types)**
- [ ] `packages/adapters/base`: `AgentAdapter`, `AgentHandle`, `AgentEvent` interfaces
- [ ] `packages/adapters/base`: subprocess-with-JSONL helper (Bun.spawn + line splitter + backpressure)
- [ ] `packages/adapters/base`: normalized event replayer (record/replay for tests)
- [ ] `packages/adapters/base`: shared contract test suite (will be run by every adapter)

**Track 1.D — CLI shell (Parallel with 1.C, depends on 1.B)**
- [ ] `apps/cli`: command framework (`citty` or `commander`)
- [ ] `shamu run`, `shamu status`, `shamu logs <run>`, `shamu kill <run>` scaffolds
- [ ] Config loader (Zod-validated `shamu.config.ts`)

**Track 1.E — Stub adapter (Serial after 1.C)**
- [ ] `packages/adapters/echo`: emits canned events; passes contract suite
- [ ] End-to-end smoke: `shamu run --adapter echo` → events streamed to stdout + persisted

**Exit:** `shamu run --adapter echo` round-trips a scripted session; CI green on lint+types+tests.

---

### Phase 2 — Claude + Codex adapters

**Track 2.A — Claude adapter (Parallel)**
- [ ] `packages/adapters/claude`: wrap `query()` and `ClaudeSDKClient` behind `AgentAdapter`
- [ ] Hook bridge: `PreToolUse`/`PostToolUse`/`Stop`/`SessionStart` → normalized events
- [ ] `setModel`, `setPermissionMode`, `interrupt`, `rewindFiles` passthroughs
- [ ] In-process MCP server injection for orchestrator-provided tools
- [ ] Claude-specific contract test suite run

**Track 2.B — Codex adapter (Parallel with 2.A)**
- [ ] `packages/adapters/codex`: wrap `@openai/codex-sdk` `startThread`/`resumeThread`/`runStreamed`
- [ ] JSONL event normalization (`item.completed`, `turn.completed`)
- [ ] Thread-ID persistence; `CODEX_API_KEY` + ChatGPT-OAuth auth paths
- [ ] Codex-specific contract test suite run

**Track 2.C — Session persistence & cost (Serial, depends on 2.A or 2.B landing)**
- [ ] Persist `session_id` ↔ `run_id` mapping into SQLite
- [ ] `shamu resume <run>` CLI command
- [ ] `usage` + `total_cost_usd` aggregation per run, per role
- [ ] Snapshot tests: normalized event stream for each vendor

**Exit:** single-agent run for both vendors; `shamu resume` produces cache-warm follow-up turns (verified by `cache_read_input_tokens > 0`).

---

### Phase 3 — Supervisor, worktrees, mailbox

Three tracks fully parallel — none depends on the others' internals, only on Phase 1/2 primitives.

**Track 3.A — Supervisor (Parallel)**
- [ ] `packages/core/supervisor`: OTP-shaped `Supervisor` type, restart strategies (`one_for_one`, `rest_for_one`)
- [ ] Restart-intensity bookkeeping (N restarts per T seconds → escalate)
- [ ] Per-role policy config (planner/executor/reviewer defaults)
- [ ] Escalation publishes `EscalationRaised` domain event; in-memory subscriber surfaces to CLI/status. No Linear coupling — that sink lands in Phase 6
- [ ] Unit tests: simulated worker crashes exercising every restart path

**Track 3.B — Worktrees (Parallel)**
- [ ] `packages/worktree`: create/destroy `.git/worktrees/shamu-<run-id>`
- [ ] Per-run branch naming convention; detach on cleanup
- [ ] GC: prune worktrees whose run row is `completed`/`failed` and older than N hours
- [ ] Lease-aware pre-commit hook installer (placeholder until 3.C lands)

**Track 3.C — Mailbox & leases (Parallel)**
- [ ] `packages/mailbox`: SQLite tables `mailbox` + `leases` as canonical store; `.shamu/mailbox/<agent>.jsonl` files as transactional materialized export (reconciled on boot)
- [ ] `broadcast`, `whisper`, `read`, `mark_read` primitives (DB-backed, file-exported)
- [ ] TTL'd advisory leases keyed on glob; stale-lease reclaim requires git-index "last touch" check
- [ ] Pre-commit guard: reject commit if author doesn't hold a live lease on any staged path
- [ ] Contract test: two workers racing on the same glob; one is rejected cleanly

**Track 3.D — Watchdog (Serial after 3.A supervisor + any adapter emitting `checkpoint` events)**
- [ ] `packages/watchdog`: out-of-process Bun subprocess, shares SQLite read-only
- [ ] Four signals with typed confidence values: `checkpoint_lag`, `no_write_activity`, `cost_velocity`, `tool_loop`
- [ ] Vendor-aware write-tool allowlist per adapter (Claude: `Edit|Write|Bash`; Codex: `apply_patch|shell`; …)
- [ ] Trip rule: two observations at `confidence ≥ medium` must agree; single-signal trips logged as `watchdog.hint` only
- [ ] Argument canonicalization + secret redaction before hashing for `tool_loop`
- [ ] Integration test: manufactured stall trips watchdog within expected window; manufactured cold-start shows `confidence=unknown` and no false escalation

**Exit:** two Claude workers in parallel worktrees coordinate via mailbox; supervisor restarts a killed worker under policy; watchdog fires on a manufactured stall.

---

### Phase 4 — Plan → Execute → Review flow

Mostly serial — the flow engine composes earlier primitives.

**Track 4.A — Flow engine (Serial)**
- [ ] `packages/core/flow`: typed DAG nodes (`AgentStep`, `Conditional`, `Loop`, `HumanGate`)
- [ ] Serializable state (resumable after crash)
- [ ] Event stream: per-node progress, per-node cost roll-ups

**Track 4.B — Canonical flow (Serial after 4.A)**
- [ ] `flows/plan-execute-review.ts`: GPT-5.4 planner → Opus executor → GPT-5.4 reviewer → loop until approve / max-iterations
- [ ] Context passing: planner output → executor input, executor diff → reviewer input
- [ ] Approve/revise verdict schema for reviewer

**Track 4.C — CLI + telemetry (Parallel with 4.B)**
- [ ] `shamu flow run <name> --task "..."`
- [ ] `shamu flow status <flow-run>` — per-node breakdown
- [ ] Structured JSON logs per flow-run for later replay

**Exit:** flow completes end-to-end on a sample repo; reviewer reject causes a clean executor re-run with prior diff + reviewer notes in context.

---

### Phase 5 — agent-ci gate

**Track 5.A — CI wrapper (Parallel)**
- [ ] `packages/ci/gate`: spawn `agent-ci`, parse JUnit/JSON output
- [ ] Map failures into `AgentEvent` stream as blocking events
- [ ] Artifact capture (logs, reports) attached to run row in SQLite

**Track 5.B — Reviewer integration (Parallel with 5.A)**
- [ ] Reviewer agent input schema includes CI summary + failure excerpts (not raw logs — token-hungry)
- [ ] Reviewer verdict can require "re-run CI after changes" without declaring approval
- [ ] Flow engine: reviewer approval blocked on red CI

**Track 5.C — Quality bars (Serial after 5.A + 5.B)**
- [ ] Per-role CI-failure counter; watchdog tripwire on three consecutive reds
- [ ] `agent-ci.yml` for this repo — required on all shamu PRs
- [ ] GitHub branch protection on `main` + `shamu/integration/*`: required `agent-ci` status check, signed-commit requirement, linear-history requirement. A local `--no-verify` simply leaves the required status missing — the rule does the work

**Exit:** swarm run cannot mark a patch "approved" without green `agent-ci`; shamu's own repo enforces the same gate on itself.

---

### Phase 6 — Linear integration

**Track 6.A — Auth + client (Serial)**
- [ ] OAuth 2.1 DCR flow against `mcp.linear.app/mcp`; token persistence (Keychain on macOS / libsecret on Linux)
- [ ] Typed MCP client wrapper for the issue/comment/status tools actually used

**Track 6.B — Webhook receiver (Parallel with 6.A)**
- [ ] `packages/linear/webhook`: Bun HTTP server; signature verification
- [ ] Helper: `shamu linear tunnel` wraps cloudflared for local dev
- [ ] Subscriptions: issue-label-added, comment-created, status-changed

**Track 6.C — Work-intake conventions (Serial after 6.A + 6.B)**
- [ ] Label conventions: `shamu:ready` → picked up; `shamu:in-progress` → working; `shamu:review` → awaiting human; `shamu:blocked` → escalated
- [ ] Rolling-comment updater: one comment per run, edited in place with checkpoint appends
- [ ] PR link as Linear attachment on completion
- [ ] Escalation path: watchdog-trip → status flip to `shamu:blocked` + comment with incident summary

**Track 6.D — Integration test (Serial after 6.C)**
- [ ] E2E against a throwaway Linear workspace: label → pickup → PR → status flip

**Exit:** a Linear issue with `shamu:ready` gets picked up, worked, and ends with a PR link + status flip, entirely webhook-driven.

---

### Phase 7 — Adapter fan-out + web dashboard

Biggest parallel fan of any phase. Six adapter tracks plus one web-dashboard track, all independent. Each lands individually once its contract suite is green.

**Tracks 7.A–7.F — Adapters (all Parallel)**
- [ ] 7.A — `packages/adapters/opencode` on `@opencode-ai/sdk` (SSE event mapping; BYO provider keys via `client.auth.set`)
- [ ] 7.B — `packages/adapters/pi` on `@mariozechner/pi-coding-agent` (`runRpcMode` + event subscribe)
- [ ] 7.C — `packages/adapters/cursor` (REST + webhook; async job handles; no streaming; poll fallback)
- [ ] 7.D — `packages/adapters/gemini` on `@google/gemini-cli-sdk`
- [ ] 7.E — `packages/adapters/amp` shelling out to `amp -x --stream-json`
- [ ] 7.F — `packages/adapters/kimi`: OpenAI-compat chat + our own tool loop (fallback template)

**Track 7.G — Capability matrix (Serial after 7.A–7.F)**
- [ ] Generate capability matrix from each adapter's `Capabilities` declaration
- [ ] Contract suite runs against all six on every PR (parallel matrix job in CI)
- [ ] Docs page: "Which adapter supports what"

**Track 7.H — Web dashboard (Parallel with 7.A–7.F; see UI plan task breakdown above)**
- [ ] All web-dashboard tasks from the UI plan land here

**Exit:** integration test spawns one of each adapter against the same trivial task; capability matrix published; web dashboard reaches feature parity with the TUI for read-only views.

---

### Phase 8 — Autonomous mode + A2A + ops polish

Crosses the CLI-process → long-lived-service line. A2A stays optional; autonomous loop is the headline.

**Track 8.A — Autonomous loop (Parallel)**
- [ ] Daemon mode: long-lived process subscribed to Linear webhooks, picks up `shamu:ready` issues, runs canonical flow
- [ ] Rate limiter: global concurrency cap + per-role cap; queue overflow → `shamu:blocked` with reason
- [ ] Graceful shutdown: drain running runs into a resumable state before exit
- [ ] 24-hour soak test on staging Linear project

**Track 8.B — A2A server (Parallel with 8.A, optional for v1)**
- [ ] `packages/protocol/a2a`: A2A v1.0 server + client
- [ ] Signed Agent Cards: card signing, card verification on inbound
- [ ] JSON-RPC + SSE transport
- [ ] Auth: bearer tokens bound to Agent Card issuer
- [ ] Example: remote Claude agent hosted on another box joins a local swarm

**Track 8.C — Ops polish (Serial after 8.A; subsumes the UI plan's Phase 8 items)**
- [ ] `shamu doctor`: environment/auth/webhook health check (previously stubbed)
- [ ] `bun build --compile` single-binary release + GitHub Releases workflow
- [ ] `shamu ui` opens the web dashboard in the default browser
- [ ] Screenshot CI: every PR gets TUI + web screenshots captured via headless render
- [ ] README, architecture diagram, contribution guide, threat-model summary
- [ ] Network egress enforcement via container sandbox (closes the Phase 0 threat-model gap)

**Exit:** 24-hour autonomous run on staging Linear with watchdog + escalation proven; signed single-binary release shipped.

---

## Parallelization summary

| Phase | Max parallel tracks | Critical path |
|-------|---------------------|---------------|
| 0 | 5 | All spikes in parallel; writeups are the gate |
| 1 | 2 (after bootstrap) | Bootstrap → Adapter contract → Stub adapter |
| 2 | 2 | Either adapter → session/cost layer |
| 3 | 3 | Any track → watchdog integration |
| 4 | 2 | Flow engine → canonical flow |
| 5 | 2 | CI wrapper + reviewer integration → quality bars |
| 6 | 2 | Auth + webhooks → conventions → E2E |
| 7 | **7** | Adapter fan-out + web dashboard → capability matrix |
| 8 | 2 | Autonomous loop → ops polish |

Phases 0, 3, and 7 are the biggest parallelization wins — up to 5, 3, and 7 concurrent workstreams respectively. Once the shamu swarm is dogfooding itself (Phase 3 onward), those tracks are natural assignments for parallel agent workers: one Claude executor per track, supervised. Phase 7's seven-wide fan-out is what takes the overall calendar time from "months" to "days, if the swarm holds together."

## Quality bars (enforced by CI, not etiquette)

- Biome lint + format on every PR.
- `tsc --noEmit` with `strict: true`, `noUncheckedIndexedAccess: true`.
- Vitest coverage ≥ 80% on `packages/core`, `packages/adapters/base`, `packages/watchdog`, `packages/mailbox`.
- Contract tests per adapter (shared suite, each adapter must pass).
- `agent-ci` green on every PR. Enforced by GitHub branch protection + required status check + signed commits. A local `--no-verify` is irrelevant — the required check simply never posts, so the branch rule blocks the merge.
- Snapshot tests on the normalized event stream so a vendor SDK change can't silently corrupt it.

## Open questions (for the user)

1. **Licensing.** MIT, Apache-2.0, or AGPL? MIT maximizes adoption; AGPL protects if a vendor productizes it.
2. **Hosted mode?** The plan is local-first. If you want a cloud deployment path later, Phase 3's SQLite choice is still fine (Litestream to S3), but A2A + remote auth becomes the first thing to harden.
3. **Autonomy ceiling.** Phase 8 assumes a human signs off on the final PR. Do you want a `fully-autonomous: true` mode that auto-merges on green CI + two agent reviews? (Recommended: no, at least not v1.)
4. **Naming.** Keep `shamu`? Want me to workshop alternatives? (Killer whales hunt in pods — the metaphor holds.)

## Immediate next step (if approved)

Run Phase 0 first — the five spikes are cheap, parallelizable, and the whole point is to find the things that will break Phase 1's contracts before we freeze them. Then scaffold Phase 1 (Bun monorepo, SQLite schema with WAL + event log tables, adapter base contract, stub adapter, CLI skeleton, `agent-ci.yml`) in a single commit so the repo has shape.
