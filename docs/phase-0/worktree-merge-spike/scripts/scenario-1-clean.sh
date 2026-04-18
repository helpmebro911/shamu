#!/usr/bin/env bash
# Scenario 1 — clean concurrent edits.
# A edits src/foo.ts, B edits src/bar.ts. Both merge to integration. No conflict.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

spike::log "=== scenario 1: clean concurrent edits ==="
spike::reset_repo
spike::seed_repo
spike::ensure_integration_branch "s1"

WT_A=$(spike::add_wt "s1-A")
WT_B=$(spike::add_wt "s1-B")

# A touches foo.ts comment header only.
( cd "${WT_A}" && sed -i.bak '1s/.*/\/\/ foo.ts — touched by worker A/' src/foo.ts && rm -f src/foo.ts.bak )
spike::commit_in_wt "s1-A" "A: update foo.ts header"

# B touches bar.ts comment header.
( cd "${WT_B}" && sed -i.bak '1s/.*/\/\/ bar.ts — touched by worker B/' src/bar.ts && rm -f src/bar.ts.bak )
spike::commit_in_wt "s1-B" "B: update bar.ts header"

if spike::merge_to_integration "s1-A" "s1"; then
  spike::log "merge A: clean"
else
  spike::log "merge A: UNEXPECTED conflict"; exit 1
fi

if spike::merge_to_integration "s1-B" "s1"; then
  spike::log "merge B: clean"
else
  spike::log "merge B: UNEXPECTED conflict"; exit 1
fi

# Assert integration contains both changes.
( cd "${TESTREPO}"
  git checkout -q "shamu/integration/s1"
  head -1 src/foo.ts | grep -q "worker A" || { spike::log "FAIL: integration lacks A change"; exit 1; }
  head -1 src/bar.ts | grep -q "worker B" || { spike::log "FAIL: integration lacks B change"; exit 1; }
)
spike::log "scenario 1: PASS"
