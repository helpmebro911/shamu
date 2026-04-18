/**
 * AgentEvent Zod schemas.
 *
 * Mirrors PLAN.md § 1 (Adapter contract). Every event is an `EventEnvelope`
 * union'd with a discriminated `kind` payload. The envelope carries
 * correlation IDs, monotonic sequence, and an optional reference into the
 * raw-events table.
 *
 * The `AgentEvent` runtime type is inferred from the schema so there's one
 * source of truth. A round-trip test (parse → stringify) lives in
 * events.test.ts.
 */

import { z } from "zod";

// --- Shared sub-schemas -----------------------------------------------------

// ULID shape — 26 chars of Crockford base32. We don't cross-check against
// `ulid.ts` at schema-build time to avoid a circular import of runtime
// helpers into a data schema.
const ulidSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);

const tokensSchema = z.object({
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  cacheRead: z.number().int().nonnegative().optional(),
  cacheCreation: z.number().int().nonnegative().optional(),
});

const cacheStatsSchema = z.object({
  hits: z.number().int().nonnegative(),
  misses: z.number().int().nonnegative(),
});

export const rawEventRefSchema = z.object({
  eventId: ulidSchema,
  table: z.literal("raw_events"),
});

export const eventEnvelopeSchema = z.object({
  eventId: ulidSchema,
  runId: z.string().min(1),
  sessionId: z.string().min(1).nullable(),
  turnId: z.string().min(1),
  parentEventId: ulidSchema.nullable(),
  seq: z.number().int().nonnegative(),
  tsMonotonic: z.number().int().nonnegative(),
  tsWall: z.number().int().nonnegative(),
  vendor: z.string().min(1),
  rawRef: rawEventRefSchema.nullable(),
});

// --- Per-kind payload schemas -----------------------------------------------
// Each `kind` payload is the envelope extended with the discriminator key and
// kind-specific fields. Using `extend` keeps the field layouts readable.

const sessionStartSchema = eventEnvelopeSchema.extend({
  kind: z.literal("session_start"),
  source: z.enum(["spawn", "resume", "fork"]),
});

const sessionEndSchema = eventEnvelopeSchema.extend({
  kind: z.literal("session_end"),
  reason: z.string(),
});

const reasoningSchema = eventEnvelopeSchema.extend({
  kind: z.literal("reasoning"),
  text: z.string(),
  signature: z.string().optional(),
});

const assistantDeltaSchema = eventEnvelopeSchema.extend({
  kind: z.literal("assistant_delta"),
  text: z.string(),
});

const assistantMessageSchema = eventEnvelopeSchema.extend({
  kind: z.literal("assistant_message"),
  text: z.string(),
  stopReason: z.string(),
});

const toolCallSchema = eventEnvelopeSchema.extend({
  kind: z.literal("tool_call"),
  toolCallId: z.string().min(1),
  tool: z.string().min(1),
  args: z.unknown(),
});

const toolResultSchema = eventEnvelopeSchema.extend({
  kind: z.literal("tool_result"),
  toolCallId: z.string().min(1),
  ok: z.boolean(),
  summary: z.string(),
  bytes: z.number().int().nonnegative(),
});

const permissionRequestSchema = eventEnvelopeSchema.extend({
  kind: z.literal("permission_request"),
  toolCallId: z.string().min(1),
  decision: z.enum(["pending", "allow", "deny", "ask"]),
});

const patchAppliedSchema = eventEnvelopeSchema.extend({
  kind: z.literal("patch_applied"),
  files: z.array(z.string()),
  stats: z.object({
    add: z.number().int().nonnegative(),
    del: z.number().int().nonnegative(),
  }),
});

const checkpointSchema = eventEnvelopeSchema.extend({
  kind: z.literal("checkpoint"),
  summary: z.string(),
});

const stdoutSchema = eventEnvelopeSchema.extend({
  kind: z.literal("stdout"),
  text: z.string(),
});

const stderrSchema = eventEnvelopeSchema.extend({
  kind: z.literal("stderr"),
  text: z.string(),
});

const usageSchema = eventEnvelopeSchema.extend({
  kind: z.literal("usage"),
  model: z.string(),
  tokens: tokensSchema,
  cache: cacheStatsSchema,
});

const costSchema = eventEnvelopeSchema.extend({
  kind: z.literal("cost"),
  usd: z.number().nullable(),
  confidence: z.enum(["exact", "estimate", "unknown"]),
  source: z.string(),
});

const rateLimitSchema = eventEnvelopeSchema.extend({
  kind: z.literal("rate_limit"),
  scope: z.enum(["minute", "hour", "day", "five_hour", "other"]),
  status: z.enum(["ok", "warning", "exhausted"]),
  resetsAt: z.number().int().nonnegative().nullable(),
});

const interruptSchema = eventEnvelopeSchema.extend({
  kind: z.literal("interrupt"),
  requestedBy: z.enum(["user", "supervisor", "watchdog", "flow"]),
  delivered: z.boolean(),
});

const turnEndSchema = eventEnvelopeSchema.extend({
  kind: z.literal("turn_end"),
  stopReason: z.string(),
  durationMs: z.number().int().nonnegative(),
});

const errorSchema = eventEnvelopeSchema.extend({
  kind: z.literal("error"),
  fatal: z.boolean(),
  errorCode: z.string(),
  message: z.string(),
  retriable: z.boolean(),
});

export const agentEventSchema = z.discriminatedUnion("kind", [
  sessionStartSchema,
  sessionEndSchema,
  reasoningSchema,
  assistantDeltaSchema,
  assistantMessageSchema,
  toolCallSchema,
  toolResultSchema,
  permissionRequestSchema,
  patchAppliedSchema,
  checkpointSchema,
  stdoutSchema,
  stderrSchema,
  usageSchema,
  costSchema,
  rateLimitSchema,
  interruptSchema,
  turnEndSchema,
  errorSchema,
]);

export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;
export type RawEventRef = z.infer<typeof rawEventRefSchema>;
export type AgentEvent = z.infer<typeof agentEventSchema>;
export type AgentEventKind = AgentEvent["kind"];

export const AGENT_EVENT_KINDS: readonly AgentEventKind[] = [
  "session_start",
  "session_end",
  "reasoning",
  "assistant_delta",
  "assistant_message",
  "tool_call",
  "tool_result",
  "permission_request",
  "patch_applied",
  "checkpoint",
  "stdout",
  "stderr",
  "usage",
  "cost",
  "rate_limit",
  "interrupt",
  "turn_end",
  "error",
] as const;

export function parseAgentEvent(value: unknown): AgentEvent {
  return agentEventSchema.parse(value);
}
