/**
 * Unit tests for the `PiAdapter` shell: capability manifest wiring,
 * factory correctness, the G8 runId invariant, and spawn/resume wiring.
 *
 * No subprocess — these tests use the `driverFactory` injection point.
 */

import { newRunId } from "@shamu/shared/ids";
import { describe, expect, it } from "vitest";
import { createPiAdapter, PI_CAPABILITIES, PiAdapter, type PiDriverOptions } from "../src/index.ts";
import { makeFakeDriver } from "./harness.ts";

describe("PiAdapter — capabilities", () => {
  it("declares the frozen manifest shape", () => {
    expect(PI_CAPABILITIES.resume).toBe(true);
    expect(PI_CAPABILITIES.fork).toBe(true);
    expect(PI_CAPABILITIES.interrupt).toBe("cooperative");
    expect(PI_CAPABILITIES.mcp).toBe("none");
    expect(PI_CAPABILITIES.customTools).toBe(false);
    expect(PI_CAPABILITIES.patchVisibility).toBe("events");
    expect(PI_CAPABILITIES.usageReporting).toBe("per-turn");
    expect(PI_CAPABILITIES.costReporting).toBe("subscription");
    expect(PI_CAPABILITIES.sandboxing).toBe("process");
    expect(PI_CAPABILITIES.streaming).toBe("events");
    expect(PI_CAPABILITIES.permissionModes).toEqual(["default", "acceptEdits"]);
  });

  it("exposes a frozen capabilities reference (G8)", () => {
    expect(Object.isFrozen(PI_CAPABILITIES)).toBe(true);
  });
});

describe("PiAdapter — factory", () => {
  it("createPiAdapter returns a PiAdapter", () => {
    const adapter = createPiAdapter();
    expect(adapter).toBeInstanceOf(PiAdapter);
    expect(adapter.vendor).toBe("pi");
    expect(adapter.capabilities).toBe(PI_CAPABILITIES);
  });

  it("vendor can be overridden", () => {
    const adapter = new PiAdapter({ vendor: "pi-custom" });
    expect(adapter.vendor).toBe("pi-custom");
  });
});

describe("PiAdapter — spawn + resume", () => {
  it("spawn consumes opts.runId (G8 — does not mint its own)", async () => {
    const harness = makeFakeDriver();
    const adapter = new PiAdapter({ driverFactory: async () => harness.driver });
    const runId = newRunId();
    const handle = await adapter.spawn({
      runId,
      cwd: "/tmp/shamu-pi-test-fake",
    });
    expect(handle.runId).toBe(runId);
    await handle.shutdown("t");
  });

  it("spawn calls new_session and binds the returned sessionId", async () => {
    const harness = makeFakeDriver({ initialSessionId: "/var/pi/sess-abc.jsonl" });
    const adapter = new PiAdapter({ driverFactory: async () => harness.driver });
    const handle = await adapter.spawn({ runId: newRunId(), cwd: "/tmp/shamu-pi-test-fake" });
    expect(handle.sessionId).toBe("/var/pi/sess-abc.jsonl");
    const newSessionCalls = harness.calls.filter((c) => c.type === "new_session");
    expect(newSessionCalls.length).toBe(1);
    await handle.shutdown("t");
  });

  it("resume dispatches switch_session with the supplied sessionPath", async () => {
    const harness = makeFakeDriver();
    const adapter = new PiAdapter({ driverFactory: async () => harness.driver });
    const sessionPath =
      "/var/pi/my-saved-session.jsonl" as unknown as import("@shamu/shared/ids").SessionId;
    const handle = await adapter.resume(sessionPath, {
      runId: newRunId(),
      cwd: "/tmp/shamu-pi-test-fake",
    });
    expect(handle.sessionId).toBe(sessionPath);
    const switchCalls = harness.calls.filter((c) => c.type === "switch_session");
    expect(switchCalls.length).toBe(1);
    expect(switchCalls[0]?.params).toEqual({ sessionPath });
    await handle.shutdown("t");
  });

  it("shutdown reaps the driver (closes subprocess/client)", async () => {
    const harness = makeFakeDriver();
    const adapter = new PiAdapter({ driverFactory: async () => harness.driver });
    const handle = await adapter.spawn({
      runId: newRunId(),
      cwd: "/tmp/shamu-pi-test-fake",
    });
    await handle.shutdown("t");
    expect(harness.closed()).toBe(true);
  });

  it("driver close is called even if new_session logic throws", async () => {
    const harness = makeFakeDriver({
      sendCommand: async (type) => {
        if (type === "new_session") throw new Error("boom");
        return undefined;
      },
    });
    const adapter = new PiAdapter({ driverFactory: async () => harness.driver });
    await expect(
      adapter.spawn({ runId: newRunId(), cwd: "/tmp/shamu-pi-test-fake" }),
    ).rejects.toThrow(/boom/);
    expect(harness.closed()).toBe(true);
  });

  it("spawn respects vendorOpts.sessionTitle via set_session_name", async () => {
    const harness = makeFakeDriver();
    const adapter = new PiAdapter({ driverFactory: async () => harness.driver });
    const handle = await adapter.spawn({
      runId: newRunId(),
      cwd: "/tmp/shamu-pi-test-fake",
      vendorOpts: { sessionTitle: "test run" },
    });
    const named = harness.calls.filter((c) => c.type === "set_session_name");
    expect(named.length).toBe(1);
    expect(named[0]?.params).toEqual({ name: "test run" });
    await handle.shutdown("t");
  });
});

describe("PiAdapter — env threading", () => {
  it("passes SpawnOpts.env to the driver factory, merged on top of vendorOpts.env", async () => {
    const captured: PiDriverOptions[] = [];
    const adapter = new PiAdapter({
      driverFactory: async (o) => {
        captured.push(o);
        return makeFakeDriver().driver;
      },
    });
    const handle = await adapter.spawn({
      runId: newRunId(),
      cwd: "/tmp/shamu-pi-test-fake",
      vendorOpts: { env: { VENDOR_ONLY: "v", SHARED: "vendor" } },
      env: {
        HTTPS_PROXY: "http://127.0.0.1:3333",
        HTTP_PROXY: "http://127.0.0.1:3333",
        NO_PROXY: "127.0.0.1,localhost",
        SHARED: "spawn",
      },
    });
    const env = captured[0]?.env;
    expect(env?.HTTPS_PROXY).toBe("http://127.0.0.1:3333");
    expect(env?.HTTP_PROXY).toBe("http://127.0.0.1:3333");
    expect(env?.NO_PROXY).toBe("127.0.0.1,localhost");
    expect(env?.SHARED).toBe("spawn");
    expect(env?.VENDOR_ONLY).toBe("v");
    await handle.shutdown("t");
  });

  it("omits driver.env when no env source is supplied", async () => {
    const captured: PiDriverOptions[] = [];
    const adapter = new PiAdapter({
      driverFactory: async (o) => {
        captured.push(o);
        return makeFakeDriver().driver;
      },
    });
    const handle = await adapter.spawn({ runId: newRunId(), cwd: "/tmp/shamu-pi-test-fake" });
    expect(captured[0]?.env).toBeUndefined();
    await handle.shutdown("t");
  });
});
