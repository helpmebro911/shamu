/**
 * `summarizeToolResult` — shared truncation helper.
 *
 * Per 0.B, every adapter must produce identical summaries for identical tool
 * outputs so fixtures don't drift between Claude and Codex and OpenCode. The
 * spike's projector used `slice(0, 500)`. We keep the default limit higher
 * (1000 chars) because the reviewer's separate excerpt budget already owns
 * the token-hungry reviewer path; adapter summaries should carry more raw
 * context for the watchdog and event log without blowing any single budget.
 *
 * Contract:
 * - Deterministic: same input ⇒ same output, byte-for-byte.
 * - Truncation suffix exactly matches:
 *     ` … (truncated, <total>B)`
 *   (a leading space, a horizontal ellipsis, and the underlying byte count
 *   from the caller — NOT `text.length`, because Claude's tool results report
 *   byte sizes that may differ from the JS string's character count).
 * - Returns the original text unchanged when `text.length <= maxChars`.
 * - Never emits a trailing whitespace that was in the middle of a mid-line
 *   cut: the truncated prefix is trimmed right to a non-whitespace character.
 * - JSON/YAML awareness is best-effort. If the text looks like JSON (`{`-
 *   or `[`-prefixed, stripped of leading whitespace), we try to cut at the
 *   last balanced object/array boundary within the truncation window. If
 *   none exists, we fall back to the simple char-cut. The goal is "don't
 *   corrupt a small JSON output"; we don't try to reformat or re-prettify.
 */

export interface SummarizeToolResultOptions {
  readonly maxChars?: number;
}

const DEFAULT_MAX_CHARS = 1000;
const ELLIPSIS = "\u2026"; // U+2026 HORIZONTAL ELLIPSIS

/** The canonical marker is derived from `bytes` (may differ from `text.length`). */
function truncationSuffix(totalBytes: number): string {
  return ` ${ELLIPSIS} (truncated, ${totalBytes}B)`;
}

function trimRight(text: string): string {
  // `String.prototype.trimEnd()` strips \u2028/\u2029 too, which we don't
  // want (they're legal content characters). Manually restrict to ASCII
  // whitespace.
  let end = text.length;
  while (end > 0) {
    const ch = text.charCodeAt(end - 1);
    if (ch === 0x20 || ch === 0x09 || ch === 0x0a || ch === 0x0d) {
      end--;
    } else {
      break;
    }
  }
  return text.slice(0, end);
}

/**
 * Find the largest k <= maxChars such that text[0..k) is a balanced JSON
 * prefix (every `{` / `[` / `"` closed). Returns -1 if no balanced prefix
 * longer than 0 chars exists within the window.
 *
 * Intentionally simple: we scan once, track three counters (object/array
 * depth and in-string state), remember the greatest index at which all
 * depths were zero, and return that index. Handles escaped quotes. Does
 * NOT validate the JSON; it just finds a syntactically-balanced cut point.
 */
function findBalancedJsonCut(text: string, maxChars: number): number {
  const limit = Math.min(maxChars, text.length);
  let objDepth = 0;
  let arrDepth = 0;
  let inString = false;
  let escaped = false;
  let lastBalanced = -1;

  for (let i = 0; i < limit; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") objDepth++;
    else if (ch === "}") objDepth--;
    else if (ch === "[") arrDepth++;
    else if (ch === "]") arrDepth--;
    if (objDepth === 0 && arrDepth === 0 && !inString && i > 0) {
      lastBalanced = i + 1;
    }
  }
  return lastBalanced;
}

function looksLikeJson(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === " " || ch === "\n" || ch === "\r" || ch === "\t") continue;
    return ch === "{" || ch === "[";
  }
  return false;
}

/**
 * Truncate `text` for event-log storage.
 *
 * @param bytes The authoritative byte count of the full underlying result.
 *              Emitted verbatim in the truncation suffix so the reader knows
 *              the real size even when the summary is trimmed.
 * @param text  The human-readable body the adapter wants to store.
 * @param opts  Override the default 1000-char limit when needed; lowering it
 *              below ~100 is not recommended — the truncation suffix alone
 *              costs ~20 chars.
 */
export function summarizeToolResult(
  bytes: number,
  text: string,
  opts: SummarizeToolResultOptions = {},
): string {
  if (typeof text !== "string") return "";
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  if (!Number.isFinite(maxChars) || maxChars <= 0) return "";
  if (text.length <= maxChars) return text;

  // Try a JSON-aware cut first; fall back to a simple char cut.
  let cut = text.length;
  if (looksLikeJson(text)) {
    const balanced = findBalancedJsonCut(text, maxChars);
    // Only prefer the balanced cut if it's close to the limit — otherwise
    // we'd throw away most of the summary to keep JSON clean.
    if (balanced > 0 && balanced >= Math.floor(maxChars * 0.5)) {
      cut = balanced;
    } else {
      cut = maxChars;
    }
  } else {
    cut = maxChars;
  }

  const prefix = trimRight(text.slice(0, cut));
  return `${prefix}${truncationSuffix(bytes)}`;
}

/** Exposed for unit tests that assert the suffix shape. */
export const __forTests = {
  ELLIPSIS,
  truncationSuffix,
  DEFAULT_MAX_CHARS,
};
