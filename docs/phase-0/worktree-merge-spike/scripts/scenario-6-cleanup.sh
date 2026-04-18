#!/usr/bin/env bash
# Scenario 6 — cleanup cost with 10 simultaneous worktrees.
# Measures disk footprint, create wall time, destroy wall time.
# Also asserts that `git worktree prune` reconciles the admin dir if we remove
# a worktree dir out from under git.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

spike::log "=== scenario 6: cleanup cost ==="
spike::reset_repo
spike::seed_repo

N=10

# Add some data so the worktree footprint is non-trivial.
( cd "${TESTREPO}"
  dd if=/dev/urandom of=src/blob.bin bs=1024 count=256 2>/dev/null
  git add src/blob.bin
  git commit -q -m "add 256KiB blob so worktree footprint is measurable"
)

# Measure create.
create_start=$(date +%s%N)
for i in $(seq 1 ${N}); do
  spike::add_wt "s6-${i}" >/dev/null
done
create_end=$(date +%s%N)
create_ms=$(( (create_end - create_start) / 1000000 ))

# Measure disk footprint (worktrees + .git admin growth).
wt_bytes=$( du -sk "${WORKTREES_DIR}" | awk '{print $1}' )
git_bytes=$( du -sk "${TESTREPO}/.git/worktrees" 2>/dev/null | awk '{print $1}' )
git_bytes=${git_bytes:-0}
total_kb=$(( wt_bytes + git_bytes ))

spike::log "${N} worktrees created in ${create_ms} ms"
spike::log "worktree dir: ${wt_bytes} KiB; .git/worktrees admin: ${git_bytes} KiB; total ${total_kb} KiB"

# Measure destroy.
destroy_start=$(date +%s%N)
for i in $(seq 1 ${N}); do
  spike::rm_wt "s6-${i}"
done
destroy_end=$(date +%s%N)
destroy_ms=$(( (destroy_end - destroy_start) / 1000000 ))
spike::log "${N} worktrees destroyed in ${destroy_ms} ms"

# Verify prune leaves nothing stale.
remaining=$( cd "${TESTREPO}" && git worktree list | wc -l | tr -d ' ' )
spike::log "git worktree list count after cleanup: ${remaining} (expect 1 — main)"
if [ "${remaining}" != "1" ]; then
  spike::log "UNEXPECTED: stale worktrees linger after prune"; exit 1
fi

# Separately: test the "worktree dir removed out of band" path.
WT_X=$(spike::add_wt "s6-orphan")
rm -rf "${WT_X}"  # simulate a crash that nuked the dir
# `git worktree list` still shows it until we prune:
stale_before=$( cd "${TESTREPO}" && git worktree list | wc -l | tr -d ' ' )
( cd "${TESTREPO}" && git worktree prune >/dev/null )
stale_after=$( cd "${TESTREPO}" && git worktree list | wc -l | tr -d ' ' )
spike::log "orphan worktree — list before prune: ${stale_before}; after prune: ${stale_after}"
if [ "${stale_after}" != "1" ]; then
  spike::log "UNEXPECTED: prune did not clean the orphan"; exit 1
fi

# Write a machine-readable summary for the deliverable table.
cat > "${LOGS_DIR}/scenario-6-summary.json" <<EOF
{
  "worktrees": ${N},
  "disk_kb_worktrees": ${wt_bytes},
  "disk_kb_git_admin": ${git_bytes},
  "disk_kb_total": ${total_kb},
  "create_ms": ${create_ms},
  "destroy_ms": ${destroy_ms},
  "prune_cleans_orphan": true
}
EOF
spike::log "scenario 6: PASS"
