#!/usr/bin/env bun
/**
 * Shamu web dashboard — entry point.
 *
 * Boots the Hono app against the CLI's canonical SQLite database and serves
 * it on `127.0.0.1:<port>` via Bun's native `Bun.serve`. Single-user,
 * on-device; deliberately never binds to a non-loopback interface.
 *
 * Config (all env-driven; no flags in MVP):
 *   SHAMU_WEB_PORT    override the default 4711
 *   SHAMU_STATE_DIR   override the SQLite state dir (mirrors the CLI)
 *
 * Two entry shapes:
 *   - `startServer(opts?)` — library entry. Boots the server and returns a
 *     handle `{ url, stop, server, config }`. Does NOT register signal
 *     handlers; the caller (typically `shamu ui`) owns lifecycle.
 *   - `main()` — script entry. Calls `startServer()`, registers SIGINT /
 *     SIGTERM cleanup, prints the banner, and stays alive. Used by
 *     `bun src/server/index.ts`.
 */

import { openDatabase } from "@shamu/persistence";
import { createApp } from "./app.ts";
import { type ResolveConfigOptions, resolveConfig, type ServerConfig } from "./config.ts";

export interface StartServerResult {
  readonly url: string;
  readonly server: ReturnType<typeof Bun.serve>;
  readonly config: ServerConfig;
  /** Idempotent shutdown: stops the HTTP server and closes the DB handle. */
  stop(): Promise<void>;
}

/**
 * Boot the web dashboard server in-process.
 *
 * - Opens the SQLite database (runs migrations on open).
 * - Binds `Bun.serve` to `<host>:<port>` where host is always `127.0.0.1`
 *   (config enforces this).
 * - Returns a handle the caller owns. The caller is responsible for
 *   registering signal handlers and invoking `stop()` on shutdown — this
 *   function deliberately does not touch `process.on(...)` so multiple
 *   callers can coexist (tests, CLI embedding).
 */
export async function startServer(opts: ResolveConfigOptions = {}): Promise<StartServerResult> {
  const config = resolveConfig(opts);
  const db = openDatabase(config.dbPath);
  const app = createApp({ db, config });

  const server = Bun.serve({
    fetch: app.fetch,
    hostname: config.host,
    port: config.port,
    // SSE connections outlive a typical request; keep the handler awake.
    idleTimeout: 0,
  });

  const url = `http://${server.hostname}:${server.port}`;

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    server.stop(true);
    try {
      db.close();
    } catch {
      // best-effort close; the server is already down.
    }
  };

  return { url, server, config, stop };
}

export async function main(): Promise<void> {
  const { url, config, stop } = await startServer();

  process.stdout.write(
    `shamu web listening at ${url}\n` +
      `  db:        ${config.dbPath}\n` +
      `  staticDir: ${config.staticDir}\n` +
      `  origins:   ${config.allowedOrigins.join(", ")}\n`,
  );

  // Graceful shutdown — close the DB handle and the server on SIGINT/SIGTERM.
  const shutdown = (signal: NodeJS.Signals) => {
    process.stdout.write(`\nreceived ${signal}; shutting down shamu web\n`);
    void stop().finally(() => {
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// Only self-start when run as a script (i.e. `bun src/server/index.ts`).
// Allows `import { main, startServer } from "./server/index.ts"` in tests
// and the `shamu ui` CLI wiring without double-booting.
const isEntry = import.meta.url === `file://${process.argv[1]}`;
if (isEntry) {
  void main();
}
