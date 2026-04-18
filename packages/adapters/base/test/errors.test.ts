import { ShamuError } from "@shamu/shared/errors";
import { describe, expect, it } from "vitest";
import {
  type AdapterError,
  ContractViolationError,
  PathScopeError,
  ShellGateError,
  SpawnError,
  SubprocessClosedError,
} from "../src/errors.ts";

describe("error taxonomy", () => {
  it("every adapter error extends ShamuError and carries a stable code", () => {
    const cases: AdapterError[] = [
      new PathScopeError("absolute_outside_worktree", "/etc/passwd", "/wt"),
      new ShellGateError("command_substitution", "$(x)"),
      new SpawnError("failed"),
      new SubprocessClosedError("closed"),
      new ContractViolationError("nope"),
    ];
    for (const e of cases) {
      expect(e instanceof ShamuError).toBe(true);
      expect(typeof e.code).toBe("string");
      expect(e.code.length).toBeGreaterThan(0);
    }
  });

  it("PathScopeError surfaces its reason + path", () => {
    const e = new PathScopeError("symlink_escapes_worktree", "esc", "/wt");
    expect(e.reason).toBe("symlink_escapes_worktree");
    expect(e.attemptedPath).toBe("esc");
    expect(e.worktreeRoot).toBe("/wt");
  });

  it("ShellGateError surfaces its reason + offending token", () => {
    const e = new ShellGateError("backticks", "`evil`");
    expect(e.reason).toBe("backticks");
    expect(e.offendingToken).toBe("`evil`");
  });
});
