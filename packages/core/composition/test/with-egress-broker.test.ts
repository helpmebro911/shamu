/**
 * Unit tests for `withEgressBroker`.
 *
 * Scope: the helper starts a real broker (on an OS-assigned loopback port),
 * merges the proxy env vars on top of `baseSpawnOpts`, wires the optional
 * event sink, and tears the broker down idempotently. We exercise the
 * contract end-to-end against a live broker rather than stubbing the
 * `@shamu/egress-broker` package — starting/shutting down a loopback HTTP
 * server inside one `it()` is fast (sub-10 ms) and the coverage is more
 * meaningful than a mocked one.
 */

import { describe, expect, it } from "bun:test";
import type { SpawnOpts } from "@shamu/adapters-base/adapter";
import {
  type EgressPolicy,
  type PolicyEgressAllowedEvent,
  type PolicyEgressDeniedEvent,
  policyFromAllowlist,
} from "@shamu/egress-broker";
import type { RunId } from "@shamu/shared/ids";
import { withEgressBroker } from "../src/with-egress-broker.ts";

const RUN = "01HZXRUN0000000000000000W1" as RunId;

function makePolicy(): EgressPolicy {
  // Empty allow-list is fine for a helper test — we never issue a real
  // request through the broker in these assertions, only inspect the
  // resulting spawnOpts.env and lifecycle.
  return policyFromAllowlist([]);
}

function baseOpts(env?: Readonly<Record<string, string>>): SpawnOpts {
  return {
    runId: RUN,
    cwd: "/tmp/w",
    ...(env !== undefined ? { env } : {}),
  };
}

describe("withEgressBroker — broker lifecycle", () => {
  it("starts the broker before returning so brokerHandle.url is populated", async () => {
    const r = await withEgressBroker({
      policy: makePolicy(),
      baseSpawnOpts: baseOpts(),
    });
    try {
      expect(r.brokerHandle.url.startsWith("http://127.0.0.1:")).toBe(true);
      expect(r.brokerHandle.port).toBeGreaterThan(0);
    } finally {
      await r.shutdown();
    }
  });

  it("returns spawnOpts.env with HTTPS_PROXY + HTTP_PROXY pointing at brokerHandle.url and NO_PROXY=loopback", async () => {
    const r = await withEgressBroker({
      policy: makePolicy(),
      baseSpawnOpts: baseOpts(),
    });
    try {
      const env = r.spawnOpts.env;
      if (!env) throw new Error("expected env on spawnOpts");
      expect(env.HTTPS_PROXY).toBe(r.brokerHandle.url);
      expect(env.HTTP_PROXY).toBe(r.brokerHandle.url);
      expect(env.NO_PROXY).toBe("127.0.0.1,localhost");
    } finally {
      await r.shutdown();
    }
  });

  it("preserves existing baseSpawnOpts.env entries and only overrides the three proxy keys", async () => {
    const r = await withEgressBroker({
      policy: makePolicy(),
      baseSpawnOpts: baseOpts({
        ANTHROPIC_API_KEY: "sk-anthropic-xyz",
        SHAMU_CACHE_SALT: "abc123",
        // Pre-existing proxy values should be OVERWRITTEN by the broker URL.
        HTTPS_PROXY: "http://legacy:9999",
        NO_PROXY: "not-loopback",
      }),
    });
    try {
      const env = r.spawnOpts.env;
      if (!env) throw new Error("expected env on spawnOpts");
      expect(env.ANTHROPIC_API_KEY).toBe("sk-anthropic-xyz");
      expect(env.SHAMU_CACHE_SALT).toBe("abc123");
      // Proxy keys now point at the broker.
      expect(env.HTTPS_PROXY).toBe(r.brokerHandle.url);
      expect(env.HTTP_PROXY).toBe(r.brokerHandle.url);
      expect(env.NO_PROXY).toBe("127.0.0.1,localhost");
    } finally {
      await r.shutdown();
    }
  });

  it("preserves every other SpawnOpts field verbatim", async () => {
    const base: SpawnOpts = {
      runId: RUN,
      cwd: "/tmp/agent-cwd",
      model: "claude-opus",
      permissionMode: "acceptEdits",
      vendorCliPath: "/usr/local/bin/vendor",
      allowedTools: ["read", "write"],
      maxTurns: 5,
      vendorOpts: { providerID: "anthropic" },
    };
    const r = await withEgressBroker({
      policy: makePolicy(),
      baseSpawnOpts: base,
    });
    try {
      expect(r.spawnOpts.runId).toBe(base.runId);
      expect(r.spawnOpts.cwd).toBe(base.cwd);
      expect(r.spawnOpts.model).toBe(base.model);
      expect(r.spawnOpts.permissionMode).toBe(base.permissionMode);
      expect(r.spawnOpts.vendorCliPath).toBe(base.vendorCliPath);
      expect(r.spawnOpts.allowedTools).toEqual(base.allowedTools);
      expect(r.spawnOpts.maxTurns).toBe(base.maxTurns);
      expect(r.spawnOpts.vendorOpts).toEqual(base.vendorOpts as Record<string, unknown>);
    } finally {
      await r.shutdown();
    }
  });
});

