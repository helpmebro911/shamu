/**
 * ULID generator — Crockford base32, 128-bit, monotonic within the same
 * millisecond.
 *
 * Why hand-rolled instead of pulling a dep:
 *  - Pin discipline (G9) asks for exact versions on every direct dep; one less
 *    thing to audit.
 *  - The core algorithm is tiny (≈ 50 lines) and not a security primitive.
 *  - Uses Web Crypto (`crypto.getRandomValues`), which is available under both
 *    Node 22+ and Bun 1.3+ without imports.
 *
 * Spec: https://github.com/ulid/spec
 *
 * The monotonic property is only guaranteed within a single process. Two
 * processes generating ULIDs in the same millisecond may produce values whose
 * ordering does not strictly reflect wall-clock order — but the 80-bit random
 * suffix makes collisions astronomically unlikely.
 */

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // 32 chars, no I L O U
const TIME_LEN = 10;
const RAND_LEN = 16;

// Mutable monotonic state — scoped to the module so each process has its own.
let lastTime = -1;
const lastRand = new Uint8Array(10); // 80-bit random portion as raw bytes

function encodeTime(ms: number): string {
  if (ms < 0 || !Number.isFinite(ms)) {
    throw new RangeError(`ULID: invalid timestamp ${ms}`);
  }
  let rem = ms;
  let out = "";
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    const mod = rem % 32;
    // biome-ignore lint/style/noNonNullAssertion: mod is 0..31 and CROCKFORD is 32 chars
    out = CROCKFORD[mod]! + out;
    rem = (rem - mod) / 32;
  }
  return out;
}

function encodeRandom(bytes: Uint8Array): string {
  // 10 bytes × 8 bits = 80 bits; each base32 char is 5 bits → 16 chars.
  // Read as a bit-stream, 5 bits at a time, MSB first.
  let out = "";
  let bitBuffer = 0;
  let bitCount = 0;
  for (let i = 0; i < bytes.length; i++) {
    bitBuffer = (bitBuffer << 8) | (bytes[i] ?? 0);
    bitCount += 8;
    while (bitCount >= 5) {
      bitCount -= 5;
      const idx = (bitBuffer >>> bitCount) & 0x1f;
      // biome-ignore lint/style/noNonNullAssertion: idx is 0..31 and CROCKFORD is 32 chars
      out += CROCKFORD[idx]!;
      bitBuffer &= (1 << bitCount) - 1;
    }
  }
  return out;
}

function incrementBytes(bytes: Uint8Array): void {
  for (let i = bytes.length - 1; i >= 0; i--) {
    const v = bytes[i] ?? 0;
    if (v === 0xff) {
      bytes[i] = 0;
      continue;
    }
    bytes[i] = v + 1;
    return;
  }
  throw new Error("ULID monotonic: 80-bit random portion overflowed within a millisecond");
}

/**
 * Generate a new ULID for the current wall time.
 *
 * @param now  Override the "now" timestamp — test hook only.
 */
export function ulid(now: number = Date.now()): string {
  let randomBytes: Uint8Array;
  if (now === lastTime) {
    // Same ms: increment the stored random portion by 1 for monotonicity.
    incrementBytes(lastRand);
    randomBytes = lastRand;
  } else {
    randomBytes = new Uint8Array(10);
    globalThis.crypto.getRandomValues(randomBytes);
    lastRand.set(randomBytes);
    lastTime = now;
  }
  return encodeTime(now) + encodeRandom(randomBytes);
}

/** Zero-fill 26 chars; useful as a sentinel in tests. */
export const ULID_LENGTH = TIME_LEN + RAND_LEN;

const ULID_PATTERN = new RegExp(`^[${CROCKFORD}]{${ULID_LENGTH}}$`);

export function isUlid(s: string): boolean {
  return ULID_PATTERN.test(s);
}
