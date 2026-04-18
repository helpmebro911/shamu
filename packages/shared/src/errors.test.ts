import { describe, expect, it } from "vitest";
import {
  AuditChainError,
  ConfigError,
  CredentialError,
  PersistenceError,
  RedactorError,
  ShamuError,
  UnsupportedPlatformError,
} from "./errors.ts";

describe("error taxonomy", () => {
  it("every subclass has a stable code string", () => {
    const pairs: Array<[new (msg: string) => ShamuError, string]> = [
      [ConfigError, "config_error"],
      [CredentialError, "credential_error"],
      [PersistenceError, "persistence_error"],
      [AuditChainError, "audit_chain_error"],
      [RedactorError, "redactor_error"],
      [UnsupportedPlatformError, "unsupported_platform"],
    ];
    for (const [Cls, code] of pairs) {
      const e = new Cls("boom");
      expect(e).toBeInstanceOf(ShamuError);
      expect(e).toBeInstanceOf(Error);
      expect(e.code).toBe(code);
      expect(e.name).toBe(Cls.name);
      expect(e.message).toBe("boom");
    }
  });

  it("captures optional cause", () => {
    const cause = new Error("underlying");
    const e = new ConfigError("outer", cause);
    expect(e.cause).toBe(cause);
  });

  it("AuditChainError carries rowSeq", () => {
    const e = new AuditChainError("bad row", 42);
    expect(e.rowSeq).toBe(42);
  });
});
