# Phase 0.C — Worktree merge mechanics

## Summary

**Go** — the git-worktree + integration-branch reconcile design holds up under
manufactured conflict scenarios, provided the flow engine adds two post-merge
checks the current plan under-specifies: a **file-level diff-overlap check**
(for semantic-risk patches git happily merges) and a **stale-lease last-touch
check** backed by `git status --porcelain`. Cleanup cost is a non-issue at
Phase 3 target scale (≤ 10 concurrent worktrees).

All six scenarios are reproducible from scratch via
`docs/phase-0/worktree-merge-spike/scripts/run-all.sh`. The scratch repo and
worktrees are gitignored; only the scripts and this writeup are tracked.

Environment: macOS 15.x, `git version 2.50.1 (Apple Git-155)`.

---

## Scenario 1 — Clean concurrent edits

**What I did.** Worktree A edits `src/foo.ts` (header comment). Worktree B
edits `src/bar.ts` (header comment). Both commit to
`shamu/run-<id>` branches; both merge `--no-ff` into
`shamu/integration/s1`.

**What happened.** Both merges succeed without conflict. Integration branch
contains both changes. Exit codes from `git merge --no-commit` are 0 for both.

**What it proves.** The happy-path topology (worktree → run-branch →
integration-branch via non-ff merge commits) works and preserves ancestry
cleanly. This is the baseline for the harder scenarios.

Evidence: `logs/run.log` block beginning `=== scenario 1`.

---

## Scenario 2 — Overlapping edits, same lines

**What I did.** Both worktrees rewrote `src/foo.ts` lines 10–15. Merged A into
`shamu/integration/s2` first; then attempted to merge B.

**What happened.**
- Merge A: rc=0, clean.
- Merge B: `git merge --no-ff --no-commit` exited with **rc=1**. No swallowing
  of the signal required — the exit code alone is authoritative.
- `git diff --name-only --diff-filter=U` reported `src/foo.ts` as the sole
  conflicted path.
- `git status --porcelain` during the conflict reported `UU src/foo.ts` (both
  sides modified). We also aborted with `git merge --abort` and re-entered the
  conflict to confirm determinism.

**What it proves.** The flow engine does **not** need to parse stdout or eyeball
messages to detect textual conflicts. A single process-exit check is enough.
It also proves the pre-commit guard cannot rely on "line range" leases alone
for protection — B acquired no overlap with A's edit graph at lease time; git
only noticed at merge time.

Evidence: `logs/run.log` block beginning `=== scenario 2`.

---

## Scenario 3 — Non-overlapping edits, same file

**What I did.** A rewrote `src/foo.ts` lines 1–5; B rewrote `src/foo.ts`
lines 50–55. Both merged to `shamu/integration/s3` cleanly. Then I ran the
proposed **diff-overlap check**:

```
for each run R merged into integration since the last check:
  files(R) := `git diff --name-only <merge-base> <R-tip>`
touch_count := multiset union over all runs
flag       := { f : touch_count[f] >= 2 }
```

**What happened.** Both merges clean (rc=0). `touch_count[src/foo.ts] = 2`.
The flagged set is `{src/foo.ts}` — the check fires a reconcile signal even
though git was silent.

**What it proves.** Line-range merge-ness is not a proxy for semantic safety.
A file edited by two different patches in the same integration cycle is a
legitimate human-review (or reconcile-node) trigger regardless of whether
git needed three-way help. The fix is cheap — one `git diff --name-only` per
merged run — and produces a deterministic flag set.

Evidence: `logs/run.log` block beginning `=== scenario 3`.

---

## Scenario 4 — Semantic conflict, different files

**What I did.** A renamed `doThing` → `doThingV2` in `src/foo.ts`. B annotated
`src/bar.ts` (which still imports `doThing`). Both committed. Both merged to
`shamu/integration/s4` cleanly.

To stand in for `tsc` without pulling Node into the spike, I wrote a shell
"fake typecheck" that (a) extracts exported symbol names from `src/foo.ts`
and (b) verifies every `import { … } from "./foo"` in `src/bar.ts` matches an
export. The same loop runs on the integration branch after each merge.

**What happened.**
- Merge A: clean. Rerun fake-typecheck on integration → **red**:
  `typecheck: missing exports from ./foo: doThing`.
- Auto-revert the merge commit: `git revert -m 1 --no-edit <merge-sha>`
  succeeds and produces a new revert commit. (Note: git 2.50 no longer
  accepts `-q` on `revert`; I suppress output via redirection. Documented in
  `scripts/scenario-4-semantic.sh`.)
