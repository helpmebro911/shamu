/**
 * Argument canonicalization for the `tool_loop` signal.
 *
 * PLAN §6: `tool_loop` fires on three consecutive identical
 * `(tool, canonicalized_args_hash)` pairs. Canonicalization must:
 *
 *   1. Redact secrets (reuse `@shamu/shared/redactor` — do not roll our
 *      own regex list).
 *   2. Normalize whitespace so `"ls -la"` and `"ls  -la"` hash
 *      identically.
 *   3. Produce a deterministic JSON representation with stable object
 *      key ordering so `{ a: 1, b: 2 }` and `{ b: 2, a: 1 }` hash the
 *      same.
 *
 * The function is pure and side-effect-free. Hashing is left to the
 * caller (the tool-loop signal) so tests can assert on the canonical
 * string directly.
 *
 * Order of operations matters:
 *   - We run structural canonicalization FIRST (stable-stringify the
 *     value), then apply the redactor, then normalize whitespace. This
 *     means the regex patterns in `@shamu/shared/redactor` match
 *     against the canonical JSON form, not against nested object
 *     values. That's what we want: the regex is a string matcher, so
 *     it can't see into objects without stringification.
 *
 * Whitespace normalization rules:
 *   - Collapse runs of ASCII whitespace (space, tab, newline, CR) into
 *     a single space.
 *   - Trim leading and trailing whitespace.
 *
 * This is intentionally aggressive: the hash should survive minor
 * formatting differences vendors apply when re-serializing the same
 * tool call.
 */

import { Redactor } from "@shamu/shared/redactor";

/**
 * Recursively normalize whitespace inside every string value of a
 * JSON-ish structure. Objects get sorted keys at the same time so the
 * caller has one combined pass.
 *
 * We normalize BEFORE stringification so that escape sequences
 * (`\n`, `\t`, `\r`) that become literal `\n` / `\t` / `\r` characters
 * in the source string are collapsed to a single space — JSON's own
 * escape encoding happens after. If we normalized post-stringify,
 * those characters would already be backslash-letter pairs and a
 * plain whitespace regex wouldn't see them.
 *
 * Non-JSON-encodable values (functions, symbols, etc.) are coerced to
 * `null` — tool args should be JSON-friendly in practice; anything
 * else is either a vendor bug or caller-side misuse.
 */
function normalizeValue(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return collapseWhitespace(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    const keys = Object.keys(value as Record<string, unknown>).sort();
    for (const k of keys) {
      sorted[k] = normalizeValue((value as Record<string, unknown>)[k]);
    }
    return sorted;
  }
  // Functions, symbols, undefined — coerce to null so the shape stays
  // JSON-stringifiable.
  return null;
}

/**
 * Collapse runs of ASCII whitespace into a single space and trim the
 * ends. Works on literal whitespace characters only — used before
 * stringification so escape sequences are visible.
 */
function collapseWhitespace(s: string): string {
  // `\s` would also collapse vertical tab / form feed / etc.; we stick
  // to the ASCII whitespace set actually seen in tool args.
  return s.replace(/[ \t\n\r]+/g, " ").trim();
}

/**
 * Canonicalize tool arguments for hashing in the tool-loop signal.
 *
 * Returns a UTF-8 string safe to pass into any hash function (SHA-1,
 * BLAKE3, whatever the signal uses). The return is intentionally not
 * hashed here so tests can diff canonical forms without fighting a
 * digest.
 *
 * Order of operations:
 *   1. Recursively normalize whitespace inside string leaves AND sort
 *      object keys.
 *   2. JSON-stringify the result.
 *   3. Run the shared `@shamu/shared/redactor` patterns over the
 *      stringified form so secret-bearing args with different tokens
 *      hash identically.
 *   4. Collapse any whitespace the redaction marker introduced (the
 *      `<REDACTED:foo>` marker is ASCII-safe; this is belt-and-braces).
 */
export function canonicalizeArgs(args: unknown): string {
  const normalized = normalizeValue(args);
  const jsonForm = JSON.stringify(normalized);
  // A fresh Redactor per call — the regex patterns are pure functions
  // of the text, and we don't register any run-specific value hashes
  // (those live in the main persistence layer's redactor). Creating
  // one here keeps the function pure.
  const redactor = new Redactor();
  const redacted = redactor.redact(jsonForm);
  return collapseWhitespace(redacted);
}
