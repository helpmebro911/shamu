/**
 * `validateShellCommand` — shell AST gate.
 *
 * Per PLAN.md § Security (G5): shell-gate patterns MUST match against a
 * parsed shell AST, not raw command strings. Commands containing `$()`,
 * backticks, `eval`, pipes-to-shell, process substitution, or other
 * meta-language escape hatches are rejected unless the caller's policy has
 * explicitly allow-listed them.
 *
 * We parse with `shell-quote`. The library yields a flat array mixing string
 * tokens (literal argv entries) with `{op: string}` objects (pipes, redirects,
 * substitution boundaries, etc.). We walk that array twice:
 *
 * 1. **Structural pass** looks for meta-structure the policy rejects outright
 *    — command substitution, process substitution, backticks, unknown
 *    operators.
 * 2. **Semantic pass** walks segment-by-segment (splitting on `;`, `&&`,
 *    `||`, `|`) and evaluates each segment's head command against the
 *    policy's allow/deny lists. A segment whose head is `bash`/`sh`/`zsh`/
 *    `eval` after a `|` is a "pipe-to-shell" — the classic `curl … | bash`
 *    exfil primitive.
 *
 * The default policy is intentionally conservative: explicit allow-list only
 * for simple read-only tooling (`ls`, `cat`, `grep`, `rg`, `find`, `git
 * <subcommand>`, `head`, `tail`, `wc`) when piped between each other.
 * Adapters typically override with their own policy derived from the run's
 * `allowedTools`.
 */

import { err, ok, type Result } from "@shamu/shared/result";
import { parse as shellParse } from "shell-quote";
import { ShellGateError } from "./errors.ts";

export type { ShellGateError };

/** A single token in the parsed command. */
export type ShellToken = string | ShellOperator | ShellGlob | ShellCommentOrEnv;

interface ShellOperator {
  readonly op: string;
}
interface ShellGlob {
  readonly pattern: string;
}
interface ShellCommentOrEnv {
  readonly comment?: string;
}

export interface ShellGatePolicy {
  /**
   * Allow-list for command heads. If empty, the gate permits any command
   * head whose structure passes the rest of the rules. If non-empty, only
   * commands whose head token exactly matches an entry in this list are
   * permitted.
   *
   * The comparison is case-sensitive and does not resolve PATH — `ls` and
   * `/bin/ls` are distinct entries. Adapters whose vendor SDK resolves
   * PATH upstream should pass both variants or normalize first.
   */
  readonly allowCommands?: readonly string[];
  /**
   * Deny-list for command heads. Takes precedence over `allowCommands`.
   * Used primarily to block `rm`, `curl`, `wget`, etc. for the reviewer
   * role even when the allow-list is otherwise permissive.
   */
  readonly denyCommands?: readonly string[];
  /**
   * Permit process substitution (`<(...)` / `>(...)`). Default false.
   * Enable only for roles that truly need it; it's a common exfil channel.
   */
  readonly allowProcessSubstitution?: boolean;
  /**
   * Permit command substitution (`$()` and backticks). Default false.
   * Extremely rare case for an agent-facing role; documenting why it's
   * enabled should accompany any `true`.
   */
  readonly allowCommandSubstitution?: boolean;
  /**
   * Permit a pipe whose right-hand-side head is `bash`/`sh`/`zsh`/`fish`/
   * `dash`/`ksh`/`eval` etc. Default false.
   */
  readonly allowPipeToShell?: boolean;
}

/**
 * The default policy: reject all the known escape hatches. No allow-list
 * (so any command head passes the semantic pass) and no deny-list. This is
 * the "structure gate only" — policies that want semantic gating override.
 */
export const DEFAULT_POLICY: ShellGatePolicy = Object.freeze({
  allowCommands: [],
  denyCommands: [],
  allowProcessSubstitution: false,
  allowCommandSubstitution: false,
  allowPipeToShell: false,
});

/** Binaries that count as "a shell" for pipe-to-shell detection. */
const SHELL_BINARIES: ReadonlySet<string> = new Set([
  "bash",
  "sh",
  "zsh",
  "fish",
  "dash",
  "ksh",
  "csh",
  "tcsh",
  "eval",
  "/bin/bash",
  "/bin/sh",
  "/bin/zsh",
  "/usr/bin/bash",
  "/usr/bin/sh",
  "/usr/bin/zsh",
  "/usr/bin/env",
  "/bin/env",
]);

