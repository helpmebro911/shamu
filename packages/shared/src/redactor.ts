/**
 * Central secret redactor.
 *
 * Two strategies, composed:
 *
 * 1. **Pattern allow-list** — regex families for well-known token shapes
 *    (Anthropic `sk-ant-…`, OpenAI `sk-proj-…` / `sk-…`, GitHub `ghp_…` /
 *    `ghs_…`, JWTs, generic 40-char hex, `*_API_KEY=…` inline assignments).
 *    Each pattern has a label that shows up in the redaction marker.
 *
 * 2. **Exact-value hash list** — callers register a secret string via
 *    `register()`. The class stores only `sha256(secret)`; the plaintext is
 *    never held. When redacting, a rolling window of each registered length
 *    is hashed and compared. This catches secrets whose shape the regexes
 *    don't recognize (vendor-specific API keys with unusual prefixes,
 *    user-supplied tokens, etc.) without keeping the plaintext resident.
 *
 * Output format: matched spans are replaced by `<REDACTED:<label>>` where
 * `<label>` is the pattern name for regex hits or `value:<sha256-prefix>`
 * for value-hash hits.
 *
 * Redaction runs on first write to `raw_events` AND to `events` (belt and
 * braces — see PLAN § 2 Event log).
 */

import { createHash } from "node:crypto";
import { RedactorError } from "./errors.ts";

export interface RedactPattern {
  readonly label: string;
  readonly pattern: RegExp;
}

/**
 * Built-in patterns.
 *
 * Ordering matters: longer / more-specific patterns go first so their matches
 * win over shorter ones. Patterns use the `g` flag; callers are expected to
 * treat them as read-only.
 *
 * Each pattern matches the *secret* portion only — for `*_API_KEY=<value>`
 * shape, we match the whole assignment so that the key name is also masked
 * (otherwise the masked output would leak the variable name, which on some
 * deployments is itself a fingerprint).
 */
export const DEFAULT_PATTERNS: readonly RedactPattern[] = [
  { label: "anthropic_key", pattern: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { label: "openai_project_key", pattern: /sk-proj-[A-Za-z0-9_-]{20,}/g },
  { label: "openai_key", pattern: /sk-[A-Za-z0-9]{32,}/g },
  { label: "github_pat", pattern: /ghp_[A-Za-z0-9]{30,}/g },
  { label: "github_server_token", pattern: /ghs_[A-Za-z0-9]{30,}/g },
  { label: "github_oauth", pattern: /gho_[A-Za-z0-9]{30,}/g },
  { label: "github_user_refresh", pattern: /ghr_[A-Za-z0-9]{30,}/g },
  {
    label: "jwt",
    pattern: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  },
  {
    label: "api_key_assign",
    pattern: /\b[A-Z][A-Z0-9_]*(?:API_KEY|SECRET|TOKEN|PASSWORD)\s*=\s*\S+/g,
  },
  // Generic 40-char hex — matches lots of things (SHA1, some API tokens).
  // Keep this last so the more specific patterns above win.
  { label: "hex40", pattern: /\b[0-9a-f]{40}\b/g },
];

export interface RedactorOptions {
  readonly patterns?: readonly RedactPattern[];
  /** Minimum length of a registered value. Prevents accidentally registering
   * short strings that would redact random 4-5 char substrings. */
  readonly minRegisterLength?: number;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * One registered value: the length (so we know the window size to roll) and
 * the digest (so we can compare without holding the plaintext).
 */
interface RegisteredValue {
  readonly length: number;
  readonly digest: string;
}

export class Redactor {
  private readonly patterns: readonly RedactPattern[];
  private readonly minRegisterLength: number;
  private readonly registered = new Map<string, RegisteredValue>();

  constructor(opts: RedactorOptions = {}) {
    this.patterns = opts.patterns ?? DEFAULT_PATTERNS;
    this.minRegisterLength = opts.minRegisterLength ?? 12;
  }

  /**
   * Register a secret string for exact-match redaction.
   *
   * The plaintext is hashed and NOT stored. Subsequent `redact()` calls
   * scan for rolling windows whose hash matches.
   *
   * Throws `RedactorError` if the secret is shorter than
   * `minRegisterLength` — short values would create false positives on
   * random text.
   */
  register(secret: string): void {
    if (typeof secret !== "string" || secret.length < this.minRegisterLength) {
      throw new RedactorError(
        `register() secrets must be ≥ ${this.minRegisterLength} chars; got ${
          typeof secret === "string" ? secret.length : typeof secret
        }`,
      );
    }
    const digest = sha256Hex(secret);
    // Keyed by digest so re-registering the same secret is idempotent.
    this.registered.set(digest, { length: secret.length, digest });
  }

  /**
   * Redact patterns and registered-value hits from `text`.
   *
   * Two-pass:
   *  1. Scan every registered-value length window; any window whose SHA256
   *     matches a registered digest is masked.
   *  2. Apply each regex pattern in order.
   *
   * Scanning registered values first means the masked placeholder text
   * cannot coincidentally match a regex (the placeholder contains no valid
   * secret-shaped substring).
   */
  redact(text: string): string {
    if (typeof text !== "string" || text.length === 0) return text;
    let out = this.maskRegisteredValues(text);
    for (const { label, pattern } of this.patterns) {
      // `RegExp.prototype.replace` with a /g regex resets lastIndex per call,
      // so we don't mutate shared state.
      out = out.replace(pattern, `<REDACTED:${label}>`);
    }
    return out;
  }

  private maskRegisteredValues(text: string): string {
    if (this.registered.size === 0) return text;
    // Collect unique lengths to minimize scanning.
    const lengths = new Set<number>();
    for (const v of this.registered.values()) lengths.add(v.length);

    // We build a list of spans to redact (start, end, label), then splice.
    const spans: Array<{ start: number; end: number; label: string }> = [];
    for (const len of lengths) {
      if (len > text.length) continue;
      const maxStart = text.length - len;
      for (let i = 0; i <= maxStart; i++) {
        const window = text.slice(i, i + len);
        const digest = sha256Hex(window);
        const hit = this.registered.get(digest);
        if (hit) {
          spans.push({
            start: i,
            end: i + len,
            label: `value:${digest.slice(0, 8)}`,
          });
        }
      }
    }
    if (spans.length === 0) return text;
    // Merge overlapping / adjacent spans, keeping the earliest label.
    spans.sort((a, b) => a.start - b.start || b.end - a.end);
    const merged: typeof spans = [];
    for (const s of spans) {
      const prev = merged[merged.length - 1];
      if (prev && s.start <= prev.end) {
        if (s.end > prev.end) prev.end = s.end;
      } else {
        merged.push({ ...s });
      }
    }
    // Build output.
    let out = "";
    let cursor = 0;
    for (const s of merged) {
      out += text.slice(cursor, s.start);
      out += `<REDACTED:${s.label}>`;
      cursor = s.end;
    }
    out += text.slice(cursor);
    return out;
  }

  /** Exposed for tests; returns the number of registered values. */
  size(): number {
    return this.registered.size;
  }
}
