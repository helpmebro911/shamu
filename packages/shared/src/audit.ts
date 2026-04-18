/**
 * Audit event schema — one row per control-plane action.
 *
 * The persistence layer (packages/persistence) chains rows via HMAC; this
 * module only defines the shape of an audit entry (the user-visible payload
 * before HMAC fields are attached).
 */

import { z } from "zod";

export const auditActionSchema = z.enum([
  "run.start",
  "run.stop",
  "run.resume",
  "run.fork",
  "permission.grant",
  "permission.deny",
  "lease.acquire",
  "lease.release",
  "lease.reclaim",
  "mcp.trust",
  "mcp.revoke",
  "patch.apply",
  "patch.revert",
  "integration.merge",
  "ci.start",
  "ci.complete",
  "config.change",
  "secret.read",
  "secret.write",
  "secret.delete",
  "webhook.accept",
  "webhook.reject",
  "escalation.raise",
]);
export type AuditAction = z.infer<typeof auditActionSchema>;

export const auditEventSchema = z.object({
  actor: z.string().min(1),
  action: auditActionSchema,
  entity: z.string().min(1),
  reason: z.string(),
  ts: z.number().int().nonnegative(),
  payload: z.record(z.string(), z.unknown()).default({}),
});

export type AuditEvent = z.infer<typeof auditEventSchema>;
