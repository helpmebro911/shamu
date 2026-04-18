import { describe, expect, it } from "vitest";
import { andThen, err, isErr, isOk, map, mapErr, ok, unwrap, unwrapOr } from "./result.ts";

describe("Result", () => {
  describe("constructors and type guards", () => {
    it("ok/isOk round-trip", () => {
      const r = ok(42);
      expect(isOk(r)).toBe(true);
      expect(isErr(r)).toBe(false);
      if (isOk(r)) expect(r.value).toBe(42);
    });

    it("err/isErr round-trip", () => {
      const r = err("boom");
      expect(isOk(r)).toBe(false);
      expect(isErr(r)).toBe(true);
      if (isErr(r)) expect(r.error).toBe("boom");
    });
  });

  describe("map", () => {
    it("transforms ok values", () => {
      const r = map(ok(2), (n) => n * 5);
      expect(isOk(r) && r.value).toBe(10);
    });

    it("passes through err", () => {
      const r = map(err<string>("bad"), (n: number) => n * 5);
      expect(isErr(r) && r.error).toBe("bad");
    });
  });

  describe("mapErr", () => {
    it("passes through ok", () => {
      const r = mapErr(ok(1), (e: string) => `x:${e}`);
      expect(isOk(r) && r.value).toBe(1);
    });

    it("transforms err", () => {
      const r = mapErr(err("bad"), (e) => `x:${e}`);
      expect(isErr(r) && r.error).toBe("x:bad");
    });
  });

  describe("unwrap", () => {
    it("returns the value for ok", () => {
      expect(unwrap(ok("hi"))).toBe("hi");
    });

    it("throws Error instances as-is", () => {
      const e = new TypeError("planted");
      expect(() => unwrap(err(e))).toThrow(e);
    });

    it("wraps non-Error errors in Error", () => {
      try {
        unwrap(err("raw-string"));
        expect.unreachable();
      } catch (caught) {
        expect(caught).toBeInstanceOf(Error);
        expect((caught as Error).message).toContain("raw-string");
      }
    });
  });

  describe("unwrapOr", () => {
    it("returns the value for ok", () => {
      expect(unwrapOr(ok(7), 99)).toBe(7);
    });

    it("returns the fallback for err", () => {
      expect(unwrapOr(err("bad"), 99)).toBe(99);
    });
  });

  describe("andThen", () => {
    it("chains on ok", () => {
      const r = andThen(ok(2), (n) => ok(n + 1));
      expect(isOk(r) && r.value).toBe(3);
    });

    it("short-circuits on initial err", () => {
      const r = andThen(err("first"), (_n: number) => ok(99));
      expect(isErr(r) && r.error).toBe("first");
    });

    it("propagates inner err", () => {
      const r = andThen(ok(2), (_n) => err("inner"));
      expect(isErr(r) && r.error).toBe("inner");
    });
  });
});
