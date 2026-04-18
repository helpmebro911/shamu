import { afterEach, describe, expect, it, vi } from "vitest";
import { modeFrom, writeDiag, writeHuman, writeJson, writeWatch } from "../src/output.ts";

describe("output helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves mode from --json", () => {
    expect(modeFrom({ json: false })).toBe("human");
    expect(modeFrom({ json: true })).toBe("json");
  });

  it("writeJson emits newline-delimited JSON only in json mode", () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    writeJson("json", { kind: "t", n: 1 });
    writeJson("human", { kind: "ignored" });
    expect(writes).toEqual(['{"kind":"t","n":1}\n']);
  });

  it("writeHuman emits text only in human mode", () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    writeHuman("human", "hello");
    writeHuman("json", "ignored");
    expect(writes).toEqual(["hello\n"]);
  });

  it("writeDiag writes to stderr regardless of mode", () => {
    const writes: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    writeDiag("warn");
    expect(writes).toEqual(["warn\n"]);
  });

  it("writeWatch terminates when its AbortSignal aborts", async () => {
    const ctrl = new AbortController();
    let ticks = 0;
    const p = writeWatch(
      () => {
        ticks += 1;
        if (ticks >= 2) ctrl.abort();
      },
      { intervalMs: 5, signal: ctrl.signal },
    );
    await expect(p).resolves.toBeUndefined();
    expect(ticks).toBeGreaterThanOrEqual(2);
  });
});