export interface ParsedCommand {
  /** The raw `shell-quote` parse result. Exposed for advanced callers. */
  readonly tokens: readonly ShellToken[];
  /**
   * The semantic "pipeline segments": each outer element is a sequenced
   * command (split on `;`, `&&`, `||`), and each inner element is a pipe
   * stage within that command. The head is `segments[i][j][0]` when it's a
   * string; an inner stage whose head is missing/non-string is invalid.
   */
  readonly segments: ReadonlyArray<ReadonlyArray<readonly ShellToken[]>>;
}

function isOperator(tok: ShellToken): tok is ShellOperator {
  return (
    typeof tok === "object" &&
    tok !== null &&
    "op" in tok &&
    typeof (tok as { op: unknown }).op === "string"
  );
}

/** Parse with shell-quote, casting its output to our refined token type. */
function parseTokens(cmd: string): ShellToken[] {
  // `parse` accepts an optional env function; we pass `{}` so unknown `$VAR`
  // expansions resolve to empty rather than being left as sentinel objects.
  return shellParse(cmd, {}) as ShellToken[];
}

/**
 * Walk the flat token stream and split on top-level `;`, `&&`, `||` to get
 * sequenced commands, then on `|` to get pipe stages. Redirects (`>`, `<`,
 * `>>`, `2>&1`, etc.) stay inside their stage.
 *
 * If the stream contains unbalanced structure (e.g., a lone `)` with no
 * matching `(`), the split will still happen but the downstream rule-checks
 * will reject it. We do not try to repair invalid input.
 */
function splitSegments(tokens: readonly ShellToken[]): ShellToken[][][] {
  const segments: ShellToken[][][] = [];
  let currentSegment: ShellToken[][] = [];
  let currentStage: ShellToken[] = [];

  const pushStage = (): void => {
    if (currentStage.length > 0) {
      currentSegment.push(currentStage);
      currentStage = [];
    }
  };
  const pushSegment = (): void => {
    pushStage();
    if (currentSegment.length > 0) {
      segments.push(currentSegment);
      currentSegment = [];
    }
  };

  for (const tok of tokens) {
    if (isOperator(tok)) {
      if (tok.op === ";" || tok.op === "&&" || tok.op === "||" || tok.op === "&") {
        pushSegment();
        continue;
      }
      if (tok.op === "|") {
        pushStage();
        continue;
      }
    }
    currentStage.push(tok);
  }
  pushSegment();
  return segments;
}

function detectSubstitutionViolation(
  tokens: readonly ShellToken[],
  policy: ShellGatePolicy,
): ShellGateError | null {
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i] as ShellToken;

    // Backticks survive shell-quote as a bare string token starting with `` ` ``.
    if (typeof tok === "string" && tok.includes("`")) {
      if (policy.allowCommandSubstitution) continue;
      return new ShellGateError("backticks", tok);
    }

    // Command substitution (`$(x)`) shows up two ways:
    // 1. Bare `$` string followed by `{op: "("}` operator. Shell-quote splits
    //    the leading `$` when it's separated by a space; inside a word
    //    boundary the entire `$(...)` literal is preserved as one string.
    // 2. Literal `"$(x)"` inside a double-quoted string passes through as a
    //    single string token containing `$(`.
    if (typeof tok === "string" && tok.includes("$(")) {
      if (policy.allowCommandSubstitution) continue;
      return new ShellGateError("command_substitution", tok);
    }
    if (
      typeof tok === "string" &&
      tok.endsWith("$") &&
      isOperator(tokens[i + 1] as ShellToken) &&
      (tokens[i + 1] as ShellOperator).op === "("
    ) {
      if (policy.allowCommandSubstitution) continue;
      return new ShellGateError("command_substitution", `${tok}(`);
    }

    // Process substitution — `<(...)` and `>(...)` — surface as operator
    // tokens with `op: "<("` / `op: ">("`.
    if (isOperator(tok) && (tok.op === "<(" || tok.op === ">(")) {
      if (policy.allowProcessSubstitution) continue;
      return new ShellGateError("process_substitution", tok.op);
    }

    // `>( … )` can also show as `{op: ">"}` followed by `{op: "("}` depending
    // on whitespace. Detect that pair too.
    if (
      isOperator(tok) &&
      (tok.op === ">" || tok.op === "<") &&
      isOperator(tokens[i + 1] as ShellToken) &&
      (tokens[i + 1] as ShellOperator).op === "("
    ) {
      if (policy.allowProcessSubstitution) continue;
      return new ShellGateError("process_substitution", `${tok.op}(`);
    }
  }
  return null;
}