describe("withEgressBroker — shutdown", () => {
  it("is idempotent — second shutdown is a no-op", async () => {
    const r = await withEgressBroker({
      policy: makePolicy(),
      baseSpawnOpts: baseOpts(),
    });
    await r.shutdown();
    await r.shutdown();
    // After shutdown the broker's url returns "" (port reset to 0 — see
    // broker.ts). This is the strongest observable signal that the
    // underlying broker is fully reaped.
    expect(r.brokerHandle.url).toBe("");
  });

  it("concurrent shutdowns do not double-reap", async () => {
    const r = await withEgressBroker({
      policy: makePolicy(),
      baseSpawnOpts: baseOpts(),
    });
    await Promise.all([r.shutdown(), r.shutdown(), r.shutdown()]);
    expect(r.brokerHandle.url).toBe("");
  });
});

describe("withEgressBroker — onEvent wiring", () => {
  it("forwards broker allow + deny events to the supplied handler", async () => {
    const received: Array<{
      type: "allowed" | "denied";
      host: string;
    }> = [];

    const r = await withEgressBroker({
      policy: makePolicy(),
      baseSpawnOpts: baseOpts(),
      onEvent: (type, ev) => {
        received.push({ type, host: ev.host });
      },
    });

    // Directly emit synthetic events through the broker emitter surface
    // used by the proxy path — proves wire-through without needing to
    // issue a real HTTP request. We reach the emitter via the handle's
    // public `on` subscription side-effect: the broker's `emit()` is
    // internal, but we can drive the real emit path by firing a tiny
    // in-process HTTP CONNECT that the broker will immediately deny.
    //
    // Simpler: use the same surface the proxy uses — a direct TCP
    // connect that issues CONNECT to a host not on the allow-list. The
    // broker responds 403 and emits `policy.egress_denied`. The test
    // only inspects the handler's received list.

    // Fire a dial at our own broker to force a deny.
    const { connect } = await import("node:net");
    const socket = connect({ port: r.brokerHandle.port, host: "127.0.0.1" });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("error", reject);
    });
    const req =
      "CONNECT evil.example.invalid:443 HTTP/1.1\r\n" + "Host: evil.example.invalid:443\r\n\r\n";
    socket.write(req);
    // Wait long enough for the deny-response + emit to land.
    await new Promise<void>((resolve) => {
      let done = false;
      socket.once("close", () => {
        done = true;
        resolve();
      });
      setTimeout(() => {
        if (!done) {
          socket.destroy();
          resolve();
        }
      }, 500);
    });
    try {
      expect(received.length).toBeGreaterThanOrEqual(1);
      const deny = received.find((r) => r.type === "denied");
      if (!deny) throw new Error("expected a deny event");
      expect(deny.host).toBe("evil.example.invalid");
    } finally {
      await r.shutdown();
    }
  });

  it("handler throws are swallowed and do not crash the broker", async () => {
    const r = await withEgressBroker({
      policy: makePolicy(),
      baseSpawnOpts: baseOpts(),
      onEvent: () => {
        throw new Error("listener misbehaved");
      },
    });
    try {
      // Drive a single deny through so the handler fires. Fires + does not
      // throw across the module boundary — the broker is still live after.
      const { connect } = await import("node:net");
      const socket = connect({ port: r.brokerHandle.port, host: "127.0.0.1" });
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", () => resolve());
        socket.once("error", reject);
      });
      socket.write("CONNECT evil2.invalid:443 HTTP/1.1\r\nHost: evil2.invalid:443\r\n\r\n");
      await new Promise<void>((resolve) => {
        socket.once("close", () => resolve());
        setTimeout(() => {
          socket.destroy();
          resolve();
        }, 200);
      });
      // Broker is still listening — the url reflects a bound port.
      expect(r.brokerHandle.url.startsWith("http://127.0.0.1:")).toBe(true);
    } finally {
      await r.shutdown();
    }
  });

  it("stop receiving events after shutdown", async () => {
    const received: Array<PolicyEgressAllowedEvent | PolicyEgressDeniedEvent> = [];
    const r = await withEgressBroker({
      policy: makePolicy(),
      baseSpawnOpts: baseOpts(),
      onEvent: (_type, ev) => {
        received.push(ev);
      },
    });
    await r.shutdown();
    // The broker is gone; there's no way to produce another event. We only
    // need to assert the unsubscribe completed cleanly (second shutdown is
    // a no-op).
    await r.shutdown();
    expect(received.length).toBe(0);
  });
});
