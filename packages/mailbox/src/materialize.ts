/**
 * Transactional JSONL materialization of the mailbox.
 *
 * PLAN.md § "Core architecture → 5": the `.shamu/mailbox/<agent>.jsonl`
 * files are a **materialized export**, not the source of truth. The DB
 * is authoritative. Files exist so adapters can `tail -f` without
 * opening SQLite, and so operators can diff/grep the mailbox with
 * ordinary tools.
 *
 * Consistency rule: the JSONL file for `agent` at any observable moment
 * must be a **prefix of** (or equal to) the DB's mailbox rows for
 * `to_agent = agent`, ordered by `delivered_at`. We maintain the rule
 * with two mechanisms:
 *
 *   1. {@link appendToMaterializedLog} — called after an insert commits.
 *      Writes the new line to a temp file, `fsync`s, renames onto the
 *      jsonl path. Rename is atomic so an external reader either sees
 *      the old file or the new file, never a half-written one. On a
 *      crash mid-write the temp file is orphaned; {@link reconcile}
 *      cleans it up.
 *
 *   2. {@link reconcile} — called on boot. Walks the mailbox table, then
 *      **rewrites each agent's jsonl file from scratch** so any
 *      divergence (missed appends, orphaned temp files, manual
 *      tampering) is corrected. Pure function of the DB state.
 *
 * Note on "append" semantics: true appends + fsync are technically
 * safe under POSIX for lines up to `PIPE_BUF`, but the atomic-rename
 * approach is portable and easy to reason about. Mailbox volume is
 * low (human-scale messages), so the extra read/write per append is
 * fine. If volume ever becomes a concern, this is a clean swap-in for
 * `O_APPEND | O_SYNC` + a separate WAL.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { ShamuDatabase } from "@shamu/persistence/db";
import type { MailboxRow } from "@shamu/persistence/queries/mailbox";

/**
 * Compute the on-disk path for an agent's materialized mailbox.
 *
 * `baseDir` is the repo root — the caller passes whatever the current
 * worktree / project root is. The returned path is always
 * `${baseDir}/.shamu/mailbox/${agent}.jsonl`.
 */
export function materializePath(baseDir: string, agent: string): string {
  return join(baseDir, ".shamu", "mailbox", `${agent}.jsonl`);
}

/**
 * Serialize a mailbox row to a JSONL line. Stable field order so diffs
 * stay minimal across runs.
 */
function serializeRow(row: MailboxRow): string {
  return `${JSON.stringify({
    msgId: row.msgId,
    swarmId: row.swarmId,
    fromAgent: row.fromAgent,
    toAgent: row.toAgent,
    body: row.body,
    deliveredAt: row.deliveredAt,
    readAt: row.readAt,
  })}\n`;
}

/**
 * Append a single row to the materialized log for `row.toAgent`.
 *
 * Algorithm:
 *   - Ensure `${baseDir}/.shamu/mailbox/` exists.
 *   - Read current file contents (empty if absent).
 *   - Write `existing + newLine` to `${path}.tmp`, fsync, rename onto
 *     `path`. Rename is atomic on local filesystems.
 *
 * The read-then-rewrite pattern keeps the export "always consistent"
 * even if a crash happens mid-call: the file on disk is either the
 * pre-append state or the post-append state. Never partial.
 */
export function appendToMaterializedLog(baseDir: string, row: MailboxRow): void {
  const path = materializePath(baseDir, row.toAgent);
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });

  let existing = "";
  try {
    existing = readFileSync(path, "utf8");
  } catch {
    // File doesn't exist yet — start empty.
  }

  const tmp = `${path}.tmp`;
  const contents = existing + serializeRow(row);
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, contents);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

/**
 * Rewrite every agent's JSONL file from the canonical DB state.
 *
 * Called on boot. Walks `mailbox` table, groups by `to_agent`, rewrites
 * each agent's file via temp-file-then-rename.
 *
 * Does not delete files for agents who no longer have any messages —
 * an empty jsonl file is a meaningful "inbox drained" marker and the
 * cost of leaving it is negligible.
 */
export function reconcile(baseDir: string, db: ShamuDatabase): void {
  const rows = db
    .prepare(
      "SELECT msg_id, swarm_id, from_agent, to_agent, body, delivered_at, read_at FROM mailbox ORDER BY delivered_at, msg_id",
    )
    .all() as Array<{
    msg_id: string;
    swarm_id: string;
    from_agent: string;
    to_agent: string;
    body: string;
    delivered_at: number;
    read_at: number | null;
  }>;

  const byAgent = new Map<string, MailboxRow[]>();
  for (const r of rows) {
    const row: MailboxRow = {
      msgId: r.msg_id,
      // Branded string — persistence already validates; structurally a string.
      swarmId: r.swarm_id as MailboxRow["swarmId"],
      fromAgent: r.from_agent,
      toAgent: r.to_agent,
      body: r.body,
      deliveredAt: r.delivered_at,
      readAt: r.read_at,
    };
    const existing = byAgent.get(r.to_agent);
    if (existing === undefined) {
      byAgent.set(r.to_agent, [row]);
    } else {
      existing.push(row);
    }
  }

  const baseMailboxDir = join(baseDir, ".shamu", "mailbox");
  mkdirSync(baseMailboxDir, { recursive: true });

  for (const [agent, agentRows] of byAgent.entries()) {
    const path = materializePath(baseDir, agent);
    const tmp = `${path}.tmp`;
    const serialized = agentRows.map(serializeRow).join("");
    // writeFileSync + renameSync keeps the update atomic.
    writeFileSync(tmp, serialized, "utf8");
    renameSync(tmp, path);
  }
}

/**
 * Diagnostic: does the on-disk file match what the DB says the inbox
 * should be? Used by {@link reconcile}'s tests and optionally by boot
 * code to log a "divergence detected" warning before rewriting.
 */
export function fileMatchesDb(baseDir: string, agent: string, db: ShamuDatabase): boolean {
  const path = materializePath(baseDir, agent);

  let onDisk = "";
  if (existsSync(path)) {
    onDisk = readFileSync(path, "utf8");
  }

  const rows = db
    .prepare(
      "SELECT msg_id, swarm_id, from_agent, to_agent, body, delivered_at, read_at FROM mailbox WHERE to_agent = ? ORDER BY delivered_at, msg_id",
    )
    .all(agent) as Array<{
    msg_id: string;
    swarm_id: string;
    from_agent: string;
    to_agent: string;
    body: string;
    delivered_at: number;
    read_at: number | null;
  }>;

  const expected = rows
    .map((r) =>
      serializeRow({
        msgId: r.msg_id,
        swarmId: r.swarm_id as MailboxRow["swarmId"],
        fromAgent: r.from_agent,
        toAgent: r.to_agent,
        body: r.body,
        deliveredAt: r.delivered_at,
        readAt: r.read_at,
      }),
    )
    .join("");

  return onDisk === expected;
}
