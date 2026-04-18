/**
 * `--watch` / tail-follow must terminate on SIGINT. We spawn the CLI as a
 * subprocess, wait for the first render, send SIGINT, and assert the process
 * exits promptly.
 */

import { spawn } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CLI_ENTRY = join(__dirname, "..", "src", "index.ts");

describe("watch-mode cancellation", () => {
  it("status --watch exits on SIGINT with USER_CANCEL (1)", async () => {
    const proc = spawn("bun", [CLI_ENTRY, "status", "--watch", "--watch-interval", "50"], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Wait until the first line lands, then SIGINT.
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("timed out waiting for first render")),
        5_000,
      );
      proc.stdout.on("data", () => {
        clearTimeout(timeout);
        resolve();
      });
      proc.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    proc.kill("SIGINT");

    const code = await new Promise<number | null>((resolve) => {
      proc.on("exit", (c) => resolve(c));
    });

    expect(code).toBe(1);
  }, 15_000);
});
