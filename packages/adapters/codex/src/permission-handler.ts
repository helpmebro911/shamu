/**
 * Pre-dispatch permission handler for Codex tool calls.
 *
 * Codex's SDK runs its tools inside the spawned CLI; the adapter can't
 * interpose directly the way Claude's `canUseTool` callback does. What we
 * CAN do is inspect every `item.started` event BEFORE forwarding it to the
 * handle's consumer, and raise a `PathScopeError` / `ShellGateError` when
 * the declared tool intent would violate policy. The adapter then issues
 * an `interrupt()` on the live turn so the CLI aborts before the side
 * effect lands.
 *
 * This module is the *decision* surface; emission of the typed error event
 * + abort is wired in `handle.ts`. Splitting them keeps the policy
 * decisions unit-testable (no SDK instance needed).
 *
 * Rationale for running pre-dispatch rather than pre-commit:
 *   PLAN.md § Security (G4/G5) requires the gate at tool-dispatch time. A
 *   pre-commit hook is defense-in-depth only — by the time the CLI has
 *   already written a file outside the worktree or executed a shell
 *   substitution we've already lost the security property.
 *
 * Codex `shell` items include the raw command string. Codex `apply_patch`
 * items include a list of `{path, kind}` entries. Both map cleanly onto
 * the base package's `validatePathInWorktree` + `validateShellCommand`.
 */

import type { CommandExecutionItem, FileChangeItem, ThreadItem } from "@openai/codex-sdk";
import {
  type AbsPath,
  type PathScopeError,
  type ShellGateError,
  type ShellGatePolicy,
  validatePathInWorktree,
  validateShellCommand,
} from "@shamu/adapters-base";

/** Result of a policy decision. One of `allowed`, `denied`. */
export type PermissionDecision =
  | { readonly kind: "allowed" }
  | { readonly kind: "denied"; readonly error: PathScopeError | ShellGateError };

/** Options controlling the gate. */
export interface PermissionHandlerOptions {
  /** Absolute path to the run's git worktree. Required. */
  readonly worktreeRoot: string;
  /**
   * Shell gate policy. Omit for the base package's conservative default:
   * structure-only gate, no allow-list, rejects $() / backticks / eval /
   * pipe-to-shell / process substitution.
   */
  readonly shellPolicy?: ShellGatePolicy;
}

/**
 * Validate a `command_execution` item before the CLI runs it.
 *
 * The input is the raw SDK item; we feed its `command` string through
 * `validateShellCommand`. A denied result carries the structural reason
 * (`command_substitution`, `pipe_to_shell`, etc.); callers convert to an
 * `error` event and abort the turn.
 */
export function checkCommandExecution(
  item: CommandExecutionItem,
  options: PermissionHandlerOptions,
): PermissionDecision {
  const command = item.command ?? "";
  const result = validateShellCommand(command, options.shellPolicy);
  if (!result.ok) {
    return { kind: "denied", error: result.error };
  }
  return { kind: "allowed" };
}

/**
 * Validate a `file_change` item. Every `{path}` in `changes` must resolve
 * under `worktreeRoot` after symlink resolution. The first violation wins
 * — we don't report all of them, because the CLI stops on the first deny
 * anyway.
 *
 * Returns `{ kind: "allowed", resolvedPaths }` so callers can log the
 * canonical resolved path set alongside the attempt.
 */
export function checkFileChange(
  item: FileChangeItem,
  options: PermissionHandlerOptions,
): PermissionDecision | { readonly kind: "allowed"; readonly resolvedPaths: readonly AbsPath[] } {
  const resolved: AbsPath[] = [];
  for (const change of item.changes ?? []) {
    const r = validatePathInWorktree(options.worktreeRoot, change.path);
    if (!r.ok) return { kind: "denied", error: r.error };
    resolved.push(r.value);
  }
  return { kind: "allowed", resolvedPaths: resolved };
}

/**
 * Dispatch on item kind. Items that aren't file-scope or shell-scope are
 * auto-allowed (MCP tools, web search, reasoning, agent_message, etc.) —
 * those have their own security story (MCP server allow-listing lives at
 * the `codex` CLI config layer; web search + reasoning are non-mutating).
 *
 * Returns `null` for kinds with no policy decision — caller treats that
 * as "no-op, forward the event normally."
 */
export function decidePermission(
  item: ThreadItem,
  options: PermissionHandlerOptions,
): PermissionDecision | null {
  switch (item.type) {
    case "command_execution":
      return checkCommandExecution(item, options);
    case "file_change":
      return checkFileChange(item, options);
    case "mcp_tool_call":
    case "web_search":
    case "agent_message":
    case "reasoning":
    case "todo_list":
    case "error":
      return null;
    default: {
      const exhaustive: never = item;
      return exhaustive;
    }
  }
}
