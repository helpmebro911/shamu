/**
 * AgentAdapter contract — the shape every vendor adapter must implement.
 *
 * Mirrors PLAN.md § 1 (Adapter contract) literally. Keep this file free of
 * vendor branching; helpers and subprocess primitives live in sibling modules
 * and are imported by concrete adapters (Phase 2 onward), not by this
 * contract.
 *
 * Design rules:
 * 1. `readonly` on every field that shouldn't mutate post-construction.
 * 2. `Capabilities` is the source of truth about what this adapter can do;
 *    the runtime must not upgrade or downgrade its own capabilities (G8 from
 *    the threat model). `loadCapabilities` returns a frozen object.
 * 3. `events` is an `AsyncIterable<AgentEvent>` — the contract says
 *    "async iterable," not "async iterator" — so a `Symbol.asyncIterator` is
 *    the only required surface, and both the handle and the adapter decide
 *    how to implement it (queue, stream bridge, replay).
 */

import type { AgentEvent, EventId, PermissionMode, RunId, SessionId } from "@shamu/shared";
import type { Capabilities } from "./capabilities.ts";

/**
 * A single user message delivered to the agent.
 *
 * Adapters own the vendor-specific serialization (Claude wraps in
 * `Message`, Codex uses `startThread().runStreamed({user_message: ...})`,
 * etc.); Shamu's core only speaks this shape.
 */
export interface UserTurn {
  readonly text: string;
  /**
   * Optional attachments. Adapters that do not support attachments should
   * raise via an `error` event on first receipt rather than silently dropping
   * — the contract suite will surface the silent drop as a capability
   * regression if the adapter's `Capabilities` declares otherwise.
   */
  readonly attachments?: readonly UserAttachment[];
}

export interface UserAttachment {
  readonly kind: "text" | "binary";
  readonly contentType: string;
  readonly data: string | Uint8Array;
  readonly filename?: string;
}

/**
 * Options passed to `spawn` and `resume`.
 *
 * Per 0.B, `vendorCliPath` is first-class: it lets pre-authenticated vendor
 * CLIs skip env-var auth. Claude maps it to `pathToClaudeCodeExecutable`;
 * Codex maps it to its CLI override. All other adapters MUST accept and
 * either respect or loudly reject it (don't silently ignore).
 */
export interface SpawnOpts {
  /**
   * Orchestrator-assigned run id. Required from Phase 2 onward — vendor
   * adapters MUST NOT mint their own (G8 from threat model: a compromised
   * adapter must not be able to fabricate identity that the supervisor
   * later treats as authoritative). The returned handle's `runId` MUST
   * equal this value.
   *
   * Phase 1's echo adapter minted its own runId because no orchestrator
   * existed yet; the field is now required contract-wide.
   */
  readonly runId: RunId;
  readonly cwd: string;
  readonly model?: string;
  readonly permissionMode?: PermissionMode;
  /** Path to a pre-authenticated vendor CLI binary (per 0.B). */
  readonly vendorCliPath?: string;
  readonly allowedTools?: readonly string[];
  readonly maxTurns?: number;
  /**
   * Opaque adapter-specific extensions. Concrete adapters may declare a
   * narrower type for this field via module augmentation; the base contract
   * accepts unknown because the core does not look inside.
   */
  readonly vendorOpts?: Readonly<Record<string, unknown>>;
  /**
   * Supplemental env vars injected into the vendor subprocess. Intended
   * primarily for `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY` set by the egress
   * broker at spawn time. Keys here are merged on top of the adapter's
   * default env allow-list; empty-string values clear a key.
   *
   * Adapters without a subprocess (e.g. the echo in-memory driver) accept
   * the field for contract consistency and ignore it. SDK-spawned adapters
   * (Claude, Codex) forward the merged map to the SDK's own subprocess
   * `env` option. Adapters that own the subprocess directly
   * (Cursor/Gemini/Amp/Pi) merge the caller map on top of their existing
   * env allow-list before calling `Bun.spawn` / `createStdioTransport`.
   */
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * Heartbeat snapshot. Supervisor and watchdog poll this to decide whether
 * the adapter is still making progress. Stable fields only — anything
 * vendor-specific rides in the event stream.
 */
export interface HandleHeartbeat {
  readonly lastEventAt: number;
  readonly seq: number;
}

/**
 * An adapter's live connection to a single run.
 *
 * `events` yields every normalized event the adapter has observed, in order,
 * with `seq` strictly increasing. When the handle's run is done, the iterable
 * completes cleanly — no infinite pending iterator.
 */
export interface AgentHandle {
  readonly runId: RunId;
  readonly sessionId: SessionId | null;
  readonly events: AsyncIterable<AgentEvent>;

  send(message: UserTurn): Promise<void>;
  interrupt(reason?: string): Promise<void>;
  setModel(model: string): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  shutdown(reason: string): Promise<void>;
  heartbeat(): HandleHeartbeat;
}

/**
 * The adapter itself. One instance per vendor, reused across runs.
 *
 * `capabilities` MUST be declared at construction (loaded via
 * `loadCapabilities(manifestPath)` or `freezeCapabilities(obj)`); the adapter
 * is not permitted to vary its capabilities across runs.
 */
export interface AgentAdapter {
  readonly vendor: string;
  readonly capabilities: Capabilities;

  spawn(opts: SpawnOpts): Promise<AgentHandle>;
  resume(sessionId: SessionId, opts: SpawnOpts): Promise<AgentHandle>;
}

/**
 * Type guard used by the contract suite to decide whether an object
 * plausibly implements the contract. Purely structural; does not validate
 * capabilities or simulate a run.
 */
export function isAgentAdapter(value: unknown): value is AgentAdapter {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<AgentAdapter>;
  return (
    typeof v.vendor === "string" &&
    typeof v.capabilities === "object" &&
    v.capabilities !== null &&
    typeof v.spawn === "function" &&
    typeof v.resume === "function"
  );
}

/**
 * Event-stream reference the adapter can pass to `packages/persistence` to
 * link a normalized event back to its raw source. Re-exported here as a
 * convenience for adapter authors who don't want to pull from two modules.
 */
export type { EventId };
