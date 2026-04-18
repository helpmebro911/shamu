/**
 * Linear API-key resolver.
 *
 * Resolution order:
 *   1. `env.LINEAR_API_KEY` (caller-supplied env object; the app wires
 *      `process.env` → here, so library code never reads env directly).
 *   2. `@shamu/shared/credentials` store under the (service, account) pair
 *      declared in `LINEAR_CREDENTIAL_SERVICE` / `LINEAR_CREDENTIAL_ACCOUNT`.
 *
 * Side-effect: when the env path succeeds AND the store didn't already have a
 * value (or had a different value), we persist the env-sourced key back into
 * the store so subsequent runs don't need the env var. Persistence failures
 * are logged (via the injected `log` hook) but never fatal — an env-supplied
 * key is a valid resolution on its own.
 *
 * Errors are returned via `Result<T, LinearAuthError>` — callers never catch.
 * The discriminant on `LinearAuthError.reason` drives the Phase 6 onboarding
 * flow: `missing` → prompt; `credential_store_failed` → surface; `invalid_format`
 * → reject with operator guidance.
 */

import type { CredentialStore } from "@shamu/shared/credentials";
import { createCredentialStore } from "@shamu/shared/credentials";
import type { Result } from "@shamu/shared/result";
import { err, ok } from "@shamu/shared/result";
import { LinearAuthError } from "./errors.ts";

/** Credential-store coordinates. Stable; don't change after users have keys. */
export const LINEAR_CREDENTIAL_SERVICE = "shamu" as const;
export const LINEAR_CREDENTIAL_ACCOUNT = "linear-api-key" as const;

export interface ResolveLinearApiKeyOptions {
  /**
   * Environment object. The app wires `process.env` → here explicitly; the
   * library never reads `process.env` on its own (so tests can inject freely).
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /**
   * Credential store instance. Defaults to the OS-appropriate backend via
   * `createCredentialStore()`. Tests inject an `InMemoryStore`.
   */
  readonly store?: CredentialStore;
  /**
   * Logger hook. Used ONLY for non-fatal persistence failures (env path
   * succeeded but we couldn't write the key back). Defaults to `console.warn`.
   */
  readonly log?: (message: string, meta?: Record<string, unknown>) => void;
}

export interface ResolvedLinearApiKey {
  readonly apiKey: string;
  readonly source: "env" | "credential_store";
  /**
   * True when the env path succeeded AND the key was written back to the
   * store in this call. Consumers don't usually need this; it exists for
   * observability + tests.
   */
  readonly persisted: boolean;
}

function sanitize(key: string | null | undefined): string | null {
  if (typeof key !== "string") return null;
  const trimmed = key.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function defaultLog(message: string, meta?: Record<string, unknown>): void {
  if (meta) {
    console.warn(`[shamu/linear-client] ${message}`, meta);
  } else {
    console.warn(`[shamu/linear-client] ${message}`);
  }
}

/**
 * Resolve Linear's API key from the environment (preferred) or the
 * credential store (fallback). See module doc for order + side-effects.
 */
export async function resolveLinearApiKey(
  options: ResolveLinearApiKeyOptions = {},
): Promise<Result<ResolvedLinearApiKey, LinearAuthError>> {
  const log = options.log ?? defaultLog;

  // 1. Env path.
  const rawEnv = options.env?.LINEAR_API_KEY;
  if (rawEnv !== undefined) {
    const sanitized = sanitize(rawEnv);
    if (sanitized === null) {
      return err(
        new LinearAuthError(
          "invalid_format",
          "LINEAR_API_KEY was set but empty or whitespace-only",
        ),
      );
    }
    // Best-effort persist-back. Don't fail the caller on store errors.
    let store: CredentialStore;
    try {
      store = options.store ?? createCredentialStore();
    } catch (cause) {
      log("credential store unavailable; continuing with env-sourced key", {
        error: cause instanceof Error ? cause.message : String(cause),
      });
      return ok({ apiKey: sanitized, source: "env", persisted: false });
    }
    let persisted = false;
    try {
      const existing = await store.get(LINEAR_CREDENTIAL_SERVICE, LINEAR_CREDENTIAL_ACCOUNT);
      if (existing !== sanitized) {
        await store.set(LINEAR_CREDENTIAL_SERVICE, LINEAR_CREDENTIAL_ACCOUNT, sanitized);
        persisted = true;
      }
    } catch (cause) {
      log("failed to persist LINEAR_API_KEY to credential store; continuing", {
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
    return ok({ apiKey: sanitized, source: "env", persisted });
  }

  // 2. Credential-store path.
  let store: CredentialStore;
  try {
    store = options.store ?? createCredentialStore();
  } catch (cause) {
    return err(
      new LinearAuthError(
        "credential_store_failed",
        "Could not initialise credential store",
        cause,
      ),
    );
  }
  let stored: string | null;
  try {
    stored = await store.get(LINEAR_CREDENTIAL_SERVICE, LINEAR_CREDENTIAL_ACCOUNT);
  } catch (cause) {
    return err(
      new LinearAuthError("credential_store_failed", "Credential store lookup failed", cause),
    );
  }
  const sanitized = sanitize(stored);
  if (sanitized === null) {
    return err(
      new LinearAuthError(
        "missing",
        "No LINEAR_API_KEY in env and no persisted key in the credential store",
      ),
    );
  }
  return ok({ apiKey: sanitized, source: "credential_store", persisted: false });
}
