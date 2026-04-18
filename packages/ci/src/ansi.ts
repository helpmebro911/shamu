/**
 * Strip ANSI SGR + common CSI escapes.
 *
 * agent-ci's own output is mostly plain (it drives no pty), but wrapped tools
 * (eslint, vitest, etc.) often force-colour because they detect CI. We
 * normalise before handing step logs to the extractors or the excerpt builder
 * so neither has to cope with escape codes.
 *
 * Pattern intentionally conservative: SGR (`\x1b[...m`), CSI, OSC, plus the
 * bare BEL that eslint sometimes emits.
 */
const ANSI_RE = new RegExp(
  [
    "\\x1B\\[[0-?]*[ -/]*[@-~]", // CSI
    "\\x1B\\][^\\x07]*\\x07", // OSC
    "\\x1B[@-Z\\-_]", // 2-byte escapes
    "\\x07", // bel
  ].join("|"),
  "g",
);

export function stripAnsi(input: string): string {
  return input.replace(ANSI_RE, "");
}

export function stripAnsiLines(lines: string[]): string[] {
  return lines.map(stripAnsi);
}
