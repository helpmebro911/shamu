/**
 * Services wiring contract.
 *
 * Every command handler receives a `Services` object. In Phase 1.D the real
 * implementations don't exist yet (persistence is mid-flight in 1.B;
 * supervisor lands in Phase 3). Commands that need un-implemented services
 * print a friendly "not available yet" notice and exit with INTERNAL.
 *
 * TODO(1.B): once `@shamu/shared` lands, replace the inline `Logger` surface
 * below with an import from `@shamu/shared/logger` (and similarly for
 * PersistenceHandle / SupervisorHandle when those packages exist). Keeping the
 * types inline here unblocks the CLI from compiling while 1.B is in flight.
 */

import type { ShamuConfig } from "../config.ts";

/** Minimal logger surface. Compatible shape with the forthcoming @shamu/shared logger. */
export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/**
 * Persistence handle. In Phase 1 this is an opaque type — the shape comes from
 * `@shamu/persistence` in 1.B. Commands that read from persistence should
 * check for `null` (not yet wired) and exit with a clear message.
 */
export type PersistenceHandle = {
  readonly __brand: "PersistenceHandle";
};

/**
 * Supervisor handle. Lands in Phase 3. Commands like `kill`, `attach` need it;
 * they should check for `null` and exit with a clear "lands in Phase N" notice.
 */
export type SupervisorHandle = {
  readonly __brand: "SupervisorHandle";
};

/** Services bundle threaded to every command. */
export interface Services {
  readonly config: ShamuConfig;
  readonly logger: Logger;
  readonly persistence: PersistenceHandle | null;
  readonly supervisor: SupervisorHandle | null;
}
