# scripts/

Dev-laptop tooling. These are helpers run by humans (or by the shamu
supervisor in its own workspace); they are not part of the orchestrator
runtime. Shamu itself is dev-laptop-only per PLAN.md — it never runs
inside GitHub Actions — and the same applies to anything in this
directory.

## `agent-ci.ts`

Shims `@redwoodjs/agent-ci` so it boots with `GITHUB_REPO` set (the
dependency crashes otherwise). Invoked via the root package alias
`bun run agent-ci`, which maps to `bun scripts/agent-ci.ts`.

See the script header for flag forwarding details.

## `setup-branch-protection.sh`

Bootstraps GitHub branch protection for this repo. Shamu's quality gate
(PLAN.md Phase 5.C) requires the `CI / ubuntu-latest` status check,
signed commits, and linear history on `main`; the integration branches
created by the orchestrator (`shamu/integration/*`) need the same
guarantees.

Branch protection lives outside the git tree — the GitHub API is the
only way to apply it — so this script is the delivery vehicle.

### Preconditions

- `gh` CLI installed and on `PATH` (<https://cli.github.com/>).
- `gh auth status` is green.
- The authenticated user has **Admin** access to the target repo.
  Rulesets and branch-protection endpoints both require it.

### Usage

```sh
# Auto-detect owner/repo from `git remote get-url origin`
scripts/setup-branch-protection.sh

# Explicit repo
scripts/setup-branch-protection.sh watzon/shamu

# Or via env
GITHUB_REPO=watzon/shamu scripts/setup-branch-protection.sh

# Dry-run: prints the gh api calls without executing them
scripts/setup-branch-protection.sh --dry-run
```

### What gets applied

Two rulesets (modern API, pattern-aware):

- `shamu-main-protection` targeting `refs/heads/main`
- `shamu-integration-protection` targeting `refs/heads/shamu/integration/*`

Each ruleset enforces:

- Required status check: `CI / ubuntu-latest` (strict — branch must be
  up to date with base before merge).
- Required signed commits.
- Required linear history.
- Required pull-request review (1 approval, dismiss stale on push).
- Disallowed force pushes.
- Disallowed deletions.

Plus classic branch protection on `main` (`PUT /repos/{owner}/{repo}/branches/main/protection`)
as a fallback for tools that still read the old endpoint. `required_signatures`
is toggled via its dedicated sub-endpoint because some API versions
reject it inside the classic PUT body.

### Idempotency

Safe to re-run. The script upserts by ruleset name (looks up the
existing ID and PUTs into it); the classic endpoint is PUT semantics.

### Scope

This is dev-laptop tooling. It mutates live GitHub settings — the
watchdog test suite does not exercise it, the orchestrator does not
invoke it, and agent-ci does not run it. One human, one `gh` token,
one execution per repo bootstrap.