function headOfStage(stage: readonly ShellToken[]): string | null {
  for (const tok of stage) {
    if (typeof tok === "string" && tok.length > 0) return tok;
    if (typeof tok === "object" && tok !== null && "pattern" in tok) {
      return (tok as ShellGlob).pattern;
    }
    // Operators before the head = malformed; skip and let caller judge.
  }
  return null;
}

function checkPolicy(
  segments: ReadonlyArray<ReadonlyArray<readonly ShellToken[]>>,
  policy: ShellGatePolicy,
): ShellGateError | null {
  const deny = new Set(policy.denyCommands ?? []);
  const allow = new Set(policy.allowCommands ?? []);

  for (const segment of segments) {
    for (let stageIndex = 0; stageIndex < segment.length; stageIndex++) {
      const stage = segment[stageIndex];
      if (!stage) continue;
      const head = headOfStage(stage);
      if (head === null) {
        return new ShellGateError("empty_command", "", "pipeline stage has no command head");
      }
      // Pipe-to-shell: any stage after the first whose head is a shell.
      if (stageIndex > 0 && SHELL_BINARIES.has(head)) {
        if (!policy.allowPipeToShell) {
          return new ShellGateError("pipe_to_shell", head);
        }
      }
      // Explicit deny wins.
      if (deny.has(head)) {
        return new ShellGateError("denied_command", head);
      }
      // Direct `eval` invocation is a reject regardless of stage.
      if (head === "eval") {
        // `allowPipeToShell` also unlocks eval-as-head for consistency
        // (a caller who's enabled pipe-to-shell is by definition OK with
        // arbitrary shell, at which point eval is a lesser concern).
        if (!policy.allowPipeToShell) {
          return new ShellGateError("eval_invoked", head);
        }
      }
      // Shell invocation with `-c` is effectively a subshell of arbitrary
      // code — treat like pipe-to-shell.
      if (SHELL_BINARIES.has(head) && stage.some((t) => t === "-c")) {
        if (!policy.allowPipeToShell) {
          return new ShellGateError("shell_invocation", head);
        }
      }
      // If an explicit allow-list was provided, `head` must be on it.
      if (allow.size > 0 && !allow.has(head)) {
        return new ShellGateError(
          "denied_command",
          head,
          `head ${head} not in policy.allowCommands`,
        );
      }
    }
  }
  return null;
}

/**
 * Validate `cmd` against `policy`. Returns a `ParsedCommand` on accept and a
 * `ShellGateError` describing the specific reject reason on failure.
 *
 * Callers MUST NOT pass the original command string to a shell after this
 * function returns — the returned `segments` are the gated plan; executing
 * via `Bun.spawn`/`execFile` with argv = `segments[0][0]` is the intended
 * call pattern.
 */
export function validateShellCommand(
  cmd: string,
  policy: ShellGatePolicy = DEFAULT_POLICY,
): Result<ParsedCommand, ShellGateError> {
  if (typeof cmd !== "string" || cmd.trim().length === 0) {
    return err(new ShellGateError("empty_command", cmd, "command is empty"));
  }
  let tokens: ShellToken[];
  try {
    tokens = parseTokens(cmd);
  } catch (cause) {
    return err(
      new ShellGateError(
        "parse_failure",
        cmd,
        cause instanceof Error ? cause.message : String(cause),
      ),
    );
  }
  if (tokens.length === 0) {
    return err(new ShellGateError("empty_command", cmd));
  }
  const structural = detectSubstitutionViolation(tokens, policy);
  if (structural) return err(structural);

  const segments = splitSegments(tokens);
  const semantic = checkPolicy(segments, policy);
  if (semantic) return err(semantic);

  return ok({ tokens, segments });
}
