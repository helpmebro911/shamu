/**
 * Credential backend abstraction.
 *
 * Per PLAN.md "Security & threat model → Credential handling": every secret
 * lives in the OS keychain. No .env, no SQLite. Backends:
 *
 *   - `KeychainStore`         macOS — shells out to `security`.
 *   - `SecretServiceStore`    Linux — shells out to `secret-tool`
 *                             (`libsecret-tools` package).
 *   - `InMemoryStore`         tests only — never touches disk.
 *
 * `createCredentialStore()` auto-detects the platform via `process.platform`.
 * Windows is explicitly unsupported (throws `UnsupportedPlatformError`).
 *
 * `set()` uses `-U` / upsert semantics so re-running onboarding is a no-op.
 * `delete()` on a missing key is a no-op (returns `ok`).
 *
 * The shell implementations never echo the secret via argv (where `ps` would
 * see it). On macOS `-w <secret>` is standard; on Linux `secret-tool store`
 * reads the secret from stdin (the only safe path).
 */

import { spawn } from "node:child_process";
import { CredentialError, UnsupportedPlatformError } from "./errors.ts";

export interface CredentialStore {
  get(service: string, account: string): Promise<string | null>;
  set(service: string, account: string, secret: string): Promise<void>;
  delete(service: string, account: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface SpawnResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runCommand(cmd: string, args: readonly string[], stdin?: string): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    const stdoutBuf: Buffer[] = [];
    const stderrBuf: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => stdoutBuf.push(d));
    child.stderr.on("data", (d: Buffer) => stderrBuf.push(d));
    child.on("error", (e) => reject(e));
    child.on("close", (code) => {
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(stdoutBuf).toString("utf8"),
        stderr: Buffer.concat(stderrBuf).toString("utf8"),
      });
    });
    if (stdin !== undefined) {
      child.stdin.write(stdin);
    }
    child.stdin.end();
  });
}

function requireNonEmpty(value: string, name: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new CredentialError(`${name} must be a non-empty string`);
  }
}

// ---------------------------------------------------------------------------
// macOS: `security`
// ---------------------------------------------------------------------------

export class KeychainStore implements CredentialStore {
  async get(service: string, account: string): Promise<string | null> {
    requireNonEmpty(service, "service");
    requireNonEmpty(account, "account");
    const res = await runCommand("security", [
      "find-generic-password",
      "-s",
      service,
      "-a",
      account,
      "-w",
    ]);
    if (res.code === 0) {
      // `security -w` prints the password followed by a newline.
      return res.stdout.endsWith("\n") ? res.stdout.slice(0, -1) : res.stdout;
    }
    // Exit 44 === "The specified item could not be found in the keychain."
    if (res.code === 44 || /could not be found/i.test(res.stderr)) {
      return null;
    }
    throw new CredentialError(
      `security find-generic-password failed (exit ${res.code}): ${res.stderr.trim()}`,
    );
  }

  async set(service: string, account: string, secret: string): Promise<void> {
    requireNonEmpty(service, "service");
    requireNonEmpty(account, "account");
    requireNonEmpty(secret, "secret");
    const res = await runCommand("security", [
      "add-generic-password",
      "-s",
      service,
      "-a",
      account,
      "-w",
      secret,
      "-U", // update if already present
    ]);
    if (res.code !== 0) {
      throw new CredentialError(
        `security add-generic-password failed (exit ${res.code}): ${res.stderr.trim()}`,
      );
    }
  }

  async delete(service: string, account: string): Promise<void> {
    requireNonEmpty(service, "service");
    requireNonEmpty(account, "account");
    const res = await runCommand("security", [
      "delete-generic-password",
      "-s",
      service,
      "-a",
      account,
    ]);
    // Missing item is a no-op.
    if (res.code === 0 || res.code === 44 || /could not be found/i.test(res.stderr)) {
      return;
    }
    throw new CredentialError(
      `security delete-generic-password failed (exit ${res.code}): ${res.stderr.trim()}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Linux: `secret-tool` (libsecret-tools)
// ---------------------------------------------------------------------------

export class SecretServiceStore implements CredentialStore {
  async get(service: string, account: string): Promise<string | null> {
    requireNonEmpty(service, "service");
    requireNonEmpty(account, "account");
    const res = await runCommand("secret-tool", ["lookup", "service", service, "account", account]);
    if (res.code === 0) {
      return res.stdout.endsWith("\n") ? res.stdout.slice(0, -1) : res.stdout;
    }
    // secret-tool exits 1 with empty stdout for "not found".
    if (res.code === 1 && res.stdout.length === 0) return null;
    throw new CredentialError(`secret-tool lookup failed (exit ${res.code}): ${res.stderr.trim()}`);
  }

  async set(service: string, account: string, secret: string): Promise<void> {
    requireNonEmpty(service, "service");
    requireNonEmpty(account, "account");
    requireNonEmpty(secret, "secret");
    // `secret-tool store` reads the secret from stdin — never from argv.
    const res = await runCommand(
      "secret-tool",
      ["store", "--label", service, "service", service, "account", account],
      secret,
    );
    if (res.code !== 0) {
      throw new CredentialError(
        `secret-tool store failed (exit ${res.code}): ${res.stderr.trim()}`,
      );
    }
  }

  async delete(service: string, account: string): Promise<void> {
    requireNonEmpty(service, "service");
    requireNonEmpty(account, "account");
    const res = await runCommand("secret-tool", ["clear", "service", service, "account", account]);
    // `secret-tool clear` exits 0 even when nothing matched, so no
    // special-case is needed.
    if (res.code !== 0) {
      throw new CredentialError(
        `secret-tool clear failed (exit ${res.code}): ${res.stderr.trim()}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Test-only: in-memory
// ---------------------------------------------------------------------------

export class InMemoryStore implements CredentialStore {
  private readonly map = new Map<string, string>();

  private key(service: string, account: string): string {
    return `${service}\u0000${account}`;
  }

  get(service: string, account: string): Promise<string | null> {
    requireNonEmpty(service, "service");
    requireNonEmpty(account, "account");
    return Promise.resolve(this.map.get(this.key(service, account)) ?? null);
  }

  set(service: string, account: string, secret: string): Promise<void> {
    requireNonEmpty(service, "service");
    requireNonEmpty(account, "account");
    requireNonEmpty(secret, "secret");
    this.map.set(this.key(service, account), secret);
    return Promise.resolve();
  }

  delete(service: string, account: string): Promise<void> {
    requireNonEmpty(service, "service");
    requireNonEmpty(account, "account");
    this.map.delete(this.key(service, account));
    return Promise.resolve();
  }

  /** Test helper. */
  size(): number {
    return this.map.size;
  }
}

// ---------------------------------------------------------------------------
// Auto-detect
// ---------------------------------------------------------------------------

export type PlatformHint = "macos" | "linux";

export function createCredentialStore(platform?: PlatformHint): CredentialStore {
  if (platform === "macos") return new KeychainStore();
  if (platform === "linux") return new SecretServiceStore();
  // Auto-detect.
  if (process.platform === "darwin") return new KeychainStore();
  if (process.platform === "linux") return new SecretServiceStore();
  throw new UnsupportedPlatformError(
    `Shamu's credential store supports macOS and Linux only (got ${process.platform}). ` +
      "Use an explicit platform hint in tests or run on a supported OS.",
  );
}