- Rerun fake-typecheck on integration → **green**.
- Merge B (bar.ts annotation) on the post-revert tree: clean, stays green.
- Wrote synthetic `CIRed` payload to
  `logs/scenario-4-CIRed.json` showing the shape the domain-event sink would
  receive.

**What it proves.** The rerun-CI-on-integration loop described in the Patch
lifecycle catches semantic conflicts git silently merged. Automatic
`git revert -m 1 <merge-sha>` on the last merge commit is a working
reconcile primitive — it restores buildability without rewriting history and
leaves the offending run branch intact for reviewer re-engagement. A `CIRed`
event firing with `offending_run = <last merged run>` is enough context for
the flow engine to route the affected run back through reviewer.

**One subtlety the plan should call out.** If the semantic break was *already*
latent in the integration branch before the last merge, blind
"revert last merge and declare victory" would hide it. The reconcile node must
check: after revert, does CI *actually* go green? If not, bisect by reverting
the next merge and try again, up to N revert-attempts before quarantining
the whole window.

Evidence: `logs/run.log` block beginning `=== scenario 4`,
`logs/scenario-4-after-A.log`, `logs/scenario-4-after-revert.log`,
`logs/scenario-4-CIRed.json`.

---

## Scenario 5 — Stale-lease reclaim

**What I did.** Worker A in `worktrees/s5-A/` edits `src/foo.ts` and does
*not* commit. Worker B shows up after lease TTL and requests reclaim. Instead
of blindly granting the glob, I run `git status --porcelain -- <glob>` in A's
worktree.

**What happened.**
- Output: ` M src/foo.ts` — status code "M " in the second column means
  tracked-modified-but-not-staged. Any non-empty output from
  `git status --porcelain -- <glob>` is sufficient to refuse reclaim.
- Negative control: `git add -A && git stash` clears the glob; re-running
  the check returns empty output, so reclaim is now safe.
- Wrote `logs/scenario-5-escalation.json` with the shape the
  `EscalationRaised` event should carry: holder, glob, evidence string from
  `git status`, suggested action `human_triage`.

**What it proves.** `git status --porcelain` is a reliable "did anything
under this glob get modified since HEAD" oracle — it covers modified tracked
files, added-but-unstaged paths, untracked files, and ignored-but-present
paths if `--ignored` is requested. No need to maintain a separate "dirty
glob" flag in the lease table; the worktree's git index *is* the source of
truth for last-touch.

**Edge case the plan should document.** The check must run against the
**holder's** worktree, not the reclaimer's. `git status` is worktree-local;
asking the wrong worktree returns "clean" for unrelated paths. The lease
record must therefore store a stable reference to the holder's worktree
path (or to the run id from which the path is derivable).

Evidence: `logs/run.log` block beginning `=== scenario 5`,
`logs/scenario-5-escalation.json`.

---

## Scenario 6 — Cleanup cost

**What I did.** Created N worktrees (for N ∈ {1, 5, 10, 25, 50}) off the
scratch repo, measured disk usage and wall-clock create/destroy time per run
with `date +%s%N`. Added a 256 KiB blob to the repo first so `git checkout`
actually has something to materialize.

### Results

| N worktrees | disk (KiB total) | create (ms) | destroy (ms) | avg create (ms/wt) | avg destroy (ms/wt) |
|---:|---:|---:|---:|---:|---:|
|  1 |    292 |   27 |   23 | 27 | 23 |
|  5 |  1 460 |  118 |  114 | 23 | 22 |
| 10 |  2 920 |  236 |  227 | 23 | 22 |
| 25 |  7 300 |  616 |  587 | 24 | 23 |
| 50 | 14 600 | 1 426 | 1 295 | 28 | 25 |

Raw CSV: `logs/scenario-6-scaling.csv`. Key JSON: `logs/scenario-6-summary.json`.

- Per-worktree footprint ≈ `2 × size_of_worktree_content + small git admin
  overhead`. For shamu-internal scale (256 KiB blob + tiny source), 10
  worktrees cost ≈ 2.9 MiB; 50 worktrees cost ≈ 14 MiB. Negligible.
- Per-worktree create/destroy is ~23 ms on SSD — essentially constant with N
  for the range tested.
