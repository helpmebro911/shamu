import { describe, expect, it } from "vitest";
import { isAgentAdapter } from "../src/adapter.ts";
import { FakeAdapter } from "./fake-adapter.ts";

describe("isAgentAdapter", () => {
  it("accepts a real adapter", () => {
    const adapter = new FakeAdapter();
    expect(isAgentAdapter(adapter)).toBe(true);
  });

  it("rejects a plain object", () => {
    expect(isAgentAdapter({})).toBe(false);
    expect(isAgentAdapter(null)).toBe(false);
    expect(isAgentAdapter(undefined)).toBe(false);
    expect(isAgentAdapter("adapter")).toBe(false);
    expect(isAgentAdapter({ vendor: "x" })).toBe(false);
    expect(
      isAgentAdapter({ vendor: "x", capabilities: {}, spawn: () => {}, resume: "not-a-fn" }),
    ).toBe(false);
  });
});
