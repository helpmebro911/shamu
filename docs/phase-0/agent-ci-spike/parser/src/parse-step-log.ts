import { stripAnsi } from "./ansi.ts";
import type { FailingTest, FailureKind } from "./types.ts";

/**
 * Classify a step by its name. This is a heuristic — agent-ci reports step
 * names verbatim from the workflow YAML, so we match on common conventions.
 * Reviewers get the raw step name regardless; this only drives the excerpt
 * layout (test-failure rendering vs lint-error rendering).
 */
export function classifyStep(stepName: string): FailureKind {
  const n = stepName.toLowerCase();
  if (/^test/.test(n) || n.includes("vitest") || n.includes("jest") || n.includes("pytest")) {
    return "test";
  }
  if (n.includes("lint") || n.includes("eslint") || n.includes("biome") || n.includes("ruff")) {
    return "lint";
  }
  if (n.includes("typecheck") || n.includes("tsc") || n.includes("mypy")) {
    return "typecheck";
  }
  if (n.includes("build") || n.includes("compile")) {
    return "build";
  }
  if (n.includes("install") || n.includes("npm ci") || n.includes("yarn")) {
    return "install";
  }
  return "unknown";
}

// ─── TAP v13 parser (node:test / tap / ava output) ────────────────────────────

/**
 * Parse TAP 13 output for failing tests. We recognise:
 *
 *   not ok N - <name>
 *     ---
 *     <yaml block>
 *     ...
 *
 * and also the Node test-runner's nested indentation. The payload lines are
 * captured verbatim (minus the leading indent), and `location`, `expected`,
 * and `actual` are lifted from the YAML if present.
 *
 * We deliberately don't pull in a TAP-parser dependency: the agent-ci
 * integration must stay free of network deps the parser package doesn't own.
 */
export function parseTapFailures(
  raw: string,
  opts: { maxErrorLinesPerTest?: number } = {},
): FailingTest[] {
  const maxLines = opts.maxErrorLinesPerTest ?? 6;
  const clean = stripAnsi(raw);
  const lines = clean.split(/\r?\n/);

  const failures: FailingTest[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const m = /^\s*not ok\s+\d+\s*-?\s*(.*)$/.exec(line);
    if (!m) continue;
    const name = (m[1] ?? "").trim();

    // Look ahead for a YAML block `---` ... `...`
    let j = i + 1;
    let yamlStart: number | null = null;
    let yamlIndent = 0;
    while (j < lines.length && j < i + 4) {
      const l = lines[j] ?? "";
      const y = /^(\s*)---\s*$/.exec(l);
      if (y) {
        yamlStart = j;
        yamlIndent = (y[1] ?? "").length;
        break;
      }
      if (/^\s*(not\s+)?ok\b/.test(l)) break;
      j++;
    }

    let location: string | null = null;
    let errorLines: string[] = [];
    let expected: string | undefined;
    let actual: string | undefined;

    if (yamlStart !== null) {
      let k = yamlStart + 1;
      const block: string[] = [];
      while (k < lines.length) {
        const l = lines[k] ?? "";
        if (/^\s*\.\.\.\s*$/.test(l)) break;
        block.push(l);
        k++;
      }

      // Determine the YAML body indent by examining the first non-blank line.
      // Node's test runner emits nested TAP with 6-space indent, but agent-ci's
      // step log flattens it to 0. Be tolerant.
      let stripIndent = yamlIndent + 2;
      const firstNonBlank = block.find((l) => l.trim().length > 0);
      if (firstNonBlank) {
        const lead = firstNonBlank.match(/^\s*/)?.[0].length ?? 0;
        if (lead < stripIndent) stripIndent = lead;
      }
      const dedented = block.map((l) => (l.length >= stripIndent ? l.slice(stripIndent) : l.trimStart()));

      for (let bi = 0; bi < dedented.length; bi++) {
        const bl = dedented[bi] ?? "";
        const loc = /^location:\s*'?([^']+?)'?\s*$/.exec(bl);
        if (loc) location = loc[1] ?? null;
        const exp = /^expected:\s*(.*)$/.exec(bl);
        if (exp) expected = stripYamlQuotes(exp[1] ?? "");
        const act = /^actual:\s*(.*)$/.exec(bl);
        if (act) actual = stripYamlQuotes(act[1] ?? "");
      }

      // Lift the `error:` block — either single-line or `|-` folded.
      errorLines = extractYamlField(dedented, "error", maxLines);

      // If no error block, fall back to first N non-YAML-key lines.
      if (errorLines.length === 0) {
        errorLines = dedented
          .filter((l) => l.trim().length > 0 && !/^[a-zA-Z_]+:\s/.test(l))
          .slice(0, maxLines);
      }

      i = k; // skip past the YAML block
    }

    failures.push({
      name: name || `unnamed test ${failures.length + 1}`,
      location,
      errorLines,
      ...(expected !== undefined ? { expected } : {}),
      ...(actual !== undefined ? { actual } : {}),
    });
  }

  // De-duplicate: Node test-runner emits both the subtest failure and its
  // parent suite failure ("subtestsFailed"). We drop the parent-suite entries
  // that look like roll-ups (error === "N subtest failed").
  return failures.filter((f) => !/^['"]?\d+ subtest(s)? failed['"]?$/.test(f.errorLines[0]?.trim() ?? ""));
}

function stripYamlQuotes(s: string): string {
  const t = s.trim();
  if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) {
    return t.slice(1, -1);
  }
  return t;
}

