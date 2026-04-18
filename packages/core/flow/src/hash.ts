/**
 * Deterministic content hash for node inputs.
 *
 * PLAN.md § 8: "node outputs are content-hashed so reruns deduplicate."
 * The engine hashes an input bundle (node id + kind + resolved inputs)
 * before invoking a runner; if the prior `FlowRunState` recorded an
 * output under the same hash, the engine short-circuits with that output.
 *
 * Canonicalization rules (non-negotiable — a change here means every
 * cached output is stale, which is why `FlowDefinition.version` exists):
 *
 *   1. Objects are serialized with keys sorted lexicographically.
 *   2. Arrays preserve order.
 *   3. Primitives allowed: string, number (finite, non-NaN), boolean, null.
 *   4. Rejected with TypeError at canonicalization time: undefined,
 *      function, symbol, bigint, Date, non-finite number (NaN, Infinity,
 *      -Infinity). These either cannot be represented in JSON or tempt
 *      confusing coercions.
 *   5. Cycles are detected and throw. (A tombstone map keyed by
 *      object identity tracks the current walk.)
 *
 * SHA-256 is the digest. Node's `createHash` works under both Bun and
 * Node, so the engine stays runtime-agnostic.
 */

import { createHash } from "node:crypto";

/**
 * Produce a stable hex SHA-256 digest of `input`, canonicalized per the
 * rules above.
 */
export function contentHash(input: unknown): string {
  const canonical = canonicalize(input);
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Serialize `input` to a canonical JSON string (sorted keys, rejected
 * non-serializable types, cycle detection). Exposed for tests and for
 * callers that want the pre-hash representation (e.g. debug logs).
 */
export function canonicalize(input: unknown): string {
  const seen = new WeakSet<object>();
  return encodeValue(input, seen);
}

function encodeValue(value: unknown, seen: WeakSet<object>): string {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "boolean") return value ? "true" : "false";
  if (t === "number") {
    const n = value as number;
    if (!Number.isFinite(n)) {
      throw new TypeError(`contentHash: non-finite number not representable (got ${String(n)})`);
    }
    // JSON.stringify on a finite number is canonical (no locale, no
    // spaces). It yields "1" for 1 and "1.5" for 1.5, which is what we
    // want. `Number.isFinite` already excluded NaN/±Infinity.
    return JSON.stringify(n);
  }
  if (t === "string") return JSON.stringify(value as string);
  if (t === "undefined") {
    throw new TypeError("contentHash: undefined is not serializable");
  }
  if (t === "function") {
    throw new TypeError("contentHash: function values are not serializable");
  }
  if (t === "symbol") {
    throw new TypeError("contentHash: symbol values are not serializable");
  }
  if (t === "bigint") {
    throw new TypeError("contentHash: bigint values are not serializable");
  }
  // Remaining cases: object. Reject Date / Map / Set explicitly; they
  // serialize ambiguously under JSON.stringify and would silently
  // collide with structurally-distinct inputs.
  if (value instanceof Date) {
    throw new TypeError("contentHash: Date values are not serializable");
  }
  if (value instanceof Map || value instanceof Set) {
    throw new TypeError("contentHash: Map/Set values are not serializable");
  }
  // Now it's either a plain array or a plain object.
  const obj = value as object;
  if (seen.has(obj)) {
    throw new TypeError("contentHash: cycle detected during canonicalization");
  }
  seen.add(obj);
  try {
    if (Array.isArray(value)) {
      const parts = value.map((item) => encodeValue(item, seen));
      return `[${parts.join(",")}]`;
    }
    // Plain object: sort keys and serialize key-value pairs.
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    const parts: string[] = [];
    for (const key of keys) {
      const child = record[key];
      // Drop `undefined`-valued keys the same way JSON.stringify does, so
      // `{a: 1, b: undefined}` hashes identically to `{a: 1}`. This is the
      // one place we silently omit `undefined`: objects where a property
      // was *explicitly* set to undefined should canonicalize like one
      // where the property was never set. Top-level `undefined` still
      // throws above.
      if (child === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${encodeValue(child, seen)}`);
    }
    return `{${parts.join(",")}}`;
  } finally {
    seen.delete(obj);
  }
}
