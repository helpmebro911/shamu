/**
 * Adapter error taxonomy.
 *
 * Every error class extends `ShamuError` from `@shamu/shared` so the CLI's
 * code→exit-status mapping still fires, and so downstream sinks (logger,
 * dashboard, Linear) can discriminate on the stable `.code` string.
 *
 * Add new error classes here rather than throwing bare `Error`s. The contract
 * suite assumes adapters surface typed errors in the `error` event kind.
 */

import { ShamuError } from "@shamu/shared/errors";

export abstract class AdapterError extends ShamuError {}

/** Thrown by `validatePathInWorktree` for every path-scope rejection. */
export class PathScopeError extends AdapterError {
  public readonly code = "path_scope_violation" as const;
  public readonly reason:
    | "absolute_outside_worktree"
    | "parent_traversal_escapes_worktree"
    | "symlink_escapes_worktree"
    | "not_under_worktree"
    | "worktree_root_invalid";
  public readonly attemptedPath: string;
  public readonly worktreeRoot: string;

  constructor(
    reason: PathScopeError["reason"],
    attemptedPath: string,
    worktreeRoot: string,
    cause?: unknown,
  ) {
    super(
      `Path ${JSON.stringify(attemptedPath)} is not within worktree ${worktreeRoot}: ${reason}`,
      cause,
    );
    this.reason = reason;
    this.attemptedPath = attemptedPath;
    this.worktreeRoot = worktreeRoot;
  }
}

/** Thrown by `validateShellCommand` on a policy violation. */
export class ShellGateError extends AdapterError {
  public readonly code = "shell_gate_violation" as const;
  public readonly reason:
    | "command_substitution"
    | "backticks"
    | "process_substitution"
    | "eval_invoked"
    | "pipe_to_shell"
    | "shell_invocation"
    | "unknown_operator"
    | "empty_command"
    | "denied_command"
    | "parse_failure";
  public readonly offendingToken: string;

  constructor(reason: ShellGateError["reason"], offendingToken: string, detail?: string) {
    super(
      `Shell command rejected (${reason})${detail ? `: ${detail}` : ""}; offending token: ${JSON.stringify(offendingToken)}`,
    );
    this.reason = reason;
    this.offendingToken = offendingToken;
  }
}

/** Generic spawn failure: binary not found, permission denied, etc. */
export class SpawnError extends AdapterError {
  public readonly code = "adapter_spawn_failed" as const;
}

/** Raised when a subprocess write happens after the handle has been closed. */
export class SubprocessClosedError extends AdapterError {
  public readonly code = "adapter_subprocess_closed" as const;
}

/**
 * Raised by the contract suite's `AdapterUnderTest.factory` wrapper when an
 * adapter rejects a capability it has declared as supported.
 */
export class ContractViolationError extends AdapterError {
  public readonly code = "adapter_contract_violation" as const;
}
