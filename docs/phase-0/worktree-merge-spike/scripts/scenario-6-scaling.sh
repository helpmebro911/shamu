#!/usr/bin/env bash
# Scale the cleanup-cost measurement across 1, 5, 10, 25, 50 worktrees to
# characterize the curve. Writes results to logs/scenario-6-scaling.csv.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

CSV="${LOGS_DIR}/scenario-6-scaling.csv"
echo "N,disk_kb_total,create_ms,destroy_ms,avg_create_ms,avg_destroy_ms" > "${CSV}"

for N in 1 5 10 25 50; do
  spike::log "scaling: N=${N}"
  spike::reset_repo
  spike::seed_repo
  ( cd "${TESTREPO}"
    dd if=/dev/urandom of=src/blob.bin bs=1024 count=256 2>/dev/null
    git add src/blob.bin
    git commit -q -m "blob"
  )

  create_start=$(date +%s%N)
  for i in $(seq 1 ${N}); do spike::add_wt "scale-${i}" >/dev/null; done
  create_end=$(date +%s%N)
  create_ms=$(( (create_end - create_start) / 1000000 ))

  wt_kb=$( du -sk "${WORKTREES_DIR}" | awk '{print $1}' )
  admin_kb=$( du -sk "${TESTREPO}/.git/worktrees" 2>/dev/null | awk '{print $1}' )
  admin_kb=${admin_kb:-0}
  total_kb=$(( wt_kb + admin_kb ))

  destroy_start=$(date +%s%N)
  for i in $(seq 1 ${N}); do spike::rm_wt "scale-${i}"; done
  destroy_end=$(date +%s%N)
  destroy_ms=$(( (destroy_end - destroy_start) / 1000000 ))

  avg_c=$(( create_ms / N ))
  avg_d=$(( destroy_ms / N ))
  echo "${N},${total_kb},${create_ms},${destroy_ms},${avg_c},${avg_d}" >> "${CSV}"
  spike::log "N=${N}: total=${total_kb} KiB create=${create_ms} ms (${avg_c}/wt) destroy=${destroy_ms} ms (${avg_d}/wt)"
done

spike::log "wrote scaling csv: ${CSV}"
cat "${CSV}"
