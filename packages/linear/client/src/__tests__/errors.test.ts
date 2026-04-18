/**
 * Unit tests for the pure helpers in `errors.ts` (no network, no fetch).
 */

import { describe, expect, it } from "vitest";
import {
  isRateLimitCode,
  LinearAuthError,
  LinearError,
  parseResetHeader,
  parseRetryAfter,
} from "../errors.ts";

describe("parseRetryAfter", () => {
  it("returns the integer value for numeric seconds", () => {
    expect(parseRetryAfter("42")).toBe(42);
    expect(parseRetryAfter("  7  ")).toBe(7);
    expect(parseRetryAfter("0")).toBe(0);
  });

  it("returns seconds-until-date for HTTP-date values", () => {
    const now = Date.parse("2026-04-18T12:00:00Z");
    const when = new Date(now + 30_000).toUTCString();
    expect(parseRetryAfter(when, now)).toBe(30);
  });

  it("returns 0 for past HTTP-dates (never negative)", () => {
    const now = Date.parse("2026-04-18T12:00:00Z");
    const past = new Date(now - 30_000).toUTCString();
    expect(parseRetryAfter(past, now)).toBe(0);
  });

  it("returns undefined for empty / missing / garbage inputs", () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter(undefined)).toBeUndefined();
    expect(parseRetryAfter("")).toBeUndefined();
    expect(parseRetryAfter("   ")).toBeUndefined();
    expect(parseRetryAfter("not-a-thing")).toBeUndefined();
    expect(parseRetryAfter("-5")).toBeUndefined();
  });
});

describe("parseResetHeader", () => {
  it("parses integer-ms values", () => {
    expect(parseResetHeader("1713441600000")).toBe(1713441600000);
  });

  it("rejects non-integer / negative values", () => {
    expect(parseResetHeader("3.14")).toBeUndefined();
    expect(parseResetHeader("-1")).toBeUndefined();
    expect(parseResetHeader("abc")).toBeUndefined();
    expect(parseResetHeader("")).toBeUndefined();
    expect(parseResetHeader(null)).toBeUndefined();
  });
});

describe("isRateLimitCode", () => {
  it("matches Linear's canonical code and historical alias", () => {
    expect(isRateLimitCode("RATELIMITED")).toBe(true);
    expect(isRateLimitCode("RATE_LIMITED")).toBe(true);
  });

  it("is strict about unknown codes", () => {
    expect(isRateLimitCode("AUTHENTICATION_ERROR")).toBe(false);
    expect(isRateLimitCode(undefined)).toBe(false);
    expect(isRateLimitCode("")).toBe(false);
  });
});

describe("LinearAuthError", () => {
  it("carries the reason discriminant and code constant", () => {
    const e = new LinearAuthError("missing", "no key found");
    expect(e.reason).toBe("missing");
    expect(e.code).toBe("linear_auth_error");
    expect(e.message).toBe("no key found");
    expect(e.name).toBe("LinearAuthError");
  });

  it("preserves the cause when given one", () => {
    const root = new Error("keychain down");
    const e = new LinearAuthError("credential_store_failed", "boom", root);
    expect(e.cause).toBe(root);
  });
});

describe("LinearError", () => {
  it("carries kind + detail", () => {
    const e = new LinearError("rate_limited", "slow down", {
      status: 429,
      retryAfterSeconds: 60,
    });
    expect(e.kind).toBe("rate_limited");
    expect(e.detail.retryAfterSeconds).toBe(60);
    expect(e.code).toBe("linear_error");
  });

  it("defaults detail to an empty object", () => {
    const e = new LinearError("network", "offline");
    expect(e.detail).toEqual({});
  });
});
