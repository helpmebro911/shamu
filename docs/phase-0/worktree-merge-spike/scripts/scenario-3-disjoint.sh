#!/usr/bin/env bash
# Scenario 3 — non-overlapping edits, same file.
# A edits foo.ts lines 1–5, B edits foo.ts lines 50–55. Both merge cleanly.
# Compute a diff-overlap signal: files touched by >= 2 patches → flagged.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

spike::log "=== scenario 3: non-overlapping edits, same file ==="
spike::reset_repo
spike::seed_repo
spike::ensure_integration_branch "s3"

WT_A=$(spike::add_wt "s3-A")
WT_B=$(spike::add_wt "s3-B")

# A: lines 1–5.
for i in 1 2 3 4 5; do
  ( cd "${WT_A}" && sed -i.bak "${i}s|.*|// A top-of-file line ${i}|" src/foo.ts && rm -f src/foo.ts.bak )
done
spike::commit_in_wt "s3-A" "A: rewrite foo.ts lines 1-5"

# B: lines 50–55.
for i in 50 51 52 53 54 55; do
  ( cd "${WT_B}" && sed -i.bak "${i}s|.*|// B mid-file line ${i}|" src/foo.ts && rm -f src/foo.ts.bak )
done
spike::commit_in_wt "s3-B" "B: rewrite foo.ts lines 50-55"

if spike::merge_to_integration "s3-A" "s3"; then
  spike::log "merge A: clean"
else
  spike::log "merge A: UNEXPECTED conflict"; exit 1
fi

if spike::merge_to_integration "s3-B" "s3"; then
  spike::log "merge B: clean (git considers disjoint line ranges fine)"
else
  spike::log "merge B: UNEXPECTED conflict"; exit 1
fi

# --- diff-overlap check implementation demo ---
# For every run branch merged into integration, compute the set of files
# changed vs main. If any file appears in ≥ 2 sets, flag for reconcile.
declare -A touch_count
flagged=""
for run in s3-A s3-B; do
  files=$( cd "${TESTREPO}" && git diff --name-only main "shamu/run-${run}" )
  spike::log "patch ${run} touched: $(echo ${files} | tr '\n' ' ')"
  for f in ${files}; do
    touch_count[${f}]=$(( ${touch_count[${f}]:-0} + 1 ))
  done
done

for f in "${!touch_count[@]}"; do
  if [ "${touch_count[${f}]}" -ge 2 ]; then
    flagged="${flagged} ${f}"
  fi
done

if [ -n "${flagged}" ]; then
  spike::log "diff-overlap check FLAGGED files: ${flagged} — would fan out to reconcile node"
else
  spike::log "diff-overlap check: no shared files (unexpected)"; exit 1
fi

spike::log "scenario 3: PASS (clean git merge + diff-overlap signal flags shared file)"
