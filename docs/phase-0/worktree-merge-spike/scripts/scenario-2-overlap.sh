#!/usr/bin/env bash
# Scenario 2 — overlapping edits to the same lines. A merges first, B conflicts.
# Proves conflict is detected by `git merge --no-commit` exit code.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

spike::log "=== scenario 2: overlapping edits, same lines ==="
spike::reset_repo
spike::seed_repo
spike::ensure_integration_branch "s2"

WT_A=$(spike::add_wt "s2-A")
WT_B=$(spike::add_wt "s2-B")

# Both touch foo.ts lines 10–15. Replace each line with worker-specific text.
for i in 10 11 12 13 14 15; do
  ( cd "${WT_A}" && sed -i.bak "${i}s|.*|// A rewrote line ${i}|" src/foo.ts && rm -f src/foo.ts.bak )
done
spike::commit_in_wt "s2-A" "A: rewrite foo.ts lines 10-15"

for i in 10 11 12 13 14 15; do
  ( cd "${WT_B}" && sed -i.bak "${i}s|.*|// B rewrote line ${i}|" src/foo.ts && rm -f src/foo.ts.bak )
done
spike::commit_in_wt "s2-B" "B: rewrite foo.ts lines 10-15"

# Merge A — must succeed.
if spike::merge_to_integration "s2-A" "s2"; then
  spike::log "merge A: clean (expected)"
else
  spike::log "merge A: UNEXPECTED conflict"; exit 1
fi

# Merge B — must fail. Capture the exit code.
set +e
spike::merge_to_integration "s2-B" "s2"
rc=$?
set -e
if [ "${rc}" -ne 0 ]; then
  spike::log "merge B: conflict detected by exit code (rc=${rc}) — expected"
else
  spike::log "merge B: UNEXPECTED clean merge"; exit 1
fi

# Collect evidence: which files does git flag as conflicted?
conflicted=$( cd "${TESTREPO}" && git diff --name-only --diff-filter=U )
spike::log "conflicted files: ${conflicted}"
spike::abort_merge

# Also verify that git status reports the right state during the conflict.
# We redo the merge and leave it in place briefly to capture `git status --porcelain`.
set +e
spike::merge_to_integration "s2-B" "s2"
set -e
status_out=$( cd "${TESTREPO}" && git status --porcelain )
spike::log "git status --porcelain during conflict: ${status_out}"
spike::abort_merge

spike::log "scenario 2: PASS (conflict detected deterministically via exit code)"
