import { describe, expect, it } from "vitest";
import { stripAnsi, stripAnsiLines } from "../src/ansi.ts";

describe("stripAnsi", () => {
  it("removes SGR colour sequences", () => {
    const input = "\x1B[31merror:\x1B[0m something broke";
    expect(stripAnsi(input)).toBe("error: something broke");
  });

  it("removes compound SGR parameters", () => {
    const input = "\x1B[1;31;4mbold red underlined\x1B[0m";
    expect(stripAnsi(input)).toBe("bold red underlined");
  });

  it("removes CSI cursor motion escapes", () => {
    const input = "before\x1B[2Kafter";
    expect(stripAnsi(input)).toBe("beforeafter");
  });

  it("removes OSC sequences terminated by BEL", () => {
    const input = "\x1B]0;title\x07visible";
    expect(stripAnsi(input)).toBe("visible");
  });

  it("removes bare BEL", () => {
    expect(stripAnsi("alarm\x07end")).toBe("alarmend");
  });

  it("is a no-op on plain text", () => {
    expect(stripAnsi("nothing to strip")).toBe("nothing to strip");
  });

  it("stripAnsiLines handles arrays", () => {
    const lines = ["\x1B[32mgreen\x1B[0m", "plain", "\x1B[1mbold\x1B[0m"];
    expect(stripAnsiLines(lines)).toEqual(["green", "plain", "bold"]);
  });
});
