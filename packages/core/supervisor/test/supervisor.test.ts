import { describe, expect, it } from "vitest";
import type { EscalationRaised, SupervisorEvent } from "../src/events.ts";
import { Supervisor } from "../src/supervisor.ts";
import type { ChildSpec, RestartPolicy } from "../src/types.ts";
import { FakeWorker, fakeFactory } from "./fake-worker.ts";

function policy(overrides: Partial<RestartPolicy> = {}): RestartPolicy {
  return {
    strategy: "one_for_one",
    intensity: 3,
    withinMs: 60_000,
    escalate: "role",
    ...overrides,
  };
}

function collectEvents(sv: Supervisor): SupervisorEvent[] {
  const events: SupervisorEvent[] = [];
  sv.subscribe((e) => events.push(e));
  return events;
}

async function flush(): Promise<void> {
  // Drain enough microtask turns for the exit-listener's async
  // `restartOrEscalate` to resolve, including the rest_for_one path that
  // awaits bootRecord once per restarted child. Six turns is generous; the
  // worst-case chain today is ~4 awaits deep.
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
  }
}

describe("Supervisor.start/stop", () => {
  it("starts every child in spec order and transitions to running", async () => {
    const a = fakeFactory("a");
    const b = fakeFactory("b");
    const specs: ChildSpec[] = [
      { childId: "a", factory: a.factory },
      { childId: "b", factory: b.factory },
    ];
    const sv = new Supervisor(policy(), specs);
    const events = collectEvents(sv);
    await sv.start();
    expect(sv.state).toBe("running");
    expect(a.workers).toHaveLength(1);
    expect(b.workers).toHaveLength(1);
    const starts = events.filter((e) => e.kind === "child_started");
    expect(starts.map((e) => e.childId)).toEqual(["a", "b"]);
  });

  it("stop() halts children in reverse spec order", async () => {
    const a = fakeFactory("a");
    const b = fakeFactory("b");
    const sv = new Supervisor(policy(), [
      { childId: "a", factory: a.factory },
      { childId: "b", factory: b.factory },
    ]);
    const events = collectEvents(sv);
    await sv.start();
    await sv.stop("shutdown");
    expect(sv.state).toBe("stopped");
    const stops = events.filter((e) => e.kind === "child_stopped");
    expect(stops.map((e) => e.childId)).toEqual(["b", "a"]);
    const wa = a.workers[0];
    const wb = b.workers[0];
    if (!wa || !wb) throw new Error("workers missing");
    expect(wa.stopCalls).toBe(1);
    expect(wb.stopCalls).toBe(1);
  });

  it("rejects duplicate childIds at construction", () => {
    const f = fakeFactory("x");
    expect(
      () =>
        new Supervisor(policy(), [
          { childId: "x", factory: f.factory },
          { childId: "x", factory: f.factory },
        ]),
    ).toThrow(/duplicate childId/);
  });

  it("escalates and stops when a child's factory rejects on first start", async () => {
    const a = fakeFactory("a");
    a.configureNext({ failOnStart: new Error("cannot boot") });
    const b = fakeFactory("b");
    const sv = new Supervisor(policy(), [
      { childId: "a", factory: a.factory },
      { childId: "b", factory: b.factory },
    ]);
    const events = collectEvents(sv);
    await sv.start();
    expect(sv.state).toBe("stopped");
    const esc = events.find((e): e is EscalationRaised => e.kind === "escalation_raised");
    if (!esc) throw new Error("expected escalation");
    expect(esc.cause).toBe("start_failed");
    expect(esc.childId).toBe("a");
    // b never started.
    expect(b.workers).toHaveLength(0);
  });
});

