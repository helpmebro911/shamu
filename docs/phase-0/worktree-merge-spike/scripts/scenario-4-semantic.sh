#!/usr/bin/env bash
# Scenario 4 — semantic conflict across different files.
# A renames doThing → doThingV2 in foo.ts.
# B edits bar.ts but keeps calling doThing.
# Both merge cleanly; a stand-in "typecheck" fails on the integration branch.
# Demonstrates: rerun-CI on integration catches it, automatic revert of the
# last-merged patch restores green, CIRed event would fire.
#
# We use a bash-only typecheck stand-in: every `import { X }` from "./foo" must
# have a matching `export function X` or `export const X` in src/foo.ts.
# No tsc, no Node — per the spike constraints.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

fake_typecheck() {
  local root="$1"
  # Collect exported symbols from foo.ts.
  local exports
  exports=$(grep -E '^export (function|const|class|let|var) ' "${root}/src/foo.ts" \
    | sed -E 's/^export (function|const|class|let|var) ([A-Za-z_][A-Za-z0-9_]*).*/\2/' \
    | sort -u)
  # Collect imported symbols from bar.ts that come from "./foo".
  local imports
  imports=$(grep -E 'from "\./foo"' "${root}/src/bar.ts" \
    | sed -E 's/.*\{([^}]+)\}.*/\1/' \
    | tr ',' '\n' \
    | sed -E 's/^ *//;s/ *$//' \
    | grep -v '^$' \
    | sort -u)
  local missing=""
  for sym in ${imports}; do
    if ! printf '%s\n' "${exports}" | grep -qx "${sym}"; then
      missing="${missing} ${sym}"
    fi
  done
  if [ -n "${missing}" ]; then
    echo "typecheck: missing exports from ./foo:${missing}" >&2
    return 1
  fi
  echo "typecheck: ok"
  return 0
}

spike::log "=== scenario 4: semantic conflict across files ==="
spike::reset_repo
spike::seed_repo
spike::ensure_integration_branch "s4"

WT_A=$(spike::add_wt "s4-A")
WT_B=$(spike::add_wt "s4-B")

# A: rename doThing → doThingV2 in foo.ts.
( cd "${WT_A}" && sed -i.bak 's/doThing/doThingV2/g' src/foo.ts && rm -f src/foo.ts.bak )
spike::commit_in_wt "s4-A" "A: rename doThing → doThingV2"

# B: innocuous edit to bar.ts — still imports doThing.
( cd "${WT_B}" && sed -i.bak '1s/.*/\/\/ bar.ts — touched by worker B (uses doThing)/' src/bar.ts && rm -f src/bar.ts.bak )
spike::commit_in_wt "s4-B" "B: annotate bar.ts"

# Merge A.
if spike::merge_to_integration "s4-A" "s4"; then
  spike::log "merge A: clean"
else
  spike::log "merge A: UNEXPECTED conflict"; exit 1
fi

# Rerun "CI" on integration after A. At this point bar.ts still calls doThing,
# which A removed — should fail.
( cd "${TESTREPO}" && git checkout -q "shamu/integration/s4" )
set +e
fake_typecheck "${TESTREPO}" > "${LOGS_DIR}/scenario-4-after-A.log" 2>&1
rc_after_a=$?
set -e
if [ "${rc_after_a}" -ne 0 ]; then
  spike::log "rerun-CI after A: RED (typecheck failed) — CIRed would fire"
  cat "${LOGS_DIR}/scenario-4-after-A.log" | tee -a "${LOGS_DIR}/run.log"
else
  spike::log "rerun-CI after A: unexpectedly green"; exit 1
fi

# Automatic revert of the last merge. Record the merge commit first.
last_merge=$( cd "${TESTREPO}" && git rev-parse HEAD )
spike::log "auto-reverting merge commit ${last_merge}"
# Note: `git revert` in git ≥2.50 rejects -q; silence via redirection instead.
( cd "${TESTREPO}" && git revert -m 1 --no-edit "${last_merge}" >/dev/null )

# Rerun "CI" — should be green.
set +e
fake_typecheck "${TESTREPO}" > "${LOGS_DIR}/scenario-4-after-revert.log" 2>&1
rc_after_revert=$?
set -e
if [ "${rc_after_revert}" -eq 0 ]; then
  spike::log "post-revert CI: GREEN — tree is buildable again"
else
  spike::log "post-revert CI: still red (unexpected)"; exit 1
fi

# Also demonstrate: merge B after the revert — B is still clean.
if spike::merge_to_integration "s4-B" "s4"; then
  spike::log "merge B after revert: clean"
else
  spike::log "merge B after revert: UNEXPECTED conflict"; exit 1
fi
set +e
fake_typecheck "${TESTREPO}" > /dev/null 2>&1
rc_after_b=$?
set -e
[ "${rc_after_b}" -eq 0 ] && spike::log "CI after B alone: GREEN" || { spike::log "CI after B alone: RED (unexpected)"; exit 1; }

# Emit a synthetic CIRed event shape for the record.
cat > "${LOGS_DIR}/scenario-4-CIRed.json" <<EOF
{
  "kind": "CIRed",
  "swarm": "s4",
  "integration_branch": "shamu/integration/s4",
  "failing_commit": "${last_merge}",
  "offending_run": "s4-A",
  "reconcile_action": "auto-revert",
  "reviewer_reengage": ["s4-A"]
}
EOF
spike::log "scenario 4: PASS — rerun-CI on integration catches the semantic break and auto-revert restores green"
