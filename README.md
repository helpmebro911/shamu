# Shamu

A multi-agent coding orchestrator that runs heterogeneous coding agents
(Claude, Codex, Cursor, OpenCode, Pi, Kimi, Gemini, Amp, ...) as a swarm with
shared SQLite state, supervisor-driven watchdogs, Linear integration, and
[`@redwoodjs/agent-ci`](https://github.com/redwoodjs/agent-ci) as a first-class
quality gate.

See [PLAN.md](./PLAN.md) for architecture, phased delivery plan, and the
current status of each track.

## Requirements

- [Bun](https://bun.sh) 1.3.11+
- Node.js 22+ (only required to invoke `@redwoodjs/agent-ci` locally)
- Docker (only required by `agent-ci`)

## Quick start

```sh
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun run test
```

Run the full local CI (same pipeline GitHub Actions runs, via `agent-ci`):

```sh
bun run agent-ci
```

## Layout

- `apps/`       — user-facing entry points (CLI, TUI, web dashboard)
- `packages/`   — core, adapters, persistence, supervisor, etc.
- `docs/`       — phase writeups and spikes
- `PLAN.md`     — the living plan; always read before editing a track

## License

MIT — see [LICENSE](./LICENSE).
