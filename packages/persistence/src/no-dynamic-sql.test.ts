/**
 * Banned-pattern regression test.
 *
 * PLAN § Track 1.B forbids dynamic SQL string construction in this package:
 * every query must be a prepared statement against a constant SQL string.
 * This test greps the source for the banned shape — backtick-quoted strings
 * starting with a SQL keyword that contain `${`.
 *
 * The one legitimate `VACUUM INTO '<path>'` construction in `db.ts`
 * interpolates a path (not user-controllable SQL) and doubles single quotes
 * — it lives inside a non-template string so it does not trip this test.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const PACKAGE_ROOT = join(import.meta.dirname ?? new URL(".", import.meta.url).pathname);

function listSourceFiles(root: string, acc: string[] = []): string[] {
  for (const name of readdirSync(root)) {
    const p = join(root, name);
    const s = statSync(p);
    if (s.isDirectory()) {
      if (name === "node_modules" || name === "dist" || name === "coverage") continue;
      listSourceFiles(p, acc);
    } else if (
      s.isFile() &&
      name.endsWith(".ts") &&
      !name.endsWith(".test.ts") &&
      !name.endsWith(".d.ts")
    ) {
      acc.push(p);
    }
  }
  return acc;
}

/**
 * A heuristic regex that looks for template literals whose content begins with
 * a SQL keyword and contains a substitution. Case-sensitive on the keyword
 * list; dynamic SQL tends to be uppercase by convention in this codebase.
 */
const BANNED = /`\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|PRAGMA)\b[\s\S]*?\$\{/;

describe("no dynamic SQL string construction", () => {
  it("persistence sources contain no template-literal SQL with substitutions", () => {
    const files = listSourceFiles(PACKAGE_ROOT);
    const violations: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      if (BANNED.test(text)) {
        violations.push(f);
      }
    }
    expect(violations).toEqual([]);
  });
});
