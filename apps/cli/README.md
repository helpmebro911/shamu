# @shamu/cli

The Shamu command-line shell. Headless, scriptable, CI-friendly.

Phase 1.D ships the surface only: every command parses its args, loads config,
emits well-shaped output, and returns a meaningful exit code. Wiring to the
supervisor, persistence, and vendor adapters lands in later phases.

See [PLAN.md § UI plan → Surface 1 — CLI](../../PLAN.md) for the full spec.

## Install and run

From the repo root:

```
bun --cwd apps/cli src/index.ts <command> [args]
```

Or after `bun run build`:

```
node apps/cli/dist/index.js <command> [args]
```

The installed `shamu` bin points at `./dist/index.js`.

## Commands

Every command accepts the common flags:

| flag              | description                                                               |
| ----------------- | ------------------------------------------------------------------------- |
| `--json`          | Emit newline-delimited JSON to stdout instead of human text.              |
| `--config <path>` | Path to a `shamu.config.ts`. Defaults to auto-discovery from `cwd`.       |
| `--log-level`     | Logger minimum level: `debug` \| `info` \| `warn` \| `error` (default: `info`). |

Commands that tail a stream (`status`, `logs`) accept `--watch` (or `-f` for
`logs --tail`) and optional interval flags.

| command                         | purpose                                                   | phase that wires it |
| ------------------------------- | --------------------------------------------------------- | ------------------- |
| `shamu run --adapter echo --task "..."` | Start a new agent run (Phase 1.E: `echo` only; `claude`/`codex` land in Phase 2). | Phase 1.E (live for `echo`) |
| `shamu resume <run-id>`         | Warm-resume a previously-started run.                     | Phase 2.C           |
| `shamu status [--watch]`        | Show active and recent runs.                              | Phase 1.E (live)    |
| `shamu logs <run-id> [--tail]`  | Print / follow the event log for a run.                   | Phase 1.E (live)    |
| `shamu kill <run-id>`           | Signal a running agent to shut down.                      | Phase 3             |
| `shamu attach <run-id>`         | Attach to a running agent.                                | Phase 3             |
| `shamu doctor`                  | Environment + toolchain health check.                     | Phase 1.D (live)    |
| `shamu ui`                      | Open the local web dashboard.                             | Phase 7             |
| `shamu flow run <name> --task`  | Start a flow by name.                                     | Phase 4             |
| `shamu flow status <flow-id>`   | Show status of a running flow.                            | Phase 4             |
| `shamu linear tunnel`           | Provision a cloudflared tunnel restricted to `/webhooks/linear` only. | Phase 6 |

## Exit-code taxonomy

| name                    | code | meaning                                                     |
| ----------------------- | ---- | ----------------------------------------------------------- |
| `OK`                    | 0    | Command completed successfully.                             |
| `USER_CANCEL`           | 1    | Ctrl-C or an explicit cancel (including `--watch` SIGINT).  |
| `USAGE`                 | 2    | Invalid args, missing command, malformed CLI input.         |
| `CONFIG_ERROR`          | 3    | Config file invalid or unresolvable.                        |
| `CREDENTIALS_ERROR`     | 4    | Keychain unreachable or missing auth.                       |
| `RUN_FAILED`            | 10   | Agent run ended red (agent-ci failed, reviewer blocked).    |
| `SUPERVISOR_ESCALATION` | 11   | Watchdog trip, stale-lease escalation, OTP max-intensity.   |
| `CI_RED`                | 12   | agent-ci produced a red result for this run.                |
| `INTERRUPTED`           | 13   | SIGINT/SIGTERM received during a run.                       |
| `INTERNAL`              | 20   | Unhandled error, or a command that's not wired yet.         |

Unhandled async errors map to `INTERNAL` with the message (and stack) on
stderr. Commands never call `process.exit` directly — they return an exit code
and the entry point calls `process.exit` exactly once.

## Examples

```sh
# Toolchain health check
shamu doctor
shamu doctor --json | jq 'select(.status == "fail")'

# List runs (reads the SQLite `runs` + `events` tables)
shamu status
shamu status --json

# Dry-run a run invocation to validate args without spawning anything
shamu run --task "fix the memoization bug" --adapter echo --dry-run

# Round-trip a scripted echo session end-to-end (Phase 1.E smoke)
shamu run --adapter echo --task "hello"
shamu run --adapter echo --task "hello" --json

# Follow a run's event log — polls the SQLite `events` table every 500ms
shamu logs my-run-id --tail

# Tunnel webhook delivery through cloudflared (restricted to /webhooks/linear)
shamu linear tunnel --webhook-port 7010
```

## Config file

Create `./shamu.config.ts` (or `.js`, `.mjs`) at the repo root:

```ts
import type { ShamuConfig } from "@shamu/cli/config";

const config: ShamuConfig = {
  swarm: { name: "alpha" },
  paths: { state: ".shamu" },
};

export default config;
```

If no file is present, defaults are used. Parse or validation errors exit
`CONFIG_ERROR`.

## Output modes

- **Default** — human text on stdout. ANSI only when `process.stdout.isTTY`.
- **`--json`** — newline-delimited JSON objects on stdout; stderr carries
  diagnostics (structured JSONL from the logger; human strings from error
  messages). Every logical event is one JSON object per line.
- **`--watch` / `--tail`** — polling placeholder that re-renders on interval.
  SQLite-trigger-driven updates land in Phase 2+.

## Limitations in 1.E

- `shamu run --adapter echo` is the only wired adapter; `claude` and
  `codex` land in Phase 2.
- No supervisor — `shamu kill` / `attach` exit `INTERNAL` with a clear
  "lands in Phase 3" message; the `run` command drives the adapter
  directly without OTP-style supervision until then.
- Redactor in `src/output.ts` is a pass-through with a `TODO(1.B)` marker
  (the adapter's own emission goes through `@shamu/shared/redactor`
  already, so on-stream events are scrubbed; the output redact layer is a
  belt-and-braces pass for future CLI-side decoration).

See `PLAN.md` for the full phase map.
