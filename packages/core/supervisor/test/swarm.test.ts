import { describe, expect, it } from "vitest";
import type { EscalationRaised, SupervisorEvent } from "../src/events.ts";
import { DEFAULT_ROLE_POLICIES } from "../src/policy.ts";
import { Swarm } from "../src/swarm.ts";
import { fakeFactory } from "./fake-worker.ts";

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await Promise.resolve();
  }
}

describe("Swarm composition", () => {
  it("routes role-level events through the swarm bus", async () => {
    const swarm = new Swarm({ swarmId: "s1" });
    const plannerFactory = fakeFactory("p1");
    const executorFactory = fakeFactory("e1");
    swarm.addRole("planner", DEFAULT_ROLE_POLICIES.planner, [
      { childId: "p1", factory: plannerFactory.factory },
    ]);
    swarm.addRole("executor", DEFAULT_ROLE_POLICIES.executor, [
      { childId: "e1", factory: executorFactory.factory },
    ]);

    const events: SupervisorEvent[] = [];
    swarm.subscribe((e) => events.push(e));

    await swarm.start();
    expect(swarm.state).toBe("running");
    expect(events.filter((e) => e.kind === "child_started")).toHaveLength(2);
    await swarm.stop();
    expect(swarm.state).toBe("stopped");
  });

  it("executor escalation with target=role does not halt sibling roles", async () => {
    let now = 0;
    const swarm = new Swarm({ swarmId: "s1", clock: () => now, intensityClock: () => now });

    const planner = fakeFactory("p1");
    swarm.addRole("planner", DEFAULT_ROLE_POLICIES.planner, [
      { childId: "p1", factory: planner.factory },
    ]);

    // Force executor to escalate after first crash.
    const executor = fakeFactory("e1");
    swarm.addRole(
      "executor",
      { ...DEFAULT_ROLE_POLICIES.executor, intensity: 0, withinMs: 60_000 },
      [{ childId: "e1", factory: executor.factory }],
    );

    const events: SupervisorEvent[] = [];
    swarm.subscribe((e) => events.push(e));
    await swarm.start();

    const w = executor.workers[0];
    if (!w) throw new Error("executor worker missing");
    now = 100;
    w.crash();
    await flush();

    const esc = events.find((e): e is EscalationRaised => e.kind === "escalation_raised");
    if (!esc) throw new Error("expected escalation");
    expect(esc.target).toBe("role");
    expect(esc.cause).toBe("intensity_exceeded");
    expect(esc.swarmId).toBe("s1");
    expect(esc.roleId).toBe("executor");

    // Planner is still running because executor's target is "role".
    const plannerSup = swarm.role("planner");
    if (!plannerSup) throw new Error("planner role missing");
    expect(plannerSup.state).toBe("running");
    const executorSup = swarm.role("executor");
    if (!executorSup) throw new Error("executor role missing");
    expect(executorSup.state).toBe("stopped");

    await swarm.stop();
  });

  it("planner escalation with target=swarm halts all roles", async () => {
    let now = 0;
    const swarm = new Swarm({ swarmId: "s1", clock: () => now, intensityClock: () => now });

    const planner = fakeFactory("p1");
    swarm.addRole("planner", { ...DEFAULT_ROLE_POLICIES.planner, intensity: 0, withinMs: 60_000 }, [
      { childId: "p1", factory: planner.factory },
    ]);
    const executor = fakeFactory("e1");
    swarm.addRole("executor", DEFAULT_ROLE_POLICIES.executor, [
      { childId: "e1", factory: executor.factory },
    ]);

    const events: SupervisorEvent[] = [];
    swarm.subscribe((e) => events.push(e));
    await swarm.start();

    now = 100;
    const w = planner.workers[0];
    if (!w) throw new Error("planner worker missing");
    w.crash();
    // Two flushes: one for the intensity/escalation resolution, another
    // for the microtask-scheduled swarm teardown.
    await flush();
    await flush();

    const esc = events.find((e): e is EscalationRaised => e.kind === "escalation_raised");
    if (!esc) throw new Error("expected escalation");
    expect(esc.target).toBe("swarm");

    expect(swarm.state).toBe("stopped");
    const executorSup = swarm.role("executor");
    if (!executorSup) throw new Error("executor role missing");
    expect(executorSup.state).toBe("stopped");
  });

  it("rejects duplicate role ids", () => {
    const swarm = new Swarm();
    swarm.addRole("planner", DEFAULT_ROLE_POLICIES.planner, []);
    expect(() => swarm.addRole("planner", DEFAULT_ROLE_POLICIES.planner, [])).toThrow(
      /duplicate roleId/,
    );
  });

  it("addRole after start() is rejected", async () => {
    const swarm = new Swarm();
    swarm.addRole("planner", DEFAULT_ROLE_POLICIES.planner, []);
    await swarm.start();
    expect(() => swarm.addRole("executor", DEFAULT_ROLE_POLICIES.executor, [])).toThrow(
      /disallowed in state running/,
    );
    await swarm.stop();
  });

  it("start() aborts if an earlier role's start escalates", async () => {
    const swarm = new Swarm({ swarmId: "s1" });
    const p1 = fakeFactory("p1");
    p1.configureNext({ failOnStart: new Error("planner cannot boot") });
    swarm.addRole("planner", DEFAULT_ROLE_POLICIES.planner, [
      { childId: "p1", factory: p1.factory },
    ]);
    const e1 = fakeFactory("e1");
    swarm.addRole("executor", DEFAULT_ROLE_POLICIES.executor, [
      { childId: "e1", factory: e1.factory },
    ]);

    const events: SupervisorEvent[] = [];
    swarm.subscribe((e) => events.push(e));
    await swarm.start();

    expect(swarm.state).toBe("stopped");
    expect(e1.workers).toHaveLength(0);
    const esc = events.find((e) => e.kind === "escalation_raised");
    expect(esc?.cause).toBe("start_failed");
  });
});

describe("EscalationRaised payload", () => {
  it("carries all required fields with the typed cause enum", async () => {
    let now = 0;
    const swarm = new Swarm({ swarmId: "s7", clock: () => now, intensityClock: () => now });
    const rev = fakeFactory("rev");
    swarm.addRole(
      "reviewer",
      { ...DEFAULT_ROLE_POLICIES.reviewer, intensity: 1, withinMs: 60_000 },
      [{ childId: "rev", factory: rev.factory }],
    );

    const seen: EscalationRaised[] = [];
    swarm.subscribe((e) => {
      if (e.kind === "escalation_raised") seen.push(e);
    });
    await swarm.start();

    now = 1_000;
    const w0 = rev.workers[0];
    if (!w0) throw new Error("w0 missing");
    w0.crash();
    await flush();
    now = 2_000;
    const w1 = rev.workers[1];
    if (!w1) throw new Error("w1 missing");
    w1.crash();
    await flush();
    await flush();

    expect(seen).toHaveLength(1);
    const esc = seen[0];
    if (!esc) throw new Error("expected escalation");
    expect(esc).toMatchObject({
      kind: "escalation_raised",
      swarmId: "s7",
      roleId: "reviewer",
      childId: "rev",
      cause: "intensity_exceeded",
      target: "swarm",
      at: 2_000,
      restartsInWindow: 1,
    });
    expect(typeof esc.reason).toBe("string");
    expect(esc.reason.length).toBeGreaterThan(0);
  });
});
