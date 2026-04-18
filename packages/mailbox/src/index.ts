/**
 * @shamu/mailbox — public surface.
 *
 * Trusted mailbox + file-lease primitives on top of @shamu/persistence.
 * `from_agent` is always sourced from an orchestrator-authenticated
 * {@link AuthContext}; callers have no way to forge it (see G6 in
 * PLAN.md § "Security & threat model").
 */

export type { AuthContext } from "./auth.ts";
export { assertAuthContext, UnauthenticatedWriteError } from "./auth.ts";

export type {
  EscalationEmitter,
  MailboxEscalationCause,
  MailboxEscalationRaised,
} from "./escalation.ts";
export { noopEmitter } from "./escalation.ts";

export { globMatchesPath, globsOverlap } from "./globs.ts";
export type { AcquireLeaseOptions, ReclaimOptions } from "./leases.ts";
export {
  acquireLease,
  LeaseConflictError,
  LeaseOwnershipError,
  listActive,
  reclaimIfStale,
  releaseLease,
} from "./leases.ts";
export type { BroadcastOptions, ReadOptions } from "./mailbox.ts";
export { broadcast, MessageOwnershipError, markRead, read, whisper } from "./mailbox.ts";
export {
  appendToMaterializedLog,
  fileMatchesDb,
  materializePath,
  reconcile,
} from "./materialize.ts";
export type {
  PreCommitGuardOptions,
  PreCommitGuardResult,
} from "./pre-commit.ts";
export { checkStagedPaths, runPreCommitGuard } from "./pre-commit.ts";

export type { LeaseRow, MailboxRow, PreCommitDecision, ReclaimResult } from "./types.ts";
