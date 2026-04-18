/**
 * Error taxonomy.
 *
 * Each class carries a stable `code` string — the CLI maps codes to exit
 * statuses, the dashboard maps them to badges, Linear comments map them to
 * labels. Don't change codes after the fact; add new ones.
 */

export abstract class ShamuError extends Error {
  public abstract readonly code: string;
  public override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = this.constructor.name;
    if (cause !== undefined) this.cause = cause;
  }
}

export class ConfigError extends ShamuError {
  public readonly code = "config_error" as const;
}

export class CredentialError extends ShamuError {
  public readonly code = "credential_error" as const;
}

export class PersistenceError extends ShamuError {
  public readonly code = "persistence_error" as const;
}

export class AuditChainError extends ShamuError {
  public readonly code = "audit_chain_error" as const;
  public readonly rowSeq?: number;

  constructor(message: string, rowSeq?: number, cause?: unknown) {
    super(message, cause);
    if (rowSeq !== undefined) this.rowSeq = rowSeq;
  }
}

export class RedactorError extends ShamuError {
  public readonly code = "redactor_error" as const;
}

export class UnsupportedPlatformError extends ShamuError {
  public readonly code = "unsupported_platform" as const;
}
