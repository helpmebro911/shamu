import { describe, expect, it } from "vitest";
import { greet } from "./index.ts";

describe("greet", () => {
  it("returns a greeting with a trailing period", () => {
    expect(greet("Shamu")).toBe("Hello, Shamu.");
  });
});
