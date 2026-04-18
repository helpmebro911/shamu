# `@shamu/adapters-base`

The adapter contract, shared primitives, and cross-vendor contract-test
suite that every Shamu vendor adapter (Claude, Codex, OpenCode, Pi, Cursor,
Gemini, Amp, Kimi) implements against.

No vendor logic lives here — this package is the seam between Shamu's core
and the adapter fan-out. Concrete adapters import `@shamu/adapters-base` and
compose its helpers; the shared contract suite is what CI runs against every
adapter on every PR.

## Public surface

| Module                                 | Purpose                                                        |
| -------------------------------------- | -------------------------------------------------------------- |
| `adapter.ts`                           | `AgentAdapter` / `AgentHandle` / `SpawnOpts` / `UserTurn`      |
| `capabilities.ts`                      | Re-exports `loadCapabilities` + `assertCapability`             |
| `events.ts`                            | Re-exports `AgentEvent` + ordering-invariant checker           |
| `subprocess.ts`                        | `spawnVendorSubprocess` (detached, Node-drain backpressure)    |
| `path-scope.ts`                        | `validatePathInWorktree` (G4 enforcement)                      |
| `shell-gate.ts`                        | `validateShellCommand` (G5 AST-based gate)                     |
| `tool-result.ts`                       | `summarizeToolResult` (deterministic truncation)               |
| `correlation.ts`                       | `CorrelationState` (envelope + turn/tool-call threading)       |
| `replay.ts`                            | `recordAdapter` / `replayFromJsonl` / JSONL line splitter      |
| `errors.ts`                            | `AdapterError` taxonomy extending `ShamuError`                 |
| `contract/` (via `/contract` subpath)  | `runAdapterContractSuite` + 13 scenarios + fixtures            |

## Contract suite

Downstream Vitest suites plug in an `AdapterUnderTest`:

```ts
import { runAdapterContractSuite } from "@shamu/adapters-base/contract";
import { MyAdapter } from "../src/index.ts";

const adapter = new MyAdapter();

runAdapterContractSuite({
  adapter,
  vendor: adapter.vendor,
  capabilities: adapter.capabilities,
  factory: async (ctx) => adapter.spawn(ctx.spawnOpts),
  teardown: async (handle) => handle.shutdown("contract-teardown"),
  worktreeFor: async (name) => mkThrowawayWorktree(name),
});
```

Scenarios that require a capability the adapter declared unsupported are
**SKIPPED with a loud warning log**. Silent skips would let a capability
regression sneak through CI, so every skip prints the reason.

## Known limitations / follow-ups

- **`reasoning` and `rate_limit` event kinds are NOT in `@shamu/shared/events`
  yet** even though PLAN.md § 1 and `docs/phase-0/event-schema.md` added them.
  Phase 1.B landed before those additions were picked up. Once the shared
  schema catches up, the contract suite should grow a scenario asserting at
  least one adapter surfaces each kind. For now, an adapter that emits
  `reasoning` events will fail Zod validation — don't emit them until 1.B
  updates the shared schema.

- **The stress scenario runs 10 iterations by default**, tunable via
  `STRESS_ITERATIONS=100`. The real acceptance-table row says 100; downstream
  adapter CI sets the env var to keep the default run inside Vitest's
  default timeout without starving local dev.

- **Real Bun-subprocess integration** is not exercised under Vitest (which
  runs in a Node VM). The unit tests for `spawnVendorSubprocess` verify its
  guard rails; the actual spawn-and-read loop is covered via
  `createVirtualHandle` in the contract suite and will get live coverage in
  Phase 2's vendor-adapter suites.

- **`tool-call-visibility` and `patch-metadata` scenarios warn-skip when the
  adapter's stream lacks the expected events** (rather than failing hard)
  because prompt-induced tool calls aren't 100% reliable. Adapters whose
  behavior makes the prompt deterministic should tighten their own suites.

## Design notes worth preserving

- **Path-scope does a two-pass resolution.** First lexical (for clear
  `absolute_outside_worktree` vs `parent_traversal_escapes_worktree` error
  reasons), then realpath-of-deepest-existing-ancestor (to catch symlink
  escapes even when the final path doesn't exist yet — writes create missing
  parents inside the worktree without being over-blocked).

- **The shell-gate splits on top-level `;`/`&&`/`||`/`|` then walks each
  pipeline stage.** Pipe-to-shell detection triggers only on stages *after*
  the first (`curl x | bash` is rejected; `bash -c "..."` is rejected via
  the `-c` heuristic). This is defense against the `curl … | bash` exfil
  primitive while still letting `grep … | head` through.

- **`summarizeToolResult` defaults to 1000 chars** (up from the 0.B spike's
  500) because the reviewer-excerpt budget is separate, and the watchdog's
  `tool_loop` signal benefits from richer summaries. JSON-aware truncation
  is best-effort: we cut at a balanced boundary within the last 50% of the
  window, falling back to a char-cut when no boundary is nearby.

- **`CorrelationState` is the single place envelopes are assembled.**
  Adapters that invent their own envelope composition risk drifting from
  the contract (wrong seq monotonicity, missing parentEventId linkage).
  Always route through a `CorrelationState` instance per run.

- **Subprocess helper wraps `Bun.spawn`.** Phase 0.A (bun-compat) showed
  Node-style `drain` backpressure is required for every vendor CLI (they're
  all Node processes under the hood); fire-and-forget writes hang Claude
  under load. `spawnVendorSubprocess.write(chunk)` awaits the drain promise
  transparently.

- **`detached: true` + `process.kill(-pgid)` is the reap path (T13).** Not
  a no-op: the vendor CLI may spawn grandchildren (rg, git, xargs) that
  outlive the parent without pgid-based reaping.
