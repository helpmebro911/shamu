/**
 * Auth resolution unit tests.
 *
 * Verifies precedence: `vendorCliPath` > `CODEX_API_KEY`. When both are
 * present the CLI path wins (mirrors Phase 0.B — a pre-authenticated CLI
 * should not be silently upgraded to API billing). Neither present →
 * typed error with stable code.
 */

import { describe, expect, it } from "vitest";
import { AUTH_MISSING_CODE, CodexAuthMissingError, resolveCodexAuth } from "../../src/auth.ts";

describe("resolveCodexAuth", () => {
  it("prefers vendorCliPath when supplied", () => {
    const result = resolveCodexAuth({
      vendorCliPath: "/usr/local/bin/codex",
      env: {},
    });
    expect(result.path).toBe("cli");
    expect(result.codexPathOverride).toBe("/usr/local/bin/codex");
    expect(result.apiKey).toBeUndefined();
  });

  it("uses CODEX_API_KEY when vendorCliPath is absent", () => {
    const result = resolveCodexAuth({
      env: { CODEX_API_KEY: "sk-codex-test-key" },
    });
    expect(result.path).toBe("api-key");
    expect(result.apiKey).toBe("sk-codex-test-key");
    expect(result.codexPathOverride).toBeUndefined();
  });

  it("picks CLI path when BOTH are provided (CLI takes precedence)", () => {
    const result = resolveCodexAuth({
      vendorCliPath: "/opt/homebrew/bin/codex",
      env: { CODEX_API_KEY: "sk-codex-would-be-ignored" },
    });
    expect(result.path).toBe("cli");
    expect(result.codexPathOverride).toBe("/opt/homebrew/bin/codex");
    // Critical: the API key MUST NOT leak into the SDK options in CLI mode.
    expect(result.apiKey).toBeUndefined();
  });

  it("throws CodexAuthMissingError when neither is present", () => {
    expect(() => resolveCodexAuth({ env: {} })).toThrow(CodexAuthMissingError);
  });

  it("error carries the stable adapter_auth_missing code", () => {
    try {
      resolveCodexAuth({ env: {} });
      throw new Error("expected resolveCodexAuth to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CodexAuthMissingError);
      expect((err as CodexAuthMissingError).code).toBe(AUTH_MISSING_CODE);
      expect((err as CodexAuthMissingError).code).toBe("adapter_auth_missing");
    }
  });

  it("empty-string vendorCliPath is treated as absent", () => {
    expect(() => resolveCodexAuth({ vendorCliPath: "", env: {} })).toThrow(CodexAuthMissingError);
  });

  it("empty-string CODEX_API_KEY is treated as absent", () => {
    expect(() => resolveCodexAuth({ env: { CODEX_API_KEY: "" } })).toThrow(CodexAuthMissingError);
  });
});