- `git worktree prune` cleanly removed the admin entry after I destroyed the
  worktree directory out-of-band (simulating a crash that rm -rf'd the
  worktree but didn't run `git worktree remove`). Before prune, `git worktree
  list` showed the orphan; after prune, only `main` remained.

**What it proves.** Cleanup cost is not a budget risk at Phase 3 scale. The
only operational rule worth writing down is: **always pair a worktree
destruction with `git worktree prune`**; the current `packages/worktree` task
list already does this.

### Gotcha discovered during the spike

- `git revert -q` and `git worktree prune -q` are **both rejected** by git
  2.50 with `error: unknown switch 'q'`. The quiet flag moved or was
  removed. Scripts in this spike suppress output via `>/dev/null` instead.
  Worth pinning in the worktree package: never pass `-q` to `prune` or
  `revert`; redirect output or use `--quiet` where accepted.

---

## Diff-overlap check — spec

Pseudocode for the function the flow engine calls after every merge into
`shamu/integration/<swarm>`.

```ts
/**
 * Flag files touched by ≥ 2 in-flight patches during a single integration
 * window. "In-flight" = merged into the integration branch since the last
 * reconcile cycle began.
 *
 * Returns the set of files to escalate to a reconcile node. An empty set
 * means the integration branch is safe to advance to the human-handoff step.
 */
function diffOverlapCheck(
  repo: GitRepo,
  integrationBranch: string,             // "shamu/integration/<swarm>"
  windowStart: GitSha,                   // tip of integration at last reconcile
  mergedRuns: Array<{ runId: RunId; branch: string }>,
  policy: {
    alwaysFlagGlobs: string[];           // e.g. ["**/*.test.*", "**/tsconfig*.json", "package.json", "**/schema.sql"]
    ignoredGlobs: string[];              // e.g. ["**/*.md"] — human-sourced, noisy
  },
): ReconcileSignal {
  const touchCount = new Map<Path, RunId[]>();

  for (const { runId, branch } of mergedRuns) {
    // Use the run branch's merge base with integration at windowStart so
    // we compare "what this patch introduced" not "what integration drifted."
    const base  = repo.mergeBase(branch, windowStart);
    const files = repo.diffNameOnly(base, branch)
      .filter(f => !matchesAny(f, policy.ignoredGlobs));

    for (const f of files) {
      const bucket = touchCount.get(f) ?? [];
      bucket.push(runId);
      touchCount.set(f, bucket);
    }
  }

  const flagged: FlaggedFile[] = [];
  for (const [file, runs] of touchCount) {
    const hitShared   = runs.length >= 2;
    const hitSentinel = matchesAny(file, policy.alwaysFlagGlobs);
    if (hitShared || hitSentinel) {
      flagged.push({
        file,
        runs,
        reasons: [
          hitShared   ? "multiple_patches_touched" : null,
          hitSentinel ? "sentinel_glob"            : null,
        ].filter(Boolean),
      });
    }
  }

  return {
    kind: flagged.length === 0 ? "clear" : "flagged",
    flagged,
    windowStart,
    mergedRuns: mergedRuns.map(r => r.runId),
  };
}
```

### Signature at a glance

- **Inputs:** the repo handle, the integration branch name, the sha marking
  the start of this integration window, the list of run branches merged in
  this window, and a policy describing always-flag globs (tests, configs,
  build files) and ignored globs (e.g. markdown).
- **Outputs:** either `clear` (safe to advance) or `flagged` with the set of
  files, the runs that touched each, and the reasons (`multiple_patches_touched`
  or `sentinel_glob`). The flow engine maps any non-empty `flagged` set to a
  reconcile-node fan-out; reconcile produces either approve-all, manual-merge,
  or quarantine.

### Edge cases

1. **Renames and `R100` diffs.** `git diff --name-only` reports the rename
   target by default; for rename detection, pass `-M` and consider both
   sides. Practically: if A renames `foo.ts → fooV2.ts` and B still edits
   `foo.ts`, we want the flag on `foo.ts` regardless. Use
   `git diff --name-only --name-status -M` and treat both old and new names
   as touched.
2. **Empty diffs.** A run branch that was merged but touched no files (e.g.
   reviewer-approved doc-only change fully filtered by `ignoredGlobs`) must
   not break the count. An empty file set for a run is fine; it just can't
   contribute to overlaps.
3. **Overlap with base-drift.** If the integration branch advanced because of
   a third patch while this check was computing, the `windowStart` anchor
   means the result is still correct — the check is pure over the sha range
   it was given. The flow engine supplies windowing; this function does not
   chase HEAD.
4. **Sentinel-glob intentional overlaps.** If every patch needs to bump
   `package.json` version the sentinel policy will fire constantly. The flow
   node receiving `flagged` with *only* `sentinel_glob` reason may downgrade
   to a warning if all runs touched only well-known auto-bumped fields
   (detectable by a structured diff on those files). Out of scope for this
   spike but called out in the policy shape.
5. **Vendored directories.** Add `node_modules/**`, `vendor/**`, `.shamu/**`
   to `ignoredGlobs` by default — they aren't real code changes and they
   churn on almost every patch.

### Why this is not sufficient alone

This check is a *warning* signal, not a correctness gate. Git's own merge
already catches textual collisions (scenario 2). The reason the flow engine
still reruns `agent-ci` after each integration merge is that *even file-level
overlap analysis cannot see cross-file semantic conflicts* (scenario 4). The
two checks are complementary:

| Check | Catches | Misses |
|---|---|---|
| `git merge --no-commit` exit code | textual line conflicts | everything else |
| Diff-overlap file-set check       | shared-file risk humans should see | cross-file semantic breaks |
| Rerun `agent-ci` on integration   | cross-file semantic breaks        | issues CI doesn't test for |

All three must fire; skipping any one creates a known-class miss.

---

## Stale-lease reclaim — spec

Pseudocode for the "last touch" check the mailbox runs before handing a stale
lease to a new holder.

```ts
/**
 * Decide whether a lease whose TTL has expired can be safely reclaimed.
 *
 * Called from the lease manager when a waiting worker polls for a stale
 * lease. Only the HOLDER'S worktree can answer; `git status` is
 * worktree-local.
 */
function canReclaimStaleLease(
  repo: GitRepo,
  lease: {
    leaseId: LeaseId;
    holderRunId: RunId;
    holderWorktreePath: AbsPath;   // was recorded at acquire time
    globs: string[];               // e.g. ["src/foo.ts", "src/lib/**"]
    expiredAt: Timestamp;
  },
): ReclaimDecision {
  // Expand leased globs to concrete pathspecs for `git status`.
  const pathspecs = lease.globs.map(g => `:(glob)${g}`);

  // `git status --porcelain --untracked-files=all --ignored=no`
  //   - includes modified tracked paths  (" M ", "M  ")
  //   - includes untracked new files     ("?? ")
  //   - excludes files matching .gitignore
  // We only care about non-empty output restricted to the lease globs.
  const dirty = repo.statusPorcelain({
    worktree: lease.holderWorktreePath,
    pathspecs,
    includeUntracked: "all",
    includeIgnored: false,
  });

  if (dirty.length === 0) {
    return {
      decision: "allow",
      leaseId: lease.leaseId,
      rationale: "holder worktree clean under lease globs",
    };
  }

  // Dirty ⇒ promote to escalation. Do not auto-reclaim.
  return {
    decision: "refuse",
    leaseId: lease.leaseId,
    rationale: "holder worktree has uncommitted changes under lease globs",
    escalation: {
      kind: "EscalationRaised",
      reason: "stale_lease_with_uncommitted_changes",
      lease: {
        holder: lease.holderRunId,
        glob: lease.globs.join(", "),
        worktree: lease.holderWorktreePath,
      },
      evidence: {
        // Serialize porcelain lines. One per dirty path.
        gitStatus: dirty.map(d => `${d.code} ${d.path}`).join(";"),
      },
      suggestedAction: "human_triage",
    },
  };
}
```

### Inputs / outputs

- **Input:** the `lease` record with holder run id, the holder's worktree
  path, the leased globs, and expiry.
- **Output:** either `{ decision: "allow" }` or
  `{ decision: "refuse", escalation: EscalationRaised }`. The escalation is
  a typed domain event the supervisor publishes; the lease table stays
  locked (holder still "owns" the glob) until a human or the flow engine
  resolves the escalation (e.g. by committing/stashing the holder's work, or
  destroying the worktree and its branch).

### Why worktree-local

`git status` reports only the invoking worktree's view. The mailbox must
invoke the check from the **holder's** worktree — not the reclaimer's, not
the integration branch's. The lease record therefore has to carry the
holder's worktree path, or the reclaim path has to recompute it from
`run_id → worktree` at lookup time. Either works; the spike recorded
`holderWorktreePath` directly, which is simpler.

### Failure modes to document

- **Holder worktree destroyed.** If the holder's worktree is gone,
  `git status` fails (repo not found). Treat as "can't verify, refuse and
  escalate" — same shape as the dirty-path case, with
  `reason: "holder_worktree_missing"`. Do **not** silently allow reclaim;
  a missing worktree means uncommitted work may have been lost with it.
- **Commit exists but was never pushed upstream.** Not the lease manager's
  problem. As long as `git status` is clean, the lease is releasable. The
  un-pushed commit is visible on the run branch and will be reconciled via
  the normal patch lifecycle.
- **File matches glob but is listed under `.gitignore`.** Our porcelain call
  passes `--ignored=no`, so .gitignored paths never appear. If a project
  wants stricter enforcement (e.g. a lease covering `build/` intentionally),
  a per-lease `includeIgnored: true` override is a trivial extension.

---

## Cleanup cost measurements

Copied from Scenario 6 above for easy PLAN cross-reference:

| N worktrees | disk (KiB total) | create (ms) | destroy (ms) | avg create (ms/wt) | avg destroy (ms/wt) |
|---:|---:|---:|---:|---:|---:|
|  1 |    292 |    27 |    23 | 27 | 23 |
|  5 |  1 460 |   118 |   114 | 23 | 22 |
| 10 |  2 920 |   236 |   227 | 23 | 22 |
| 25 |  7 300 |   616 |   587 | 24 | 23 |
| 50 | 14 600 | 1 426 | 1 295 | 28 | 25 |

Per-worktree overhead is dominated by checkout IO, not git admin. `git
worktree prune` cleanly handles out-of-band directory deletion and is
effectively free.

---

## Kill-switch findings

- **Reconcile loop is deterministic** on every manufactured scenario we ran.
  Go for Phase 3.
- **Glob leases + pre-commit guard are insufficient** for semantic safety —
  confirmed. The plan already acknowledges this; the spec above turns it
  into two concrete post-merge checks.
- **git 2.50 flag regressions.** `git revert -q` and `git worktree prune -q`
  are both rejected. Non-blocking but must be absent from `packages/worktree`
  and the reconcile implementation. Redirect output instead.
- **Worktree footprint and setup time are not a scaling risk** at Phase 3
  targets (5–10 concurrent agents). We're ~23 ms/worktree amortized and a
  few MiB disk total. No need to explore alternatives (e.g. `git sparse-checkout`
  per worktree) for the foreseeable future.

---

## What to change in PLAN.md

Recommended edits — **not applied here, surfaced for the parent agent to
apply before Phase 3 freezes**.

1. **Patch lifecycle §6 (Integrate):** tighten the diff-overlap check
   description to specify:
   - it runs per integration-merge window with a fixed `windowStart`,
   - it uses `git diff --name-only -M` against merge base of each run,
   - it has a configurable `alwaysFlagGlobs` set (default:
     `**/*.test.*`, `**/tsconfig*.json`, `package.json`,
     `**/schema.sql`, `agent-ci.yml`, `.github/workflows/*.yml`),
   - it has a configurable `ignoredGlobs` set (default:
     `**/*.md`, `node_modules/**`, `vendor/**`, `.shamu/**`),
   - an empty `flagged` set advances to human-handoff; non-empty fans out
     to the reconcile node.
2. **Patch lifecycle §6 (Integrate):** call out that auto-revert is not
   blind — it must re-run CI and bisect prior merges up to N attempts
   before quarantining. Single-revert happy-path is only one case.
3. **Patch lifecycle §1 (Claim):** specify the stale-lease last-touch
   check as `git status --porcelain --untracked-files=all --ignored=no`
   scoped to lease globs in the **holder's** worktree; make the lease row
   carry `holder_worktree_path` explicitly.
4. **Patch lifecycle §1 (Claim):** add a failure mode — "holder worktree
   missing" must also refuse reclaim and escalate, not silently grant.
5. **`packages/worktree` task list (Track 3.B):** note that the
   implementation must not pass `-q` to `git revert` or `git worktree
   prune` (git 2.50+ rejects it); redirect output instead.
6. **Phase 3 exit criteria:** add "diff-overlap check and stale-lease
   last-touch check both implemented with contract tests covering the
   six manufactured scenarios reproduced in the 0.C spike."

No changes to the overall architecture are needed. The design survives the
review agent's challenge with two post-merge checks and one last-touch
check — all cheap, all deterministic, all documented above.
