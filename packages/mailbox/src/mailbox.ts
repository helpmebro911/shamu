/**
 * Mailbox primitives — broadcast, whisper, read, markRead.
 *
 * Layered on top of `@shamu/persistence/queries/mailbox`. The persistence
 * layer is intentionally dumb CRUD: it trusts its caller. This module is
 * where the G6 invariant (PLAN.md § "Security & threat model → G6") is
 * enforced: `from_agent` is minted from {@link AuthContext.agent}, never
 * from a writer-supplied payload.
 *
 * API design:
 *   - None of these functions accept a `from` parameter — the only way to
 *     set `from_agent` is via `ctx.agent`.
 *   - {@link broadcast} takes an explicit recipient list rather than
 *     auto-expanding "everyone in the swarm". Recipient expansion (who's
 *     actually in the swarm right now?) is an orchestrator concern; the
 *     primitive stays pure.
 *   - {@link markRead} checks that the message is actually addressed to
 *     `ctx.agent` before updating, so one agent cannot quietly mark
 *     another's message as read.
 */

import type { ShamuDatabase } from "@shamu/persistence/db";
import {
  insertMessage,
  listInbox,
  type MailboxRow,
  markRead as persistMarkRead,
} from "@shamu/persistence/queries/mailbox";
import type { SwarmId } from "@shamu/shared/ids";
import { type AuthContext, assertAuthContext, UnauthenticatedWriteError } from "./auth.ts";

/**
 * Thrown when {@link markRead} is called on a message the caller does
 * not own (i.e. `to_agent` does not equal `ctx.agent`).
 *
 * Distinct from {@link UnauthenticatedWriteError} because the context is
 * valid; only the requested resource is not owned by it.
 */
export class MessageOwnershipError extends Error {
  public readonly code = "message_ownership" as const;
  public override readonly name = "MessageOwnershipError";
}

/**
 * Options for {@link broadcast}.
 *
 * `toAgents` is required: the orchestrator decides who "everyone in the
 * swarm" is; this primitive only fans out to the list it's given.
 * `swarmId` defaults to `ctx.swarmId`; override is available for the
 * rare cross-swarm broadcast (planner informing a sibling swarm) but the
 * default is the safe case.
 */
export interface BroadcastOptions {
  readonly toAgents: readonly string[];
  readonly swarmId?: SwarmId;
}

/**
 * Send `body` to every agent in `toAgents` — one mailbox row per
 * recipient. The caller supplies the recipient list; expansion to "all
 * agents currently in the swarm" is an orchestrator responsibility, not
 * a primitive one.
 *
 * `from_agent` is sourced from `ctx.agent`. Any attempt to spoof
 * `from_agent` would have to come from an invalid `AuthContext`;
 * structural guard via {@link assertAuthContext} trips first.
 */
export function broadcast(
  db: ShamuDatabase,
  ctx: AuthContext,
  body: string,
  opts: BroadcastOptions,
): readonly MailboxRow[] {
  assertAuthContext(ctx);
  if (typeof body !== "string") {
    throw new TypeError("broadcast body must be a string");
  }
  if (opts.toAgents.length === 0) {
    return [];
  }

  const swarmId = opts.swarmId ?? ctx.swarmId;
  const rows: MailboxRow[] = [];
  db.transaction(() => {
    for (const to of opts.toAgents) {
      if (typeof to !== "string" || to.length === 0) {
        throw new TypeError("broadcast recipient must be a non-empty string");
      }
      const row = insertMessage(db, {
        swarmId,
        fromAgent: ctx.agent,
        toAgent: to,
        body,
      });
      rows.push(row);
    }
  });
  return rows;
}

/**
 * Send `body` to a single `toAgent`. `from_agent` is `ctx.agent`.
 */
export function whisper(
  db: ShamuDatabase,
  ctx: AuthContext,
  toAgent: string,
  body: string,
): MailboxRow {
  assertAuthContext(ctx);
  if (typeof toAgent !== "string" || toAgent.length === 0) {
    throw new TypeError("whisper toAgent must be a non-empty string");
  }
  if (typeof body !== "string") {
    throw new TypeError("whisper body must be a string");
  }
  return insertMessage(db, {
    swarmId: ctx.swarmId,
    fromAgent: ctx.agent,
    toAgent,
    body,
  });
}

/** Options for {@link read}. */
export interface ReadOptions {
  readonly unreadOnly?: boolean;
}

/**
 * Read `ctx.agent`'s inbox. Primitives cannot peek into another agent's
 * inbox — the `to_agent` filter is always `ctx.agent`.
 */
export function read(
  db: ShamuDatabase,
  ctx: AuthContext,
  opts: ReadOptions = {},
): readonly MailboxRow[] {
  assertAuthContext(ctx);
  const unreadOnly = opts.unreadOnly ?? false;
  return listInbox(db, ctx.agent, { unreadOnly });
}

/**
 * Mark `msgId` as read. Asserts the message is addressed to `ctx.agent`
 * before updating so one agent cannot quietly clear another's inbox.
 *
 * Throws {@link MessageOwnershipError} if the message exists but isn't
 * addressed to `ctx.agent`, or if the message doesn't exist at all (we
 * lump these together so the caller can't probe for foreign msg_ids).
 */
export function markRead(db: ShamuDatabase, ctx: AuthContext, msgId: string): void {
  assertAuthContext(ctx);
  if (typeof msgId !== "string" || msgId.length === 0) {
    throw new TypeError("markRead msgId must be a non-empty string");
  }

  const row = db.prepare("SELECT to_agent FROM mailbox WHERE msg_id = ?").get(msgId) as
    | { to_agent: string }
    | null
    | undefined;

  if (row === undefined || row === null || row.to_agent !== ctx.agent) {
    // Same error for "not found" and "not yours" — prevents probing.
    throw new MessageOwnershipError(
      `Message ${msgId} is not addressed to ${ctx.agent} (or does not exist)`,
    );
  }

  persistMarkRead(db, msgId);
}
