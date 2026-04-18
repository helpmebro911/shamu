/**
 * Codex adapter auth strategy resolution.
 *
 * Per PLAN.md § Security and Phase 0.B findings, Codex has two viable auth
 * paths:
 *
 * 1. **ChatGPT-OAuth via a pre-authenticated CLI** (`SpawnOpts.vendorCliPath`).
 *    The SDK spawns that binary with `codexPathOverride`; the CLI reads its
 *    own `~/.codex/auth.json` and talks to the ChatGPT subscription. No env
 *    var is consulted, and we MUST NOT forward `CODEX_API_KEY` in this path
 *    — that would coerce the CLI into API-billing mode even though the user
 *    is signed in via ChatGPT.
 *
 * 2. **`CODEX_API_KEY` env var.** Default for CI / headless runs. The adapter
 *    passes the key verbatim to the SDK's `Codex({ apiKey })` option — the
 *    SDK then sets `CODEX_API_KEY` on the spawned CLI's environment and the
 *    CLI authenticates API-mode.
 *
 * **Precedence.** A caller who supplies `vendorCliPath` is declaring "I have
 * a pre-authenticated CLI; use it." We honor that and deliberately ignore a
 * coexisting `CODEX_API_KEY` so the user doesn't get silently upgraded onto
 * API billing. If neither is present we throw a typed `ShamuError` with
 * code `adapter_auth_missing` — loud, recoverable, mapped to a known CLI
 * exit status.
 */

import { ShamuError } from "@shamu/shared/errors";

/** Error code surfaced when neither auth path is present. */
export const AUTH_MISSING_CODE = "adapter_auth_missing" as const;

/**
 * Raised when `resolveCodexAuth` cannot find either a `vendorCliPath` or a
 * `CODEX_API_KEY` env var. Extends `ShamuError` so the CLI's code→exit
 * mapping fires; the code is stable across versions.
 */
export class CodexAuthMissingError extends ShamuError {
  public readonly code = AUTH_MISSING_CODE;
}

/**
 * Result of resolving the Codex auth strategy.
 *
 * `path` is the selected strategy; `codexPathOverride` and `apiKey` are the
 * options to forward to `new Codex({ ... })`. At most one of the two is ever
 * populated (never both — see precedence in the module doc).
 */
export interface ResolvedCodexAuth {
  readonly path: "cli" | "api-key";
  readonly codexPathOverride?: string;
  readonly apiKey?: string;
}

/** Subset of `SpawnOpts` this resolver cares about. Trimmed for testability. */
export interface ResolveCodexAuthInput {
  readonly vendorCliPath?: string | undefined;
  /**
   * Env snapshot to probe for `CODEX_API_KEY`. Defaults to `process.env` at
   * call time. Injected here so unit tests don't mutate global state.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Resolve the auth strategy from `SpawnOpts` + env.
 *
 * Precedence: `vendorCliPath` > `CODEX_API_KEY`. When both are present the
 * CLI path wins and the env var is ignored — this matches the 0.B finding
 * that a pre-authenticated CLI should not be coerced onto API billing.
 *
 * Throws `CodexAuthMissingError` when neither is present; the CLI surfaces
 * the code as a non-zero exit. Callers catch and convert to an `error`
 * event if the run has already begun, or let it bubble from `spawn()`.
 */
export function resolveCodexAuth(opts: ResolveCodexAuthInput): ResolvedCodexAuth {
  const env = opts.env ?? (process.env as Record<string, string | undefined>);
  if (typeof opts.vendorCliPath === "string" && opts.vendorCliPath.length > 0) {
    return { path: "cli", codexPathOverride: opts.vendorCliPath };
  }
  const apiKey = env.CODEX_API_KEY;
  if (typeof apiKey === "string" && apiKey.length > 0) {
    return { path: "api-key", apiKey };
  }
  throw new CodexAuthMissingError(
    "Codex adapter requires either SpawnOpts.vendorCliPath (ChatGPT-OAuth CLI) " +
      "or a non-empty CODEX_API_KEY env var; neither was provided.",
  );
}
