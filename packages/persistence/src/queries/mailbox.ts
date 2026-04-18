/**
 * Typed query helpers for the `mailbox` table.
 *
 * `from_agent` is taken from the caller. The orchestrator-enforced
 * authentication (G6: never trust a writer-supplied `from`) lives at a
 * higher layer — persistence trusts its caller.
 */

import { newEventId, type SwarmId } from "@shamu/shared/ids";
import type { ShamuDatabase } from "../db.ts";

export interface MailboxRow {
  readonly msgId: string;
  readonly swarmId: SwarmId;
  readonly fromAgent: string;
  readonly toAgent: string;
  readonly body: string;
  readonly deliveredAt: number;
  readonly readAt: number | null;
}

export interface InsertMessageInput {
  readonly msgId?: string;
  readonly swarmId: SwarmId;
  readonly fromAgent: string;
  readonly toAgent: string;
  readonly body: string;
  readonly deliveredAt?: number;
}

interface RawMailboxRow {
  msg_id: string;
  swarm_id: string;
  from_agent: string;
  to_agent: string;
  body: string;
  delivered_at: number;
  read_at: number | null;
}

function mapRow(r: RawMailboxRow): MailboxRow {
  return {
    msgId: r.msg_id,
    swarmId: r.swarm_id as SwarmId,
    fromAgent: r.from_agent,
    toAgent: r.to_agent,
    body: r.body,
    deliveredAt: r.delivered_at,
    readAt: r.read_at,
  };
}

const INSERT_MESSAGE_SQL =
  "INSERT INTO mailbox (msg_id, swarm_id, from_agent, to_agent, body, delivered_at, read_at) VALUES (?, ?, ?, ?, ?, ?, NULL)";
const LIST_INBOX_SQL = "SELECT * FROM mailbox WHERE to_agent = ? ORDER BY delivered_at DESC";
const LIST_INBOX_UNREAD_SQL =
  "SELECT * FROM mailbox WHERE to_agent = ? AND read_at IS NULL ORDER BY delivered_at DESC";
const MARK_READ_SQL = "UPDATE mailbox SET read_at = ? WHERE msg_id = ?";

export function insertMessage(db: ShamuDatabase, input: InsertMessageInput): MailboxRow {
  const msgId = input.msgId ?? newEventId();
  const deliveredAt = input.deliveredAt ?? Date.now();
  db.prepare(INSERT_MESSAGE_SQL).run(
    msgId,
    input.swarmId,
    input.fromAgent,
    input.toAgent,
    input.body,
    deliveredAt,
  );
  return {
    msgId,
    swarmId: input.swarmId,
    fromAgent: input.fromAgent,
    toAgent: input.toAgent,
    body: input.body,
    deliveredAt,
    readAt: null,
  };
}

export function listInbox(
  db: ShamuDatabase,
  toAgent: string,
  opts: { unreadOnly?: boolean } = {},
): readonly MailboxRow[] {
  const sql = opts.unreadOnly ? LIST_INBOX_UNREAD_SQL : LIST_INBOX_SQL;
  const rows = db.prepare(sql).all(toAgent) as RawMailboxRow[];
  return rows.map(mapRow);
}

export function markRead(db: ShamuDatabase, msgId: string, readAt: number = Date.now()): void {
  db.prepare(MARK_READ_SQL).run(readAt, msgId);
}
