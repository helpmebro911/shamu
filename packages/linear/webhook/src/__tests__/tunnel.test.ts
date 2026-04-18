/**
 * Tests for the cloudflared tunnel wrapper.
 *
 * We do NOT spawn cloudflared in tests. Instead we inject a fake `spawnImpl`
 * that returns a minimal ChildProcess-like object and a fake binary-presence
 * checker. The goal is to assert:
 *
 *   - argv matches `buildTunnelArgs(...)` byte-for-byte.
 *   - missing binary surfaces a `TunnelBootError` with a clear message.
 *   - stop() triggers a SIGTERM on the child and resolves when it exits.
 */

import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { buildTunnelArgs, scopeMessage, startTunnel, TunnelBootError } from "../tunnel.ts";

interface FakeChild extends EventEmitter {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  pid: number;
  stdout: EventEmitter & { setEncoding: (enc: string) => void };
  stderr: EventEmitter & { setEncoding: (enc: string) => void };
  kill: (signal?: NodeJS.Signals | number) => boolean;
}

function createFakeChild(pid = 4242): FakeChild {
  const emitter = new EventEmitter() as unknown as FakeChild;
  emitter.exitCode = null;
  emitter.signalCode = null;
  emitter.pid = pid;
  const stdout = new EventEmitter() as FakeChild["stdout"];
  stdout.setEncoding = () => {};
  const stderr = new EventEmitter() as FakeChild["stderr"];
  stderr.setEncoding = () => {};
  emitter.stdout = stdout;
  emitter.stderr = stderr;
  const signals: NodeJS.Signals[] = [];
  emitter.kill = ((signal?: NodeJS.Signals | number): boolean => {
    const normalised: NodeJS.Signals =
      typeof signal === "number" ? "SIGTERM" : (signal ?? "SIGTERM");
    signals.push(normalised);
    // Simulate exit shortly after SIGTERM.
    if (normalised === "SIGTERM") {
      setImmediate(() => {
        emitter.exitCode = 0;
        emitter.signalCode = normalised;
        emitter.emit("exit", 0, normalised);
      });
    }
    if (normalised === "SIGKILL") {
      setImmediate(() => {
        emitter.exitCode = null;
        emitter.signalCode = normalised;
        emitter.emit("exit", null, normalised);
      });
    }
    return true;
  }) as FakeChild["kill"];
  Object.defineProperty(emitter, "__signals", { value: signals });
  return emitter;
}

describe("buildTunnelArgs", () => {
  it("renders the exact cloudflared argv we expect", () => {
    expect(buildTunnelArgs("127.0.0.1", 7357)).toEqual([
      "tunnel",
      "--url",
      "http://127.0.0.1:7357",
    ]);
  });

  it("honours a non-default host", () => {
    expect(buildTunnelArgs("0.0.0.0", 8080)).toEqual(["tunnel", "--url", "http://0.0.0.0:8080"]);
  });
});

describe("scopeMessage", () => {
  it("mentions the webhook path", () => {
    expect(scopeMessage("/webhooks/linear")).toContain("/webhooks/linear");
  });
});

describe("startTunnel — boot", () => {
  it("throws TunnelBootError when cloudflared is not on PATH", () => {
    expect(() =>
      startTunnel({
        host: "127.0.0.1",
        port: 7357,
        checkBinary: () => ({ present: false, detail: "ENOENT" }),
        spawnImpl: () => {
          throw new Error("should not spawn");
        },
        installSigtermHandler: false,
      }),
    ).toThrow(TunnelBootError);
  });

  it("passes argv through to spawnImpl exactly", () => {
    const child = createFakeChild();
    const spawn = vi.fn(() => child as unknown as ChildProcess);
    const handle = startTunnel({
      host: "127.0.0.1",
      port: 7357,
      checkBinary: () => ({ present: true }),
      spawnImpl: spawn,
      installSigtermHandler: false,
    });
    expect(spawn).toHaveBeenCalledTimes(1);
    const call = spawn.mock.calls[0];
    if (!call) throw new Error("spawn was not called");
    const [bin, argv, options] = call as unknown as [
      string,
      readonly string[],
      { stdio: ["ignore", "pipe", "pipe"] },
    ];
    expect(bin).toBe("cloudflared");
    expect(argv).toEqual(["tunnel", "--url", "http://127.0.0.1:7357"]);
    expect(options.stdio).toEqual(["ignore", "pipe", "pipe"]);
    expect(handle.argv).toEqual(argv);
    expect(handle.pid).toBe(4242);
  });

  it("respects a custom binary path", () => {
    const child = createFakeChild();
    const spawn = vi.fn(() => child as unknown as ChildProcess);
    startTunnel({
      host: "127.0.0.1",
      port: 7357,
      bin: "/opt/cloudflared/bin/cloudflared",
      checkBinary: () => ({ present: true }),
      spawnImpl: spawn,
      installSigtermHandler: false,
    });
    const firstCall = spawn.mock.calls[0] as unknown as
      | [string, readonly string[], unknown]
      | undefined;
    if (!firstCall) throw new Error("spawn was not called");
    expect(firstCall[0]).toBe("/opt/cloudflared/bin/cloudflared");
  });
});

