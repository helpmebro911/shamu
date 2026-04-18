#!/usr/bin/env bash
# Scenario 5 — stale-lease reclaim safety.
# Worker A "acquires" a lease on src/foo.ts, edits it, never commits, dies.
# Worker B wants the lease after TTL. We use `git status --porcelain` in A's
# worktree to detect uncommitted changes under the glob — reclaim must be
# refused and promoted to an escalation artifact.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

spike::log "=== scenario 5: stale-lease reclaim ==="
spike::reset_repo
spike::seed_repo

WT_A=$(spike::add_wt "s5-A")
# A edits foo.ts but does not commit.
( cd "${WT_A}" && sed -i.bak '1s|.*|// A was here but never committed|' src/foo.ts && rm -f src/foo.ts.bak )

# Simulate worker A dying — no process to kill in a shell spike; we just move on.
# Worker B comes along after lease TTL elapsed and asks to reclaim.

glob="src/foo.ts"

# "Last touch" check: any tracked-but-modified or untracked files under glob.
# --porcelain format: "XY path". We accept any non-blank status.
touched=$( cd "${WT_A}" && git status --porcelain -- "${glob}" )
if [ -n "${touched}" ]; then
  spike::log "stale-lease reclaim REFUSED. git status reports: ${touched}"
  cat > "${LOGS_DIR}/scenario-5-escalation.json" <<EOF
{
  "kind": "EscalationRaised",
  "reason": "stale_lease_with_uncommitted_changes",
  "lease": {
    "holder": "worker-s5-A",
    "glob": "${glob}",
    "worktree": "${WT_A}"
  },
  "evidence": {
    "git_status": "$(echo "${touched}" | sed 's/"/\\"/g' | tr '\n' ';' )"
  },
  "suggested_action": "human_triage"
}
EOF
  spike::log "wrote escalation artifact: ${LOGS_DIR}/scenario-5-escalation.json"
else
  spike::log "UNEXPECTED: worktree is clean"; exit 1
fi

# Negative control: once the dirty changes are resolved (e.g. committed or
# stashed), reclaim can proceed.
( cd "${WT_A}" && git add -A && git stash -q )
touched=$( cd "${WT_A}" && git status --porcelain -- "${glob}" )
if [ -z "${touched}" ]; then
  spike::log "after stash: glob clean — reclaim would be safe"
else
  spike::log "after stash: worktree still reports ${touched}"; exit 1
fi

spike::log "scenario 5: PASS (dirty glob blocks reclaim; clean glob allows it)"
