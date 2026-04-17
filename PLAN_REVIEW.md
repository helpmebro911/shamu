# Adversarial Review of PLAN.md

## Summary

The plan is ambitious and directionally coherent, but it has several places where the current confidence level is higher than the engineering evidence supports. The biggest risk is not the architecture itself; it is the plan acting like volatile vendor SDKs, multi-agent safety, worktree merging, CI enforcement, UI surfaces, and Linear automation are all straightforward once the base abstractions exist. They are not.

I spot-checked a few current external assumptions against official docs. Claude Agent SDK docs confirm `@anthropic-ai/claude-agent-sdk`, `query()`, in-process SDK MCP servers, session APIs, and built-in worktree tooling. OpenAI's Codex announcement confirms the TypeScript Codex SDK and `startThread()` shape. Linear confirms the MCP endpoint and OAuth 2.1 DCR support. Those parts are plausible, but the plan still overstates stability and normalization ease.

Sources:

- Anthropic Agent SDK docs: https://platform.claude.com/docs/en/agent-sdk/typescript
- OpenAI Codex SDK announcement: https://openai.com/index/codex-now-generally-available/
- Linear MCP docs: https://linear.app/docs/mcp
- A2A v1.0 docs: https://a2a-protocol.org/latest/whats-new-v1/

## Highest-Risk Issues

### 1. The timeline is fantasy-grade unless "week" means "theme," not calendar week.

Relevant lines: `PLAN.md:268`, `PLAN.md:301`, `PLAN.md:326`, `PLAN.md:383`, `PLAN.md:404`, `PLAN.md:428`

Eight weeks to ship a multi-vendor agent orchestrator, supervisor, mailbox, leases, watchdog, flow engine, `agent-ci`, Linear OAuth/webhooks, six extra adapters, TUI, web dashboard, A2A, and release packaging is not credible. The most likely failure mode is half-built infrastructure with no hardened happy path.

Recommendation: Cut v1 to one local CLI, one or two adapters, worktree isolation, append-only event log, CI gate, and a manual Linear/issue handoff. Everything else should be behind "after v1."

### 2. The adapter abstraction is too thin for what the rest of the system needs.

Relevant lines: `PLAN.md:176`, `PLAN.md:200`

`AgentEvent` lacks event IDs, timestamps, parent/turn IDs, raw vendor payloads, tool-call IDs, cancellation state, permission prompts, stderr/stdout streaming, patch metadata, retry metadata, and user/interruption events. The watchdog, TUI, replay tests, CI integration, and cost accounting all need more than this shape.

Recommendation: Add an append-only raw event table plus normalized projections. Treat normalized events as a view, not the canonical source.

### 3. "Vendor-specific fields pass through on `extra`" is not enough.

Relevant line: `PLAN.md:210`

If the core logic ever depends on `extra`, the abstraction leaks silently. If it never depends on `extra`, important behavior becomes invisible.

Recommendation: Define capability-specific event extensions explicitly: permissions, tool lifecycle, file edits, cost/usage, session resume, interrupts, and worktree state.

### 4. The plan relies on vendor APIs and product details that will move under you.

Relevant lines: `PLAN.md:17`, `PLAN.md:303`, `PLAN.md:310`, `PLAN.md:432`

The "three adapter templates cover the entire market" claim is brittle. Cursor's async cloud job model, Claude's SDK session model, Codex threads, OpenCode provider auth, CLI-only tools, and OpenAI-compatible "own tool loop" agents have materially different control surfaces.

Recommendation: Add a Phase 0 spike that implements minimal Claude and Codex adapters before freezing the contract.

### 5. Security is currently a paragraph-shaped hole.

Relevant lines: `PLAN.md:24`, `PLAN.md:114`, `PLAN.md:247`, `PLAN.md:411`

This system runs untrusted-ish agent behavior with shell/file/network access, stores OAuth/API credentials, injects MCP tools, opens webhook receivers, and may expose a dashboard. "127.0.0.1 no auth" is okay only if there are no tunnel/proxy paths and no sensitive run data in browser-accessible endpoints.

Recommendation: Before Phase 2, define a threat model covering secret redaction, sandbox policy, network egress policy, per-agent env scoping, token storage, audit logging, webhook signature validation, local dashboard CSRF protections, and tunnel safety.

### 6. The worktree/lease/merge story is underspecified and likely to bite hard.

Relevant lines: `PLAN.md:226`, `PLAN.md:337`, `PLAN.md:343`

Glob leases plus pre-commit guards do not solve concurrent semantic conflicts. Agents can waste hours editing incompatible areas before the commit guard fires.

Recommendation: Define an integration branch protocol: lease acquisition before write, stale lease recovery, conflict detection, patch application strategy, reviewer conflict loop, branch naming, cleanup, and what happens when two green patches both touch shared tests/config.

### 7. Server-side rejection of `--no-verify` is not a real control as written.

Relevant lines: `PLAN.md:398`, `PLAN.md:494`

Servers do not see whether a client used `--no-verify`; that flag only skips local hooks. You can enforce required CI, signed commits, protected branches, required status checks, and possibly commit trailers, but not the client flag itself.

Recommendation: Rewrite this as "protected branch + required `agent-ci` status + optional signed commits," not "server-side hook rejects `--no-verify`."

### 8. The UI plan is too large and partly technically hand-wavy.

Relevant lines: `PLAN.md:83`, `PLAN.md:106`, `PLAN.md:108`

Ink components do not casually render in a SolidJS web dashboard. You can share event schemas, formatters, tokens, and maybe view models, but not UI components "with minimal changes." Building CLI + TUI + web before proving the orchestration loop will dilute effort.

