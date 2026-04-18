import { describe, expect, it } from "vitest";
import { createLogger, type LogEntry, Logger } from "./logger.ts";

function captureTransport(): { entries: LogEntry[]; transport: (e: LogEntry) => void } {
  const entries: LogEntry[] = [];
  return {
    entries,
    transport: (e) => {
      entries.push(e);
    },
  };
}

describe("Logger", () => {
  it("emits entries at or above the configured level", () => {
    const { entries, transport } = captureTransport();
    const log = new Logger({ level: "info", transport, now: () => 1000 });
    log.trace("hidden");
    log.debug("hidden");
    log.info("visible");
    log.warn("also visible");
    log.error("loud");

    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.level)).toEqual(["info", "warn", "error"]);
    expect(entries[0]?.msg).toBe("visible");
    expect(entries[0]?.ts).toBe(1000);
  });

  it("accumulates context via child()", () => {
    const { entries, transport } = captureTransport();
    const root = createLogger({ transport });
    const child = root.child({ runId: "r1" });
    const grand = child.child({ stage: "execute" });
    grand.info("hi", { extra: 1 });

    expect(entries).toHaveLength(1);
    expect(entries[0]?.context).toEqual({ runId: "r1", stage: "execute", extra: 1 });
  });

  it("child context does not mutate parent context", () => {
    const { entries, transport } = captureTransport();
    const root = createLogger({ transport, context: { a: 1 } });
    const child = root.child({ b: 2 });
    root.info("root");
    child.info("child");
    expect(entries[0]?.context).toEqual({ a: 1 });
    expect(entries[1]?.context).toEqual({ a: 1, b: 2 });
  });

  it("defaults to info level", () => {
    const { entries, transport } = captureTransport();
    const log = createLogger({ transport });
    log.debug("hidden");
    log.info("shown");
    expect(entries).toHaveLength(1);
  });

  it("includes numeric levelValue", () => {
    const { entries, transport } = captureTransport();
    const log = createLogger({ transport, level: "trace" });
    log.trace("t");
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(entries.map((e) => e.levelValue)).toEqual([10, 20, 30, 40, 50]);
  });
});
