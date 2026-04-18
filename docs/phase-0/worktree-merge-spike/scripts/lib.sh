#!/usr/bin/env bash
# Shared helpers for the worktree-merge spike scenarios.
# Usage: source lib.sh
#
# Exposes:
#   SPIKE_ROOT        — absolute path to the spike directory
#   TESTREPO          — absolute path to the scratch repo
#   WORKTREES_DIR     — absolute path to the directory holding worktrees
#   LOGS_DIR          — absolute path to the logs directory
#   spike::reset_repo — destroy and recreate the scratch repo
#   spike::seed_repo  — seed with src/foo.ts + src/bar.ts and an initial commit
#   spike::add_wt     — create a worktree at a specific branch off main
#   spike::rm_wt      — remove a worktree and prune
#   spike::log        — append a line to $LOGS_DIR/run.log and echo it

set -euo pipefail

# Resolve spike root regardless of caller cwd.
SPIKE_ROOT="$( cd "$( dirname "${BASH_SOURCE[0]}" )/.." && pwd )"
TESTREPO="${SPIKE_ROOT}/testrepo"
WORKTREES_DIR="${SPIKE_ROOT}/worktrees"
LOGS_DIR="${SPIKE_ROOT}/logs"

mkdir -p "${LOGS_DIR}"

spike::log() {
  local msg="$*"
  local ts
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '[%s] %s\n' "${ts}" "${msg}" | tee -a "${LOGS_DIR}/run.log"
}

spike::reset_repo() {
  rm -rf "${TESTREPO}" "${WORKTREES_DIR}"
  mkdir -p "${TESTREPO}" "${WORKTREES_DIR}"
  (
    cd "${TESTREPO}"
    git init -q -b main
    git config user.email "spike@shamu.local"
    git config user.name "shamu spike"
    git config commit.gpgsign false
    git config tag.gpgsign false
  )
}

spike::seed_repo() {
  mkdir -p "${TESTREPO}/src"
  # foo.ts — 60 numbered lines so scenarios can target distinct ranges.
  {
    echo "// foo.ts — spike fixture"
    for i in $(seq 2 60); do
      echo "export const foo_${i} = ${i};"
    done
  } > "${TESTREPO}/src/foo.ts"
  # bar.ts — references doThing so we can manufacture a semantic conflict.
  cat > "${TESTREPO}/src/bar.ts" <<'EOF'
// bar.ts — spike fixture; calls doThing from foo.
import { doThing } from "./foo";

export function useBar() {
  return doThing("bar-input");
}
EOF
  # foo.ts exports doThing at a known line so renames are easy to write.
  cat >> "${TESTREPO}/src/foo.ts" <<'EOF'

export function doThing(input: string): string {
  return `did:${input}`;
}
EOF
  (
    cd "${TESTREPO}"
    git add -A
    git commit -q -m "seed: foo.ts + bar.ts fixtures"
  )
}

# spike::add_wt <run-id> — creates worktree at $WORKTREES_DIR/<run-id>
# on branch shamu/run-<run-id> off current main.
spike::add_wt() {
  local run_id="$1"
  local branch="shamu/run-${run_id}"
  local wt="${WORKTREES_DIR}/${run_id}"
  (
    cd "${TESTREPO}"
    git worktree add -q -b "${branch}" "${wt}" main
  )
  printf '%s' "${wt}"
}

spike::rm_wt() {
  local run_id="$1"
  local wt="${WORKTREES_DIR}/${run_id}"
  (
    cd "${TESTREPO}"
    # --force because dirty worktrees (scenario 5) need to be removable.
    git worktree remove -f "${wt}" 2>/dev/null || true
    git worktree prune >/dev/null
  )
  rm -rf "${wt}"
}

# Start/ensure an integration branch rooted at main.
spike::ensure_integration_branch() {
  local swarm="$1"
  (
    cd "${TESTREPO}"
    if git show-ref --verify --quiet "refs/heads/shamu/integration/${swarm}"; then
      git checkout -q "shamu/integration/${swarm}"
      git checkout -q main
    else
      git branch -q "shamu/integration/${swarm}" main
    fi
  )
}

# Commit staged changes in a worktree with a deterministic author.
spike::commit_in_wt() {
  local run_id="$1"
  local msg="$2"
  local wt="${WORKTREES_DIR}/${run_id}"
  (
    cd "${wt}"
    git config user.email "worker-${run_id}@shamu.local"
    git config user.name "worker-${run_id}"
    git add -A
    git commit -q -m "${msg}"
  )
}

# Merge a run branch into an integration branch without fast-forward.
# Returns 0 on clean merge, 1 on conflict.
spike::merge_to_integration() {
  local run_id="$1"
  local swarm="$2"
  local branch="shamu/run-${run_id}"
  local integ="shamu/integration/${swarm}"
  (
    cd "${TESTREPO}"
    git checkout -q "${integ}"
    # --no-commit + --no-ff so we can detect conflict via exit code
    # and keep control of the merge commit.
    if git merge --no-ff --no-commit "${branch}" >/dev/null 2>&1; then
      git commit -q -m "merge ${branch} into ${integ}"
      return 0
    else
      return 1
    fi
  )
}

# Abort an in-progress merge if any.
spike::abort_merge() {
  (
    cd "${TESTREPO}"
    git merge --abort 2>/dev/null || true
  )
}
