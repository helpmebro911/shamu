import { describe, expect, it } from "vitest";
import { isUlid, ULID_LENGTH, ulid } from "./ulid.ts";

describe("ulid", () => {
  it("produces a 26-char Crockford base32 string", () => {
    const u = ulid();
    expect(u).toHaveLength(ULID_LENGTH);
    expect(isUlid(u)).toBe(true);
  });

  it("is monotonic within the same millisecond", () => {
    const now = 1_700_000_000_000;
    const a = ulid(now);
    const b = ulid(now);
    const c = ulid(now);
    expect(b > a).toBe(true);
    expect(c > b).toBe(true);
  });

  it("orders by time across different milliseconds", () => {
    const early = ulid(1_700_000_000_000);
    const later = ulid(1_700_000_000_500);
    expect(later > early).toBe(true);
  });

  it("rejects non-ULID strings", () => {
    expect(isUlid("not a ulid")).toBe(false);
    expect(isUlid("")).toBe(false);
    expect(isUlid("01HZZZZZZZZZZZZZZZZZZZZZZI")).toBe(false); // contains I
    expect(isUlid("01HZZZZZZZZZZZZZZZZZZZZZZZ")).toBe(true);
  });

  it("encodes the timestamp in the first 10 chars", () => {
    // `0` encodes zero; so a ULID with now=0 should start with ten zeros.
    const u = ulid(0);
    expect(u.slice(0, 10)).toBe("0000000000");
  });

  it("rejects invalid timestamps", () => {
    expect(() => ulid(-1)).toThrow(RangeError);
    expect(() => ulid(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});
