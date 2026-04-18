import { describe, expect, it } from "vitest";
import { IntensityTracker } from "../src/intensity.ts";

describe("IntensityTracker", () => {
  it("starts empty", () => {
    const t = new IntensityTracker(() => 1_000);
    expect(t.count(60_000)).toBe(0);
    expect(t.shouldEscalate(3, 60_000)).toBe(false);
  });

  it("records stamps and counts them inside the window", () => {
    let now = 0;
    const t = new IntensityTracker(() => now);
    now = 100;
    t.record();
    now = 200;
    t.record();
    now = 300;
    t.record();
    expect(t.count(500)).toBe(3);
  });

  it("evicts stamps older than the window", () => {
    let now = 0;
    const t = new IntensityTracker(() => now);
    now = 0;
    t.record();
    now = 500;
    t.record();
    now = 1_500;
    t.record();
    // Window = 1_000ms; cutoff = 1_500 - 1_000 = 500. Stamps >= 500 are live.
    expect(t.count(1_000)).toBe(2);
    now = 10_000;
    expect(t.count(1_000)).toBe(0);
  });

  it("snapshot returns a copy of the live stamps only", () => {
    let now = 0;
    const t = new IntensityTracker(() => now);
    now = 0;
    t.record();
    now = 400;
    t.record();
    now = 900;
    const snap = t.snapshot(500);
    expect(snap).toEqual([400]);
    // Mutating the snapshot doesn't affect the tracker.
    const mutable = [...snap];
    mutable.push(42);
    expect(t.count(500)).toBe(1);
  });

  it("shouldEscalate treats intensity as the tolerated count", () => {
    let now = 0;
    const t = new IntensityTracker(() => now);
    // intensity=3, withinMs=1000
    // After three records we are AT the threshold — one more restart
    // would exceed. `shouldEscalate` returns true when the NEXT restart
    // would trip, i.e. when in-window >= intensity.
    for (let i = 0; i < 3; i++) {
      t.record();
      now += 10;
    }
    expect(t.count(1_000)).toBe(3);
    expect(t.shouldEscalate(3, 1_000)).toBe(true);
    // With intensity=5, still under budget.
    expect(t.shouldEscalate(5, 1_000)).toBe(false);
  });

  it("reset drops all stamps", () => {
    const t = new IntensityTracker(() => 100);
    t.record();
    t.record();
    expect(t.count(1_000)).toBe(2);
    t.reset();
    expect(t.count(1_000)).toBe(0);
  });
});