describe("startTunnel — lifecycle", () => {
  it("stop() sends SIGTERM and resolves when child exits", async () => {
    const child = createFakeChild();
    const handle = startTunnel({
      host: "127.0.0.1",
      port: 7357,
      checkBinary: () => ({ present: true }),
      spawnImpl: () => child as unknown as ChildProcess,
      installSigtermHandler: false,
    });
    await handle.stop();
    const signals = (child as unknown as { __signals: NodeJS.Signals[] }).__signals;
    expect(signals).toContain("SIGTERM");
    const exit = await handle.exited;
    expect(exit.signal).toBe("SIGTERM");
  });

  it("stop() is a no-op when the child has already exited", async () => {
    const child = createFakeChild();
    // Flip to exited before stop().
    child.exitCode = 0;
    const handle = startTunnel({
      host: "127.0.0.1",
      port: 7357,
      checkBinary: () => ({ present: true }),
      spawnImpl: () => child as unknown as ChildProcess,
      installSigtermHandler: false,
    });
    // Emit exit so the internal `exited` promise resolves for later assertions.
    setImmediate(() => child.emit("exit", 0, null));
    await handle.stop();
    const signals = (child as unknown as { __signals: NodeJS.Signals[] }).__signals;
    expect(signals).toHaveLength(0);
  });

  it("escalates to SIGKILL when SIGTERM grace expires", async () => {
    const emitter = new EventEmitter() as unknown as FakeChild;
    emitter.exitCode = null;
    emitter.signalCode = null;
    emitter.pid = 1234;
    const stdout = new EventEmitter() as FakeChild["stdout"];
    stdout.setEncoding = () => {};
    const stderr = new EventEmitter() as FakeChild["stderr"];
    stderr.setEncoding = () => {};
    emitter.stdout = stdout;
    emitter.stderr = stderr;
    const signals: NodeJS.Signals[] = [];
    emitter.kill = ((signal?: NodeJS.Signals | number): boolean => {
      const normalised: NodeJS.Signals =
        typeof signal === "number" ? "SIGTERM" : (signal ?? "SIGTERM");
      signals.push(normalised);
      if (normalised === "SIGKILL") {
        setImmediate(() => {
          emitter.exitCode = null;
          emitter.signalCode = "SIGKILL";
          emitter.emit("exit", null, "SIGKILL");
        });
      }
      return true;
    }) as FakeChild["kill"];

    const handle = startTunnel({
      host: "127.0.0.1",
      port: 7357,
      checkBinary: () => ({ present: true }),
      spawnImpl: () => emitter as unknown as ChildProcess,
      stopGraceMs: 10,
      installSigtermHandler: false,
    });
    await handle.stop();
    expect(signals).toContain("SIGTERM");
    expect(signals).toContain("SIGKILL");
  });
});

describe("startTunnel — SIGTERM propagation", () => {
  it("installs a SIGTERM listener when installSigtermHandler is true", async () => {
    const child = createFakeChild();
    const listenerCountBefore = process.listenerCount("SIGTERM");
    const handle = startTunnel({
      host: "127.0.0.1",
      port: 7357,
      checkBinary: () => ({ present: true }),
      spawnImpl: () => child as unknown as ChildProcess,
      installSigtermHandler: true,
    });
    expect(process.listenerCount("SIGTERM")).toBe(listenerCountBefore + 1);
    // Cleanly stop so the listener is removed and we don't leak between tests.
    await handle.stop();
    expect(process.listenerCount("SIGTERM")).toBe(listenerCountBefore);
  });
});
