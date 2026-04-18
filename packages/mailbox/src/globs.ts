/**
 * Lightweight glob overlap predicate.
 *
 * PLAN.md § "Core architecture → 5. Mailbox & file leases" requires that
 * lease acquisition rejects when a new glob overlaps an existing live
 * lease. We intentionally avoid pulling in a full glob-matching library
 * (minimatch/micromatch) — the overlap test is small and the semantics we
 * need are narrower than a general POSIX glob:
 *
 *   - A glob is a forward-slash-separated path pattern using the tokens
 *     `**` (match any segments, including zero) and `*` (match any single
 *     segment component).
 *   - Two globs **overlap** iff there exists at least one concrete path
 *     both patterns could accept. Equivalent to: the intersection of
 *     their matched path sets is non-empty.
 *
 * Algorithm (segment-wise greedy compare with `**` backtracking):
 *
 *   1. Normalize both globs: split on `/`, trim empty leading / trailing
 *      segments.
 *   2. Walk segment pairs. `**` on either side consumes zero-or-more
 *      segments from the *other* side. A bare `*` token matches exactly
 *      one segment. A segment containing `*` (like `*.ts`) is treated as
 *      a per-segment wildcard that matches any concrete basename,
 *      because deciding whether two wildcard patterns "can share a hit"
 *      reduces to "can both generate any common basename?" — and since
 *      `*` matches everything, the answer is yes as long as the literal
 *      portions don't conflict (see {@link segmentsCompatible}).
 *
 * This is deliberately *conservative* in favor of refusing overlap: if
 * two globs *might* share a path, they overlap (lease refused). False
 * overlap is recoverable (caller tries a narrower glob); false
 * non-overlap would let two writers race, which is unsafe.
 *
 * Not handled (documented as out of scope here):
 *   - Brace expansion (`{a,b}`) — not used in PLAN examples.
 *   - Character classes (`[abc]`) — not used in PLAN examples.
 *   - Negation globs (`!...`) — leases are positive pathspecs only.
 *   - Windows backslash separators — paths are normalized to `/` at the
 *     caller boundary.
 */

/**
 * Split a glob into segments, discarding empty leading/trailing chunks so
 * `"/src/**"` and `"src/**"` are handled identically.
 */
function segments(glob: string): readonly string[] {
  return glob.split("/").filter((s) => s.length > 0);
}

/**
 * Can a `*`-containing segment pattern and another segment pattern share
 * any concrete basename?
 *
 * Collapse the `*` tokens in each pattern and see if the remaining
 * literal substrings could coexist in a single string. For lease globs in
 * this codebase we only need the cheap approximation: any segment
 * containing `*` is treated as "could match anything", so the compat
 * check reduces to "can each anchor against the other?".
 *
 * We build simple anchored regexes (`*` → `.*`) and test each against
 * the other's literal form (with `.*` → `X` as a placeholder) — if
 * neither regex rejects the other, they overlap.
 *
 * For pure-literal segments (no `*`) this degrades to string equality.
 */
function segmentsCompatible(a: string, b: string): boolean {
  // Fast path: equal strings always overlap.
  if (a === b) return true;

  const aHasStar = a.includes("*");
  const bHasStar = b.includes("*");

  // Pure literals must match exactly.
  if (!aHasStar && !bHasStar) return false;

  // If either side is plain `*`, it matches any single-segment pattern.
  if (a === "*" || b === "*") return true;

  // Compile each to an anchored regex, test against a literal-ized form
  // of the other (replacing `*` with a neutral placeholder that the
  // other pattern also tolerates). This is conservative: if any
  // concrete assignment of `*` makes the pattern succeed, the regex
  // test returns true.
  const toRegex = (pat: string): RegExp => {
    // Escape regex metachars except `*`.
    const escaped = pat.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    const asRe = escaped.replace(/\*/g, ".*");
    return new RegExp(`^${asRe}$`);
  };

  const aRe = toRegex(a);
  const bRe = toRegex(b);

  // Substitute each side's `*` with a single character `X` — a simple,
  // deterministic concrete basename — and test. If neither regex
  // rejects the other's concrete form, the globs overlap.
  const aConcrete = a.replace(/\*/g, "X");
  const bConcrete = b.replace(/\*/g, "X");

  return bRe.test(aConcrete) || aRe.test(bConcrete);
}

