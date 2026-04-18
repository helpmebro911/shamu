/**
 * `@shamu/core-composition` — public surface.
 *
 * Cross-primitive composition glue. Three items live here because no
 * single primitive package owns them without dragging an unwanted
 * dependency into its layer:
 *
 *   - EscalationEmitter — bridges `@shamu/mailbox` and `@shamu/watchdog`
 *     events onto the `@shamu/core-supervisor` bus. Putting it inside
 *     `@shamu/core-supervisor` would drag mailbox + watchdog deps into
 *     the supervisor; putting it inside `@shamu/mailbox` or
 *     `@shamu/watchdog` would couple them to the supervisor's event
 *     taxonomy. Neither is right.
 *
 *   - persistenceReadRun driver — a thin, typed wrapper over
 *     `@shamu/persistence/queries/runs` that `@shamu/worktree` GC can
 *     consume WITHOUT taking a direct persistence dep (layer hygiene).
 *
 *   - `diffOverlapCheck` — the file-overlap gate the integrate step of
 *     the patch lifecycle runs after every merge, per PLAN § "Patch
 *     lifecycle" line 450. Needs git + glob matching but is not a
 *     worktree primitive (it reads diffs, doesn't manipulate worktrees).
 */

export {
  DEFAULT_ALWAYS_FLAG_GLOBS,
  DEFAULT_IGNORED_GLOBS,
  type DiffOverlapPolicy,
  type DiffOverlapResult,
  diffOverlapCheck,
  type RunMergeRecord,
} from "./diff-overlap.ts";
export {
  createEscalationEmitter,
  type EscalationEmitterHandle,
  type EscalationEmitterOptions,
} from "./escalation-emitter.ts";
export {
  type CreateReadRunRowOptions,
  createReadRunRow,
  type ReadRunRow,
  type ReadRunRowResult,
} from "./persistence-read-run.ts";