describe("Supervisor one_for_one", () => {
  it("restarts only the failed child; siblings untouched", async () => {
    const a = fakeFactory("a");
    const b = fakeFactory("b");
    const c = fakeFactory("c");
    const sv = new Supervisor(policy(), [
      { childId: "a", factory: a.factory },
      { childId: "b", factory: b.factory },
      { childId: "c", factory: c.factory },
    ]);
    const events = collectEvents(sv);
    await sv.start();

    const bWorker = b.workers[0];
    if (!bWorker) throw new Error("b worker missing");
    bWorker.crash(new Error("b died"));
    await flush();

    // Second b worker created, a and c untouched.
    expect(a.workers).toHaveLength(1);
    expect(b.workers).toHaveLength(2);
    expect(c.workers).toHaveLength(1);
    // a and c never got a stop call.
    const aWorker = a.workers[0];
    const cWorker = c.workers[0];
    if (!aWorker || !cWorker) throw new Error("worker missing");
    expect(aWorker.stopCalls).toBe(0);
    expect(cWorker.stopCalls).toBe(0);

    const restarted = events.find((e) => e.kind === "child_restarted");
    expect(restarted?.childId).toBe("b");
  });

  it("increments startCount on each successful restart", async () => {
    const a = fakeFactory("a");
    const sv = new Supervisor(policy(), [{ childId: "a", factory: a.factory }]);
    await sv.start();
    const first = a.workers[0];
    if (!first) throw new Error("first worker missing");
    first.crash();
    await flush();
    const second = a.workers[1];
    if (!second) throw new Error("second worker missing");
    second.crash();
    await flush();
    expect(a.workers).toHaveLength(3);
    const children = sv.children();
    const snap = children[0];
    if (!snap) throw new Error("snapshot missing");
    expect(snap.startCount).toBe(2);
    expect(snap.restartsInWindow).toBe(2);
    await sv.stop();
  });

  it("a normal exit is terminal and does not trigger a restart", async () => {
    const a = fakeFactory("a");
    const sv = new Supervisor(policy(), [{ childId: "a", factory: a.factory }]);
    const events = collectEvents(sv);
    await sv.start();
    const w = a.workers[0];
    if (!w) throw new Error("worker missing");
    w.exitNormal();
    await flush();
    expect(a.workers).toHaveLength(1);
    const restarted = events.find((e) => e.kind === "child_restarted");
    expect(restarted).toBeUndefined();
    const stopped = events.find((e) => e.kind === "child_stopped");
    expect(stopped?.reason).toBe("normal");
    await sv.stop();
  });
});

describe("Supervisor rest_for_one", () => {
  it("restarts the failed child plus every sibling that started after it", async () => {
    const a = fakeFactory("a");
    const b = fakeFactory("b");
    const c = fakeFactory("c");
    const sv = new Supervisor(policy({ strategy: "rest_for_one" }), [
      { childId: "a", factory: a.factory },
      { childId: "b", factory: b.factory },
      { childId: "c", factory: c.factory },
    ]);
    await sv.start();
    const bFirst = b.workers[0];
    const cFirst = c.workers[0];
    const aFirst = a.workers[0];
    if (!bFirst || !cFirst || !aFirst) throw new Error("worker missing");
    bFirst.crash(new Error("b died"));
    await flush();

    // a untouched, b + c fresh.
    expect(a.workers).toHaveLength(1);
    expect(aFirst.stopCalls).toBe(0);
    expect(b.workers).toHaveLength(2);
    expect(c.workers).toHaveLength(2);
    // c-first was told to stop before the new b came up.
    expect(cFirst.stopCalls).toBe(1);
    expect(cFirst.stopReason).toBe("rest_for_one");

    await sv.stop();
  });

  it("no-op for rest_for_one when the failed child is the last in spec order", async () => {
    const a = fakeFactory("a");
    const b = fakeFactory("b");
    const sv = new Supervisor(policy({ strategy: "rest_for_one" }), [
      { childId: "a", factory: a.factory },
      { childId: "b", factory: b.factory },
    ]);
    await sv.start();
    const bFirst = b.workers[0];
    const aFirst = a.workers[0];
    if (!bFirst || !aFirst) throw new Error("worker missing");
    bFirst.crash();
    await flush();
    expect(a.workers).toHaveLength(1);
    expect(aFirst.stopCalls).toBe(0);
    expect(b.workers).toHaveLength(2);
    await sv.stop();
  });
});

