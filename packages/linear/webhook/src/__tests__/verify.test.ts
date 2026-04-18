/**
 * Tests for HMAC signature verification, timestamp window, and nonce cache.
 *
 * Each typed rejection is covered: `missing_header`, `invalid_signature`,
 * `stale_timestamp`, `duplicate_nonce`, `malformed`. Happy-path parses and
 * returns the envelope's id + timestamp.
 */

import { describe, expect, it } from "vitest";
import {
  FIXTURE_NOW_MS,
  issueLabelAddedPayload,
  signFixture,
  TEST_WEBHOOK_SECRET,
} from "../__fixtures__/index.ts";
import {
  computeSignature,
  DEFAULT_TIMESTAMP_SKEW_MS,
  extractEnvelopeMeta,
  LINEAR_SIGNATURE_HEADER,
  NonceCache,
  safeEqualHex,
  verifyLinearRequest,
} from "../verify.ts";

function headersWith(signature: string | null): Record<string, string> {
  return signature === null ? {} : { [LINEAR_SIGNATURE_HEADER]: signature };
}

describe("computeSignature + safeEqualHex", () => {
  it("produces a deterministic hex digest for the same body + secret", () => {
    const body = new TextEncoder().encode('{"a":1}');
    const a = computeSignature(body, TEST_WEBHOOK_SECRET);
    const b = computeSignature(body, TEST_WEBHOOK_SECRET);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("differs when either body or secret changes", () => {
    const body = new TextEncoder().encode('{"a":1}');
    const alt = new TextEncoder().encode('{"a":2}');
    const base = computeSignature(body, TEST_WEBHOOK_SECRET);
    expect(computeSignature(alt, TEST_WEBHOOK_SECRET)).not.toBe(base);
    expect(computeSignature(body, "shamu-test-other-secret")).not.toBe(base);
  });

  it("safeEqualHex is case-insensitive and length-aware", () => {
    expect(safeEqualHex("abcdef", "ABCDEF")).toBe(true);
    expect(safeEqualHex("abcdef", "abcde0")).toBe(false);
    expect(safeEqualHex("abcd", "abcde")).toBe(false);
  });
});

describe("NonceCache", () => {
  it("remembers ids within the window and rejects duplicates", () => {
    const cache = new NonceCache({ windowMs: 10_000, now: () => 1000 });
    expect(cache.has("a")).toBe(false);
    expect(cache.remember("a")).toBe(true);
    expect(cache.has("a")).toBe(true);
    expect(cache.remember("a")).toBe(false);
  });

  it("evicts entries older than windowMs", () => {
    let t = 1000;
    const cache = new NonceCache({ windowMs: 5000, now: () => t });
    cache.remember("old");
    t = 10_000;
    expect(cache.has("old")).toBe(false);
    // After a has(), the expired entry should be gone.
    expect(cache.size()).toBe(0);
  });

  it("caps to maxEntries via LRU eviction", () => {
    const cache = new NonceCache({ maxEntries: 3, windowMs: 1_000_000, now: () => 1 });
    cache.remember("a");
    cache.remember("b");
    cache.remember("c");
    cache.remember("d");
    expect(cache.has("a")).toBe(false);
    expect(cache.has("d")).toBe(true);
  });

  it("reset() clears all entries", () => {
    const cache = new NonceCache({ now: () => 1 });
    cache.remember("a");
    cache.remember("b");
    cache.reset();
    expect(cache.has("a")).toBe(false);
    expect(cache.has("b")).toBe(false);
  });
});

describe("extractEnvelopeMeta", () => {
  it("returns the id + ts for a valid envelope", () => {
    const body = new TextEncoder().encode(
      JSON.stringify({ webhookId: "w1", webhookTimestamp: 123 }),
    );
    const meta = extractEnvelopeMeta(body);
    expect(meta.ok).toBe(true);
    if (meta.ok) {
      expect(meta.webhookId).toBe("w1");
      expect(meta.webhookTimestamp).toBe(123);
    }
  });

  it("rejects non-object bodies", () => {
    const body = new TextEncoder().encode(JSON.stringify([1, 2, 3]));
    const meta = extractEnvelopeMeta(body);
    expect(meta.ok).toBe(false);
  });

  it("rejects bodies without webhookId", () => {
    const body = new TextEncoder().encode(JSON.stringify({ webhookTimestamp: 1 }));
    const meta = extractEnvelopeMeta(body);
    expect(meta.ok).toBe(false);
  });

  it("rejects non-utf8 bytes", () => {
    const body = new Uint8Array([0xff, 0xfe]);
    const meta = extractEnvelopeMeta(body);
    expect(meta.ok).toBe(false);
  });
});

describe("verifyLinearRequest — happy path", () => {
  it("accepts a signed, fresh, unseen delivery", () => {
    const signed = signFixture(issueLabelAddedPayload());
    const result = verifyLinearRequest({
      secret: TEST_WEBHOOK_SECRET,
      rawBody: signed.rawBody,
      headers: headersWith(signed.signature),
      nonceCache: new NonceCache({ now: () => FIXTURE_NOW_MS }),
      now: () => FIXTURE_NOW_MS,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.webhookId).toBe(signed.webhookId);
      expect(result.webhookTimestamp).toBe(signed.webhookTimestamp);
    }
  });

  it("is tolerant of upper-case hex signatures", () => {
    const signed = signFixture(issueLabelAddedPayload());
    const upper = signed.signature.toUpperCase();
    const result = verifyLinearRequest({
      secret: TEST_WEBHOOK_SECRET,
      rawBody: signed.rawBody,
      headers: headersWith(upper),
      nonceCache: new NonceCache({ now: () => FIXTURE_NOW_MS }),
      now: () => FIXTURE_NOW_MS,
    });
    expect(result.ok).toBe(true);
  });
});

describe("verifyLinearRequest — rejection discriminants", () => {
  const freshCache = (): NonceCache => new NonceCache({ now: () => FIXTURE_NOW_MS });

  it("rejects missing header", () => {
    const signed = signFixture(issueLabelAddedPayload());
    const result = verifyLinearRequest({
      secret: TEST_WEBHOOK_SECRET,
      rawBody: signed.rawBody,
      headers: headersWith(null),
      nonceCache: freshCache(),
      now: () => FIXTURE_NOW_MS,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("missing_header");
  });

  it("rejects tampered body (same signature, different bytes)", () => {
    const signed = signFixture(issueLabelAddedPayload());
    const tampered = new Uint8Array(signed.rawBody);
    // Flip one byte in the JSON body.
    const first = tampered[0] ?? 0;
    tampered[0] = first ^ 0x01;
    const result = verifyLinearRequest({
      secret: TEST_WEBHOOK_SECRET,
      rawBody: tampered,
      headers: headersWith(signed.signature),
      nonceCache: freshCache(),
      now: () => FIXTURE_NOW_MS,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid_signature");
  });

  it("rejects tampered signature (same body, different sig)", () => {
    const signed = signFixture(issueLabelAddedPayload());
    const bad = signed.signature === "0".repeat(64) ? "1".repeat(64) : "0".repeat(64);
    const result = verifyLinearRequest({
      secret: TEST_WEBHOOK_SECRET,
      rawBody: signed.rawBody,
      headers: headersWith(bad),
      nonceCache: freshCache(),
      now: () => FIXTURE_NOW_MS,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid_signature");
  });

  it("rejects when the wrong secret is configured", () => {
    const signed = signFixture(issueLabelAddedPayload());
    const result = verifyLinearRequest({
      secret: "shamu-test-wrong-secret",
      rawBody: signed.rawBody,
      headers: headersWith(signed.signature),
      nonceCache: freshCache(),
      now: () => FIXTURE_NOW_MS,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("invalid_signature");
  });

  it("rejects stale timestamps beyond the skew window", () => {
    const payload = issueLabelAddedPayload({
      webhookTimestamp: FIXTURE_NOW_MS - (DEFAULT_TIMESTAMP_SKEW_MS + 1),
    });
    const signed = signFixture(payload);
    const result = verifyLinearRequest({
      secret: TEST_WEBHOOK_SECRET,
      rawBody: signed.rawBody,
      headers: headersWith(signed.signature),
      nonceCache: freshCache(),
      now: () => FIXTURE_NOW_MS,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("stale_timestamp");
  });

  it("rejects timestamps far in the future (positive skew)", () => {
    const payload = issueLabelAddedPayload({
      webhookTimestamp: FIXTURE_NOW_MS + (DEFAULT_TIMESTAMP_SKEW_MS + 1),
    });
    const signed = signFixture(payload);
    const result = verifyLinearRequest({
      secret: TEST_WEBHOOK_SECRET,
      rawBody: signed.rawBody,
      headers: headersWith(signed.signature),
      nonceCache: freshCache(),
      now: () => FIXTURE_NOW_MS,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("stale_timestamp");
  });

  it("rejects duplicate webhook ids (replay)", () => {
    const signed = signFixture(issueLabelAddedPayload({ webhookId: "dup-1" }));
    const cache = freshCache();
    const first = verifyLinearRequest({
      secret: TEST_WEBHOOK_SECRET,
      rawBody: signed.rawBody,
      headers: headersWith(signed.signature),
      nonceCache: cache,
      now: () => FIXTURE_NOW_MS,
    });
    expect(first.ok).toBe(true);
    const second = verifyLinearRequest({
      secret: TEST_WEBHOOK_SECRET,
      rawBody: signed.rawBody,
      headers: headersWith(signed.signature),
      nonceCache: cache,
      now: () => FIXTURE_NOW_MS,
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("duplicate_nonce");
  });

  it("rejects malformed bodies after passing signature check", () => {
    // Construct a raw body that is valid HMAC'd but not valid JSON.
    const rawBody = new TextEncoder().encode("not valid json at all");
    const signature = computeSignature(rawBody, TEST_WEBHOOK_SECRET);
    const result = verifyLinearRequest({
      secret: TEST_WEBHOOK_SECRET,
      rawBody,
      headers: headersWith(signature),
      nonceCache: freshCache(),
      now: () => FIXTURE_NOW_MS,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("malformed");
  });
});