/**
 * Inner recursive matcher: does segment-list `a` overlap segment-list
 * `b` from index `ai`/`bi` onward?
 *
 * `**` on either side consumes zero or more segments from the other
 * side. We use depth-first search with bounded branching — glob lengths
 * in practice are small (under 10 segments), so the worst-case blowup
 * is negligible.
 */
function walk(a: readonly string[], ai: number, b: readonly string[], bi: number): boolean {
  // Both exhausted.
  if (ai >= a.length && bi >= b.length) return true;

  // `a` exhausted: `b` must be entirely `**` from here.
  if (ai >= a.length) {
    for (let i = bi; i < b.length; i++) {
      if (b[i] !== "**") return false;
    }
    return true;
  }

  // `b` exhausted: symmetric.
  if (bi >= b.length) {
    for (let i = ai; i < a.length; i++) {
      if (a[i] !== "**") return false;
    }
    return true;
  }

  const aSeg = a[ai];
  const bSeg = b[bi];
  if (aSeg === undefined || bSeg === undefined) return false;

  // `**` on either side can (a) match zero segments (skip), (b) match
  // one segment and stay (consume from the other side).
  if (aSeg === "**") {
    // zero-match
    if (walk(a, ai + 1, b, bi)) return true;
    // consume one from b, `**` stays
    return walk(a, ai, b, bi + 1);
  }
  if (bSeg === "**") {
    if (walk(a, ai, b, bi + 1)) return true;
    return walk(a, ai + 1, b, bi);
  }

  // Regular segments — must be compatible to continue.
  if (!segmentsCompatible(aSeg, bSeg)) return false;
  return walk(a, ai + 1, b, bi + 1);
}

/**
 * True iff two globs could match at least one concrete path in common.
 *
 * Used by {@link acquireLease} to enforce single-writer semantics on any
 * file a live lease claims.
 */
export function globsOverlap(a: string, b: string): boolean {
  return walk(segments(a), 0, segments(b), 0);
}

/**
 * True iff a concrete forward-slash path is matched by a lease glob.
 *
 * Used by the pre-commit guard to check staged paths against live
 * leases. A path is treated as a literal segment list; `**` in the
 * glob matches any number of segments (including zero).
 */
export function globMatchesPath(glob: string, path: string): boolean {
  const pathSegs = segments(path);
  const globSegs = segments(glob);

  function inner(gi: number, pi: number): boolean {
    if (gi >= globSegs.length && pi >= pathSegs.length) return true;
    if (gi >= globSegs.length) return false;

    const gSeg = globSegs[gi];
    if (gSeg === "**") {
      // zero-match
      if (inner(gi + 1, pi)) return true;
      // or consume one path segment and stay
      if (pi < pathSegs.length) return inner(gi, pi + 1);
      return false;
    }

    if (pi >= pathSegs.length) return false;
    const pSeg = pathSegs[pi];
    if (pSeg === undefined || gSeg === undefined) return false;

    if (gSeg === "*") return inner(gi + 1, pi + 1);

    if (gSeg.includes("*")) {
      // Per-segment wildcard: turn `*` into `.*` and anchor.
      const escaped = gSeg.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`^${escaped.replace(/\*/g, ".*")}$`);
      if (!re.test(pSeg)) return false;
      return inner(gi + 1, pi + 1);
    }

    if (gSeg !== pSeg) return false;
    return inner(gi + 1, pi + 1);
  }

  return inner(0, 0);
}
