#!/usr/bin/env bash
# Run every scenario in order, fail fast. Writes ordered output to logs/run.log.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
: > "${here}/../logs/run.log"  # truncate
for s in \
  scenario-1-clean.sh \
  scenario-2-overlap.sh \
  scenario-3-disjoint.sh \
  scenario-4-semantic.sh \
  scenario-5-stale-lease.sh \
  scenario-6-cleanup.sh \
; do
  echo ">>> running ${s}"
  bash "${here}/${s}"
done
echo ">>> all scenarios PASS"
