/**
 * Subprocess spawn smoke test.
 *
 * Deliberately narrow — we don't assert on subprocess output (fragile
 * in CI: different bun versions, different path resolution, flaky
 * SIGTERM timing). The test spawns the watchdog against a valid DB,
 * waits briefly for it to come up, and then stops it. Success = no
 * crash, handle exits within the grace window.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnWatchdogSubprocess } from "../src/subprocess.ts";
import { openTempDb, type TempDb } from "./helpers.ts";

describe("spawnWatchdogSubprocess — smoke", () => {
  let db: TempDb;
  beforeEach(() => {
    db = openTempDb("shamu-watchdog-sm-");
  });
  afterEach(() => db.close());

  it("spawns and stops cleanly", async () => {
    const handle = spawnWatchdogSubprocess({
      dbPath: db.path,
      tickMs: 10_000, // long tick so stop() doesn't race with a query
      stopGraceMs: 2_000,
    });
    expect(handle.pid).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 150));
    await handle.stop();
    const result = await handle.exited;
    // Accept either a clean exit (code 0) or SIGTERM completion —
    // the subprocess may finish its Promise.race before flipping
    // exitCode; the important invariant is "it stopped."
    expect(result.code === 0 || result.signal !== null).toBe(true);
  });
});
