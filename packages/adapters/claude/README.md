# @shamu/adapter-claude

Production `AgentAdapter` wrapping `@anthropic-ai/claude-agent-sdk@0.2.113`.

## What it does

- Wraps `query()` (one-shot runs) and `unstable_v2_createSession` + `unstable_v2_prompt` (warm resume). Phase 0.A confirmed `ClaudeSDKClient` is NOT exported in SDK 0.2.113 — this adapter does not depend on it.
- Projects Claude's `SDKMessage` stream into Shamu's normalized `AgentEvent` taxonomy. The projector is ported from the Phase 0.B spike (`docs/phase-0/event-schema-spike/src/project.ts`) and hardened for the final shared schema.
- Bridges `PreToolUse` / `PostToolUse` / `Stop` / `SessionStart` hooks through a pure-function module (`src/hooks.ts`) so unit tests drive projections without instantiating the SDK.
- Routes every `canUseTool` decision through the base `PathScope` (G4) and `ShellGate` (G5). Path-scope violations and shell AST escapes (`$()`, backticks, `eval`, pipes-to-shell, process substitution) are denied BEFORE the tool runs.
- Applies the shared `Redactor` to every string payload (G1) so planted secrets never reach the event log.
- Accepts an in-process MCP server via `vendorOpts.mcpServer`; the server's fingerprint contributes to the cache key so swapping MCP tools invalidates the prefix.
- Composes a prompt-cache salt that includes the orchestrator-owned `runId` (T9) — two runs with different system prompts cannot share a cache hit.

## runId contract

`runId` is orchestrator-owned (G8). Every `spawn()` and `resume()` call MUST receive a `SpawnOpts.runId`; the adapter consumes it and the returned `AgentHandle.runId` equals it exactly. The shamu CLI refuses to continue on mismatch. This adapter never mints a runId internally.

## Cache-key invariant (T9)

The cache key is composed by `src/cache-key.ts`:

```ts
composeCacheKey({
  runId,              // from SpawnOpts
  systemPromptHash,   // sha256(vendorOpts.systemPrompt ?? "")
  mcpServerHash,      // sha256 of MCP server name + tool-list (if provided)
  model,              // current model id
});
```

The resulting salt is threaded through the Claude subprocess as `SHAMU_CACHE_SALT` env var (default) or as a trailing `<!-- shamu-cache-salt:... -->` marker in the system prompt (`vendorOpts.cacheSaltStrategy: "prompt"`). Either strategy ensures two spawns with different system prompts do not share a prompt-cache hit — contract-tested in `test/unit/cache-key.test.ts`.

## Capabilities (frozen manifest, G8)

`src/capabilities.json` is loaded once at module load time and frozen:

| field            | value                                                   |
| ---------------- | ------------------------------------------------------- |
| resume           | `true`                                                  |
| fork             | `false`                                                 |
| interrupt        | `cooperative`                                           |
| permissionModes  | `["default", "acceptEdits", "plan", "bypassPermissions"]` |
| mcp              | `in-process`                                            |
| customTools      | `true`                                                  |
| patchVisibility  | `events`                                                |
| usageReporting   | `per-turn`                                              |
| costReporting    | `native`                                                |
| sandboxing       | `process`                                               |
| streaming        | `events`                                                |

These are derived from Phase 0.B observations and verified against the SDK's actual behavior.

## Contract-suite pass count

13 scenarios, all pass with the scripted SDK double:

- spawn-basic, resume-warm, multi-turn
- interrupt, set-model, set-permission-mode, shutdown
- tool-call-visibility, patch-metadata, usage-and-cost, error-surfaces
- stress-no-leaks, secret-redaction

`patch-metadata` emits a `[contract:WARN]` banner because the scripted driver does not synthesize a `patch_applied` event — the scenario is permissive and passes.

## Stress override

`STRESS_ITERATIONS=100 bun run test` upsizes the `stress-no-leaks` scenario from 10 cycles to 100. The contract suite picks up the env var automatically; this adapter does not override it.

## Live-mode tests

Gated by `SHAMU_CLAUDE_LIVE=1`. Default test runs never touch a vendor subprocess.

```bash
SHAMU_CLAUDE_LIVE=1 \
SHAMU_CLAUDE_CLI=/absolute/path/to/claude \
bun run --cwd packages/adapters/claude test
```

The live tests require a pre-authenticated `claude` CLI. Its path is passed to `spawn()` via `SpawnOpts.vendorCliPath` (which Claude's SDK treats as `pathToClaudeCodeExecutable`). No env-var auth is needed; the CLI's on-disk credentials are used.

`vendorCliPath` is the canonical deploy contract per Phase 0.B — never an `ANTHROPIC_API_KEY` env var.

## Subpath exports

- `.` — `ClaudeAdapter`, `CLAUDE_CAPABILITIES`, cache-key helpers, types.
- `./capabilities.json` — raw manifest JSON for downstream tooling.
