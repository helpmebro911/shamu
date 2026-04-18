/**
 * @shamu/persistence — public surface.
 */

export type {
  OpenDatabaseOptions,
  PreparedStatement,
  ShamuDatabase,
  SqliteDriver,
} from "./db.ts";
export { openDatabase } from "./db.ts";
export type { Migration, MigrationRecord } from "./migrations.ts";
export { applyPending, migrations } from "./migrations.ts";
export * as auditQueries from "./queries/audit.ts";
export * as costQueries from "./queries/cost.ts";
export * as eventsQueries from "./queries/events.ts";
export * as leasesQueries from "./queries/leases.ts";
export * as mailboxQueries from "./queries/mailbox.ts";
export * as runsQueries from "./queries/runs.ts";
export * as sessionsQueries from "./queries/sessions.ts";
export { INITIAL_SCHEMA_SQL } from "./schema.ts";