describe("Supervisor intensity exceeded", () => {
  it("publishes EscalationRaised with typed cause and stops", async () => {
    let now = 0;
    const a = fakeFactory("a");
    const sv = new Supervisor(
      policy({ intensity: 2, withinMs: 60_000 }),
      [{ childId: "a", factory: a.factory }],
      {
        clock: () => now,
        intensityClock: () => now,
      },
    );
    const events = collectEvents(sv);
    await sv.start();

    // Two restarts allowed inside 60s.
    now = 1_000;
    const w0 = a.workers[0];
    if (!w0) throw new Error("w0 missing");
    w0.crash();
    await flush();
    now = 2_000;
    const w1 = a.workers[1];
    if (!w1) throw new Error("w1 missing");
    w1.crash();
    await flush();

    // Third crash trips escalation; no new worker is created.
    now = 3_000;
    const w2 = a.workers[2];
    if (!w2) throw new Error("w2 missing");
    w2.crash();
    await flush();

    expect(a.workers).toHaveLength(3);
    const esc = events.find((e): e is EscalationRaised => e.kind === "escalation_raised");
    if (!esc) throw new Error("expected escalation");
    expect(esc.cause).toBe("intensity_exceeded");
    expect(esc.childId).toBe("a");
    expect(esc.target).toBe("role");
    expect(esc.restartsInWindow).toBe(2);
    expect(esc.at).toBe(3_000);
    expect(sv.state).toBe("stopped");
  });

  it("does not escalate if restarts fall outside the window", async () => {
    let now = 0;
    const a = fakeFactory("a");
    const sv = new Supervisor(
      policy({ intensity: 2, withinMs: 1_000 }),
      [{ childId: "a", factory: a.factory }],
      {
        clock: () => now,
        intensityClock: () => now,
      },
    );
    const events = collectEvents(sv);
    await sv.start();

    now = 100;
    const w0 = a.workers[0];
    if (!w0) throw new Error("w0 missing");
    w0.crash();
    await flush();

    now = 200;
    const w1 = a.workers[1];
    if (!w1) throw new Error("w1 missing");
    w1.crash();
    await flush();

    // Far outside the 1s window — tracker evicts the two earlier stamps.
    now = 10_000;
    const w2 = a.workers[2];
    if (!w2) throw new Error("w2 missing");
    w2.crash();
    await flush();

    expect(a.workers).toHaveLength(4);
    const escalations = events.filter((e) => e.kind === "escalation_raised");
    expect(escalations).toHaveLength(0);
    await sv.stop();
  });

  it("killed exits count towards restart budget the same as crashes", async () => {
    const a = fakeFactory("a");
    const sv = new Supervisor(policy({ intensity: 1, withinMs: 60_000 }), [
      { childId: "a", factory: a.factory },
    ]);
    const events = collectEvents(sv);
    await sv.start();
    const w0 = a.workers[0];
    if (!w0) throw new Error("w0 missing");
    w0.kill();
    await flush();

    const w1 = a.workers[1];
    if (!w1) throw new Error("w1 missing");
    w1.kill();
    await flush();

    const esc = events.find((e) => e.kind === "escalation_raised");
    expect(esc).toBeDefined();
    expect(sv.state).toBe("stopped");
  });
});

describe("Supervisor addChild/removeChild", () => {
  it("addChild while running starts the new child immediately", async () => {
    const a = fakeFactory("a");
    const b = fakeFactory("b");
    const sv = new Supervisor(policy(), [{ childId: "a", factory: a.factory }]);
    await sv.start();
    await sv.addChild({ childId: "b", factory: b.factory });
    expect(b.workers).toHaveLength(1);
    expect(sv.state).toBe("running");
    await sv.stop();
  });

  it("removeChild stops the child's handle and removes it from the snapshot", async () => {
    const a = fakeFactory("a");
    const b = fakeFactory("b");
    const sv = new Supervisor(policy(), [
      { childId: "a", factory: a.factory },
      { childId: "b", factory: b.factory },
    ]);
    await sv.start();
    await sv.removeChild("a", "gone");
    const ids = sv.children().map((c) => c.childId);
    expect(ids).toEqual(["b"]);
    const wa = a.workers[0];
    if (!wa) throw new Error("wa missing");
    expect(wa.stopCalls).toBe(1);
    expect(wa.stopReason).toBe("gone");
    await sv.stop();
  });

  it("removeChild on an unknown id is a no-op", async () => {
    const a = fakeFactory("a");
    const sv = new Supervisor(policy(), [{ childId: "a", factory: a.factory }]);
    await sv.start();
    await expect(sv.removeChild("nope")).resolves.toBeUndefined();
    await sv.stop();
  });
});

describe("Supervisor handle integration", () => {
  it("stop() does not trigger restart bookkeeping when the handle signals exit", async () => {
    const a = fakeFactory("a");
    const sv = new Supervisor(policy(), [{ childId: "a", factory: a.factory }]);
    const events = collectEvents(sv);
    await sv.start();
    const w = a.workers[0];
    if (!(w instanceof FakeWorker)) throw new Error("worker missing");
    await sv.stop("clean");
    // Even if the handle signals after stop, nothing should happen.
    w.crash();
    await flush();
    const restarts = events.filter((e) => e.kind === "child_restarted");
    expect(restarts).toHaveLength(0);
    expect(a.workers).toHaveLength(1);
  });

  it("addChild before start() enqueues the child without starting it eagerly", async () => {
    const a = fakeFactory("a");
    const b = fakeFactory("b");
    const sv = new Supervisor(policy(), [{ childId: "a", factory: a.factory }]);
    await sv.addChild({ childId: "b", factory: b.factory });
    expect(a.workers).toHaveLength(0);
    expect(b.workers).toHaveLength(0);
    await sv.start();
    expect(a.workers).toHaveLength(1);
    expect(b.workers).toHaveLength(1);
    await sv.stop();
  });
});