function extractYamlField(lines: string[], field: string, maxLines: number): string[] {
  const keyRe = new RegExp(`^${field}:\\s*(.*)$`);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] ?? "";
    const m = keyRe.exec(l);
    if (!m) continue;
    const rest = (m[1] ?? "").trim();
    if (rest.startsWith("|-") || rest.startsWith("|") || rest.startsWith(">")) {
      // Folded block — capture indented follow-on lines.
      const out: string[] = [];
      let j = i + 1;
      let blockIndent: number | null = null;
      while (j < lines.length && out.length < maxLines) {
        const bl = lines[j] ?? "";
        if (/^\s*$/.test(bl)) {
          out.push("");
          j++;
          continue;
        }
        const leading = bl.match(/^\s*/)?.[0].length ?? 0;
        if (blockIndent === null) blockIndent = leading;
        if (leading < blockIndent) break;
        if (/^\s*[a-zA-Z_]+:\s/.test(bl) && leading <= blockIndent - 2) break;
        out.push(bl.slice(blockIndent));
        j++;
      }
      while (out.length > 0 && out[out.length - 1] === "") out.pop();
      return out.slice(0, maxLines);
    }
    if (rest.length > 0) {
      return [stripYamlQuotes(rest)].slice(0, maxLines);
    }
  }
  return [];
}

// ─── ESLint stylish-formatter parser ──────────────────────────────────────────

/**
 * Parse ESLint default (stylish) output for errors. We look for:
 *
 *   <file path>
 *     L:C  error    message              rule/name
 *
 * The regex is forgiving about leading whitespace and repeated spaces.
 */
export function parseEslintFailures(
  raw: string,
  opts: { maxErrorLinesPerTest?: number } = {},
): FailingTest[] {
  const clean = stripAnsi(raw);
  const lines = clean.split(/\r?\n/);
  const failures: FailingTest[] = [];

  let currentFile: string | null = null;
  const maxLines = opts.maxErrorLinesPerTest ?? 6;

  for (const line of lines) {
    // File path lines are absolute or `./` relative paths with no rule
    // context. Accept either a line that looks like a path, or a bare path.
    const fileMatch = /^([\/.]\S+\.[a-zA-Z]+)\s*$/.exec(line);
    if (fileMatch) {
      currentFile = fileMatch[1] ?? null;
      continue;
    }
    const diag = /^\s*(\d+):(\d+)\s+(error|warning)\s+(.*?)\s+([a-z0-9@/_-]+)\s*$/i.exec(line);
    if (diag && currentFile) {
      const [, ln, col, severity, msg, rule] = diag;
      if (severity?.toLowerCase() !== "error") continue;
      failures.push({
        name: `${rule ?? "eslint"} (${currentFile}:${ln}:${col})`,
        location: `${currentFile}:${ln}:${col}`,
        errorLines: [msg ?? ""].slice(0, maxLines),
      });
    }
  }

  return failures;
}

// ─── Tail fallback ────────────────────────────────────────────────────────────

/**
 * Last-resort extractor: grab the last N non-blank lines of a step log, ANSI
 * stripped. Used when no format-specific parser recognised the output.
 */
export function tailFailure(raw: string, tailLines: number): FailingTest[] {
  const clean = stripAnsi(raw);
  const lines = clean.split(/\r?\n/).map((l) => l.replace(/\s+$/, ""));
  const trimmed: string[] = [];
  for (let i = lines.length - 1; i >= 0 && trimmed.length < tailLines; i--) {
    const l = lines[i] ?? "";
    if (l.length === 0 && trimmed.length === 0) continue;
    trimmed.unshift(l);
  }
  if (trimmed.length === 0) return [];
  return [
    {
      name: "(unparsed failure — tail of step log)",
      location: null,
      errorLines: trimmed,
    },
  ];
}

export function parseStepLog(
  stepName: string,
  raw: string,
  opts: { maxFailingTests?: number; maxErrorLinesPerTest?: number; tailLines?: number } = {},
): { kind: FailureKind; failingTests: FailingTest[] } {
  const kind = classifyStep(stepName);
  const maxFailingTests = opts.maxFailingTests ?? 10;

  let failures: FailingTest[] = [];
  if (kind === "test") {
    failures = parseTapFailures(raw, { maxErrorLinesPerTest: opts.maxErrorLinesPerTest });
  } else if (kind === "lint") {
    failures = parseEslintFailures(raw, { maxErrorLinesPerTest: opts.maxErrorLinesPerTest });
  }

  if (failures.length === 0) {
    failures = tailFailure(raw, opts.tailLines ?? 40);
  }

  return { kind, failingTests: failures.slice(0, maxFailingTests) };
}
