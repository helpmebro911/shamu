// Bridges Claude's `canUseTool` callback to shamu's path-scope + shell-gate.
// Every tool call goes through here BEFORE the SDK dispatches — path
// violations (G4) and shell AST violations (G5) are rejected with
// `behavior: "deny"` rather than allowed through.
//
// Claude tool-name conventions we know about:
//   - `Read`, `Edit`, `Write`, `Glob`, `NotebookEdit` — file-path tools.
//     Path is in `tool_input.file_path` (Read/Edit/Write/NotebookEdit) or
//     `tool_input.path` (Glob — actually a pattern but may include absolute
//     roots).
//   - `Bash` — shell command. Command text is in `tool_input.command`.
//   - `Grep` — has `path` for search-root; we treat it as a read path.
//   - MCP tools: `mcp:<server>.<tool>`. We let those through unchanged;
//     trust model is G3 (in-process MCP is trusted, stdio/http is pinned).
//
// Decisions are `allow` (pass-through) or `deny` (with message). We never
// `ask` — the orchestrator is driving, there's no interactive human.

import type { PathScopeError } from "@shamu/adapters-base/path-scope";
import { validatePathInWorktree } from "@shamu/adapters-base/path-scope";
import type { ShellGateError, ShellGatePolicy } from "@shamu/adapters-base/shell-gate";
import { DEFAULT_POLICY, validateShellCommand } from "@shamu/adapters-base/shell-gate";

/** Permission decision shape — mirrors the SDK's `PermissionResult` literal. */
export type PermissionDecision =
  | { readonly behavior: "allow"; readonly updatedInput?: Record<string, unknown> }
  | { readonly behavior: "deny"; readonly message: string; readonly interrupt?: boolean };

export interface PermissionHandlerOptions {
  /** Absolute worktree root; every filesystem path is scoped to this. */
  readonly worktreeRoot: string;
  /**
   * Shell-gate policy for `Bash` tool calls. Defaults to the base
   * package's DEFAULT_POLICY — structural reject-list only, no allow-list.
   */
  readonly shellPolicy?: ShellGatePolicy;
  /**
   * Optional hook — called on every decision (allow or deny). Used by the
   * handle to emit `permission_request` events so watchers see the trail.
   */
  readonly onDecision?: (
    toolName: string,
    input: Record<string, unknown>,
    decision: PermissionDecision,
  ) => void;
}

/** Tool names whose `tool_input` carries one or more worktree paths. */
const PATH_FIELD_BY_TOOL: Readonly<Record<string, readonly string[]>> = Object.freeze({
  Read: ["file_path"],
  Edit: ["file_path"],
  Write: ["file_path"],
  NotebookEdit: ["notebook_path"],
  MultiEdit: ["file_path"],
  Grep: ["path"],
  Glob: ["path"],
});

/**
 * Resolve the worktree-scoped path fields for a known tool. Unknown tools
 * return an empty array — they go through unchecked (MCP tools, built-ins
 * with no filesystem side effect like `WebFetch`).
 */
function pathFieldsFor(toolName: string): readonly string[] {
  return PATH_FIELD_BY_TOOL[toolName] ?? [];
}

function stringField(input: Record<string, unknown>, key: string): string | null {
  const v = input[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

function pathDenyMessage(field: string, err: PathScopeError): string {
  return `path ${JSON.stringify(err.attemptedPath)} in ${field} rejected: ${err.reason}`;
}

function shellDenyMessage(err: ShellGateError): string {
  return `bash command rejected (${err.reason}): ${err.offendingToken}`;
}

/**
 * Build a Claude-compatible permission handler closure. The returned
 * function matches the shape of `canUseTool` (the SDK's types reject an
 * AbortSignal we don't use, so we accept a loosely-typed signature and the
 * SDK narrows it at call time).
 *
 * The handler is pure relative to its options — no hidden mutable state.
 */
export function createPermissionHandler(
  opts: PermissionHandlerOptions,
): (toolName: string, input: Record<string, unknown>) => PermissionDecision {
  const policy = opts.shellPolicy ?? DEFAULT_POLICY;
  return (toolName: string, input: Record<string, unknown>): PermissionDecision => {
    // Bash — AST gate first.
    if (toolName === "Bash") {
      const cmd = stringField(input, "command");
      if (cmd === null) {
        const decision: PermissionDecision = {
          behavior: "deny",
          message: "bash command rejected: missing or empty `command` field",
        };
        opts.onDecision?.(toolName, input, decision);
        return decision;
      }
      const result = validateShellCommand(cmd, policy);
      if (!result.ok) {
        const decision: PermissionDecision = {
          behavior: "deny",
          message: shellDenyMessage(result.error),
        };
        opts.onDecision?.(toolName, input, decision);
        return decision;
      }
      const allow: PermissionDecision = { behavior: "allow" };
      opts.onDecision?.(toolName, input, allow);
      return allow;
    }

    // Filesystem tools — path-scope gate per relevant field.
    const fields = pathFieldsFor(toolName);
    for (const field of fields) {
      const candidate = stringField(input, field);
      if (candidate === null) continue;
      const result = validatePathInWorktree(opts.worktreeRoot, candidate);
      if (!result.ok) {
        const decision: PermissionDecision = {
          behavior: "deny",
          message: pathDenyMessage(field, result.error),
        };
        opts.onDecision?.(toolName, input, decision);
        return decision;
      }
    }

    // Unknown tool or no scoped fields — allow through.
    const allow: PermissionDecision = { behavior: "allow" };
    opts.onDecision?.(toolName, input, allow);
    return allow;
  };
}
