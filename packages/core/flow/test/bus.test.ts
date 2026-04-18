import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventBus } from "../src/bus.ts";

interface TestEvent {
  readonly kind: "t";
  readonly n: number;
}

describe("EventBus", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn> | null = null;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleSpy?.mockRestore();
    consoleSpy = null;
  });

  it("delivers events to every subscriber synchronously", () => {
    const bus = new EventBus<TestEvent>();
    const seenA: number[] = [];
    const seenB: number[] = [];
    bus.subscribe((ev) => seenA.push(ev.n));
    bus.subscribe((ev) => seenB.push(ev.n));
    bus.publish({ kind: "t", n: 1 });
    bus.publish({ kind: "t", n: 2 });
    expect(seenA).toEqual([1, 2]);
    expect(seenB).toEqual([1, 2]);
  });

  it("unsubscribing stops delivery to that listener only", () => {
    const bus = new EventBus<TestEvent>();
    const seen: number[] = [];
    const dispose = bus.subscribe((ev) => seen.push(ev.n));
    bus.subscribe((ev) => seen.push(100 + ev.n));
    bus.publish({ kind: "t", n: 1 });
    dispose();
    bus.publish({ kind: "t", n: 2 });
    expect(seen).toEqual([1, 101, 102]);
  });

  it("isolates thrown listener errors from the rest", () => {
    const bus = new EventBus<TestEvent>();
    const good: number[] = [];
    bus.subscribe(() => {
      throw new Error("boom");
    });
    bus.subscribe((ev) => good.push(ev.n));
    bus.publish({ kind: "t", n: 7 });
    expect(good).toEqual([7]);
    expect(consoleSpy).toHaveBeenCalled();
  });

  it("clear() removes every subscriber", () => {
    const bus = new EventBus<TestEvent>();
    const seen: number[] = [];
    bus.subscribe((ev) => seen.push(ev.n));
    expect(bus.size).toBe(1);
    bus.clear();
    expect(bus.size).toBe(0);
    bus.publish({ kind: "t", n: 99 });
    expect(seen).toEqual([]);
  });

  it("a listener unsubscribing itself during dispatch does not skip siblings", () => {
    const bus = new EventBus<TestEvent>();
    const order: string[] = [];
    const disposeA = bus.subscribe(() => {
      order.push("A");
      disposeA();
    });
    bus.subscribe(() => {
      order.push("B");
    });
    bus.publish({ kind: "t", n: 1 });
    expect(order).toEqual(["A", "B"]);
    order.length = 0;
    bus.publish({ kind: "t", n: 2 });
    expect(order).toEqual(["B"]);
  });
});