Recommendation: Make CLI the v1 UI. TUI/web should be consumers of stable event/query APIs after the core is proven.

## Medium-Risk Design Gaps

### SQLite-as-queue needs operational rules.

Relevant lines: `PLAN.md:20`, `PLAN.md:222`

SQLite can work, but specify WAL mode, `busy_timeout`, single-writer expectations, queue claiming semantics, idempotency keys, crash recovery, migration locking, and backup/compaction. "SQLite beats Redis" is only true if you design around its concurrency model.

### Mailbox data is split across files and SQLite without a clear source of truth.

Relevant lines: `PLAN.md:8`, `PLAN.md:224`, `PLAN.md:344`

The plan says file-mailbox, SQLite queue, and SQLite `mailbox` table. Pick the canonical store. Files can be a debug/export/readability layer, but dual-write mailboxes will create recovery bugs.

### Watchdog signals are brittle for cold starts and vendor differences.

Relevant line: `PLAN.md:230`

Rolling medians do not exist for new roles. Tool names differ by vendor. Some useful work may involve long reads or analysis without `Edit|Write|Bash`. Repeat-call detection needs canonicalized args with sensitive data redacted.

Recommendation: Add a "known unknown / low confidence" watchdog state so it does not pretend weak signals are strong.

### Cost accounting will be incomplete unless it models provider-specific billing.

Relevant line: `PLAN.md:319`

Usage and cost are not uniform across Claude, Codex, subscription-backed CLIs, local models, cached tokens, hosted jobs, and tools that hide inference behind their own billing.

Recommendation: Cost should be nullable with confidence/source metadata.

### The cache strategy is Anthropic-specific but written like a universal principle.

Relevant lines: `PLAN.md:10`, `PLAN.md:322`

"Stay inside the 5-min Anthropic cache window" should not drive the cross-vendor architecture. Make cache behavior adapter-specific. Do not use `cache_read_input_tokens > 0` as a general resume success criterion.

### Linear integration is both too late and too entangled.

Relevant lines: `PLAN.md:245`, `PLAN.md:404`

Supervisor escalation references Linear in Phase 3, but Linear is not implemented until Phase 6.

Recommendation: Keep escalation domain events local first, then add Linear as an optional sink. Otherwise Phase 3 code will have stubs in critical paths.

### Phase numbering and scope contradict themselves.

Relevant lines: `PLAN.md:51`, `PLAN.md:151`, `PLAN.md:163`, `PLAN.md:428`, `PLAN.md:449`

The repository layout says `protocol` is phase 3, but A2A lands in Phase 8. The UI plan says web lands Phase 7, but phased delivery Phase 7 is "More adapters." The UI section has a Phase 8 ops polish list, while phased Phase 8 is autonomous mode and A2A.

Recommendation: Clean this up before implementation, because contradictory plans become contradictory code.

## Decisions I Would Reconsider

### Bun-only runtime

Relevant line: `PLAN.md:24`

Bun is appealing, but many agent SDKs and CLIs are Node-first. Verify SDK compatibility, subprocess behavior, native package support, single-binary packaging, and CI/GitHub Actions behavior before committing. Bun can still be the target, but Phase 0 should prove it.

### SolidJS for web

Relevant line: `PLAN.md:112`

Solid is fine technically, but this repo already proposes Ink/React for TUI. If web is post-v1, defer the framework choice. If shared UI mental model matters, React may reduce surface area. If bundle/event performance matters, prove it later.

### A2A in v1-ish scope

Relevant line: `PLAN.md:449`

A2A v1.0 is real and signed Agent Cards are plausible, but remote agents multiply auth, trust, observability, and network failure modes. Keep A2A as a separate product milestone after local orchestration works.

### "No daemons on day one" versus autonomous/webhook mode

Relevant lines: `PLAN.md:8`, `PLAN.md:451`

That is fine as an evolution, but the plan should explicitly say when the system crosses from CLI process to long-lived service and what operational responsibilities appear then.

## Missing Sections I Would Add

- Threat model and permission model. Define what agents can read/write/execute, how secrets are scoped, how commands are approved, and what gets redacted from logs.
- Canonical event log schema. Include raw event storage, normalized event projections, event IDs, timestamps, run/turn/tool correlation IDs, and schema migration policy.
- Patch lifecycle. Define branch creation, lease acquisition, patch readiness, CI run, review, integration branch merge, conflict handling, rollback, and cleanup.
- Adapter acceptance criteria. For each adapter: spawn, stream, send follow-up, interrupt, resume, tool-call visibility, permission mode, cost usage, failure modes, and contract tests.
- MVP boundary. State what v1 actually ships.

## Recommended v1 Boundary

I would narrow v1 to:

- Bun/TypeScript monorepo
- CLI only
- SQLite append-only event log
- Claude and Codex adapters
- One plan-execute-review flow
- Worktree isolation
- `agent-ci` gate
- Basic watchdog
- Manual issue/task input

Explicitly defer:

- TUI
- Web dashboard
- Extra adapters
- A2A
- Autonomous daemon mode
- Fully automated Linear intake

## Bottom Line

The plan has a good instinct: event log, adapters, worktrees, CI gate, and supervisor control are the right primitives. The part that will bite later is pretending the whole ecosystem can be normalized quickly and safely.

Before scaffolding, rewrite `PLAN.md` around a smaller v1 and add Phase 0 spikes for Bun compatibility, Claude/Codex adapter shape, event schema adequacy, SQLite concurrency, and worktree merge mechanics. That will save you from building a polished harness around the wrong contract.
