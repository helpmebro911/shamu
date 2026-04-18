/**
 * Authenticated call context for mailbox and lease primitives.
 *
 * Security model (PLAN.md § "Security & threat model → G6"):
 *
 * Every public primitive in this package accepts an {@link AuthContext}
 * struct. The struct carries the **orchestrator-minted** sender identity —
 * `runId`, `swarmId`, and the authenticated `agent` name. There is no
 * `from` parameter on any primitive; `from_agent` in the DB is *always*
 * read from `ctx.agent`. Callers cannot forge it because:
 *
 *   1. The primitive signatures have no `from` field at all, so a writer
 *      supplying a payload with `from` would type-fail at compile time and
 *      be invisible at runtime.
 *   2. `AuthContext` is the orchestrator's boundary shape; it must only be
 *      constructed by the orchestrator's auth layer once a run has been
 *      validated. This package does NOT itself validate that `runId`
 *      corresponds to a currently-active run — that responsibility lives in
 *      the orchestrator (where live-run state is tracked). This package
 *      only enforces that the context is well-formed (non-empty `agent`).
 *
 * An attacker who wants to impersonate another agent would therefore need
 * to construct an `AuthContext` with someone else's `agent` and submit it
 * — the orchestrator is responsible for preventing that before the
 * primitives see it.
 */

import type { RunId, SwarmId } from "@shamu/shared/ids";

/**
 * Orchestrator-authenticated call context.
 *
 * Constructed by the orchestrator auth layer (never by writer code) and
 * threaded through every mailbox/lease primitive in this package.
 *
 * @property runId    The run that owns the call. Used as `holder_run_id`
 *                    on acquired leases and for lease-ownership checks on
 *                    release/reclaim.
 * @property swarmId  The swarm the run participates in. Used as the
 *                    scoping key for broadcast, whisper delivery, and
 *                    lease listings.
 * @property agent    The authenticated sender identity. Written verbatim
 *                    into `from_agent` on every mailbox row; matched
 *                    against `to_agent` on {@link markRead}; used as the
 *                    `agent` column on acquired leases.
 */
export interface AuthContext {
  readonly runId: RunId;
  readonly swarmId: SwarmId;
  readonly agent: string;
}

/**
 * Thrown when a primitive is called with an invalid or incomplete
 * {@link AuthContext}. The orchestrator should never let this surface in
 * production; tests assert it to prove the guard is wired.
 */
export class UnauthenticatedWriteError extends Error {
  public readonly code = "unauthenticated_write" as const;
  public override readonly name = "UnauthenticatedWriteError";
}

/**
 * Runtime structural check. Primitives call this on entry so that any
 * context constructed outside the orchestrator (bad test wiring, a future
 * public embedding surface) trips immediately with a clear error instead
 * of landing a row with an empty `from_agent`.
 */
export function assertAuthContext(ctx: AuthContext): void {
  if (
    typeof ctx !== "object" ||
    ctx === null ||
    typeof ctx.agent !== "string" ||
    ctx.agent.length === 0
  ) {
    throw new UnauthenticatedWriteError("AuthContext.agent must be a non-empty string");
  }
  if (typeof ctx.runId !== "string" || ctx.runId.length === 0) {
    throw new UnauthenticatedWriteError("AuthContext.runId must be a non-empty string");
  }
  if (typeof ctx.swarmId !== "string" || ctx.swarmId.length === 0) {
    throw new UnauthenticatedWriteError("AuthContext.swarmId must be a non-empty string");
  }
}
