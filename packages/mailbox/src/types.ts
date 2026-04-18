/**
 * Public type surface for @shamu/mailbox.
 *
 * Re-exports the row shapes the primitives return, plus the decision
 * types the stale-lease reclaim and pre-commit guard produce.
 */

export type { LeaseRow } from "@shamu/persistence/queries/leases";
export type { MailboxRow } from "@shamu/persistence/queries/mailbox";

/**
 * Result of a stale-lease reclaim attempt.
 *
 * - `reclaimed: true` — holder worktree was clean inside the lease
 *   glob; the lease row was deleted.
 * - `reclaimed: false, reason: "dirty_holder"` — `git status --porcelain`
 *   inside the lease glob returned non-empty output; reclaim refused
 *   and an escalation was emitted.
 * - `reclaimed: false, reason: "holder_worktree_missing"` — the worktree
 *   directory on disk no longer exists; reclaim refused and an
 *   escalation was emitted.
 * - `reclaimed: false, reason: "lease_not_found"` — the lease id had
 *   already been released or never existed. Not an escalation.
 * - `reclaimed: false, reason: "lease_not_stale"` — the lease is still
 *   live (expires in the future). Callers should not call
 *   `reclaimIfStale` on a fresh lease; we return rather than throw so a
 *   reaper loop can skip safely.
 */
export type ReclaimResult =
  | { readonly reclaimed: true }
  | {
      readonly reclaimed: false;
      readonly reason:
        | "dirty_holder"
        | "holder_worktree_missing"
        | "lease_not_found"
        | "lease_not_stale";
      readonly detail?: string;
    };

/**
 * Pre-commit guard decision.
 *
 * `allowed: true` when every staged path is covered by at least one live
 * lease held by the committing agent. `blocked` lists the paths that
 * were NOT covered; the guard shells `git` back into an exit code +
 * human-readable message for the hook.
 */
export interface PreCommitDecision {
  readonly allowed: boolean;
  readonly blocked: readonly string[];
}
