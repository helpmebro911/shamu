# Phase 0 — De-risking Spike

Each sub-spike writes a kill-switch finding (go / no-go with evidence) before Phase 1 contracts freeze. See `PLAN.md` for the full Phase 0 description.

## Spikes

| ID  | Topic                          | File                          | Blocker?   |
|-----|--------------------------------|-------------------------------|------------|
| 0.A | Bun compatibility              | `bun-compat.md`               | —          |
| 0.B | Event schema adequacy          | `event-schema.md`             | —          |
| 0.C | Worktree merge mechanics       | `worktree-merge.md`           | —          |
| 0.D | agent-ci integration shape     | `agent-ci.md`                 | —          |
| 0.E | Threat model writeup           | `threat-model.md`             | —          |

Each spike may also leave a small artifact directory alongside its writeup (`bun-compat-spike/`, `worktree-merge-spike/`, etc.) containing scripts or test repos used to generate evidence. These are kept in-tree for reproducibility; they are not part of the production build.

## After Phase 0

Findings are summarised into `PLAN.md` revisions (adapter contract, event schema, patch lifecycle, CI integration, threat model) **before** Phase 1 begins.
