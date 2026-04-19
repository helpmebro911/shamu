/**
 * `withEgressBroker` — glue between `@shamu/egress-broker` and
 * `@shamu/adapters-base`. Starts a per-run broker, merges the proxy env
 * vars on top of a base `SpawnOpts`, and returns a ready-to-pass `SpawnOpts`
 * plus an idempotent `shutdown()` that reaps the broker.
 *
 * Intended caller: the Phase 8.A autonomous daemon (and anyone else) that
 * wants "give me a broker + adjusted SpawnOpts" in one call so the adapter
 * spawn path never has to know about the broker directly.
 *
 * ### What it wires
 *
 *  - `broker.start()` before returning, so `broker.url` is populated.
 *  - `HTTPS_PROXY` + `HTTP_PROXY` → `broker.url` (same value for both —
 *    the broker listens on a single loopback port for both schemes).
 *  - `NO_PROXY` → `"127.0.0.1,localhost"` so broker-internal traffic and
 *    other-loopback tools don't re-enter the proxy and deadlock.
 *  - Existing `baseSpawnOpts.env` is preserved verbatim except for the
 *    three keys above (standard env-merge; later wins).
 *  - If `onEvent` is supplied, subscribes to `broker.on("allowed")` and
 *    `broker.on("denied")`; the unsubscribers are reaped inside
 *    `shutdown()`.
 *
 * ### Lifecycle
 *
 *  1. `withEgressBroker(opts)` — creates + starts the broker, returns the
 *     adjusted `SpawnOpts` and the broker handle.
 *  2. Caller passes `result.spawnOpts` to an adapter's `spawn()`.
 *  3. Caller runs the agent to completion.
 *  4. Caller invokes `result.shutdown()` — idempotent; safe to call after
 *     the adapter's own shutdown has already reaped the subprocess.
 *
 * Double-shutdown is explicitly supported: the underlying broker handle's
 * `shutdown()` is idempotent, and this helper guards against calling it
 * twice from our side too (the subscriber unsubscribes are drained once).
 *
 * ### Layering
 *
 * This module deliberately imports ONLY `@shamu/egress-broker` and
 * `@shamu/adapters-base` (for the `SpawnOpts` type). Pulling in
 * `@shamu/core-supervisor` / `@shamu/mailbox` / `@shamu/watchdog` here would
 * re-create the layering regression the composition package exists to
 * prevent.
 */

import type { SpawnOpts } from "@shamu/adapters-base/adapter";
import {
  createEgressBroker,
  type EgressBrokerHandle,
  type EgressPolicy,
  type PolicyEgressAllowedEvent,
  type PolicyEgressDeniedEvent,
} from "@shamu/egress-broker";

/**
 * Optional event sink. Invoked for every `policy.egress_allowed` /
 * `policy.egress_denied` emission from the broker. Listener throws are
 * swallowed by the broker's emitter — this callback never takes down the
 * broker.
 *
 * Not coupled to `@shamu/core-supervisor`'s escalation bus: that wiring is a
 * separate composition primitive (`createEscalationEmitter` in this
 * package). A caller that wants both can forward from this `onEvent` into
 * the supervisor bus.
 */
export type EgressBrokerEventHandler = (
  type: "allowed" | "denied",
  event: PolicyEgressAllowedEvent | PolicyEgressDeniedEvent,
) => void;

export interface WithEgressBrokerOptions {
  /** The validated policy the broker enforces. */
  readonly policy: EgressPolicy;
  /**
   * The `SpawnOpts` the caller would otherwise have passed to the adapter.
   * The helper returns a new object with `env` augmented by the broker's
   * proxy vars; all other fields pass through verbatim.
   */
  readonly baseSpawnOpts: SpawnOpts;
  /** Optional event sink — see `EgressBrokerEventHandler`. */
  readonly onEvent?: EgressBrokerEventHandler;
  /**
   * Bind host for the broker. Defaults to `127.0.0.1`; override only if the
   * caller knows what they're doing (non-loopback binds expose the proxy
   * to the LAN). Typically unused.
   */
  readonly host?: string;
  /**
   * Bind port. Default `0` (OS-assigned). Override when the caller wants a
   * predictable port for debugging.
   */
  readonly port?: number;
  /** Clock override. Forwarded to the broker for deterministic tests. */
  readonly now?: () => number;
}

export interface WithEgressBrokerResult {
  /** The started broker handle. `url` is populated. */
  readonly brokerHandle: EgressBrokerHandle;
  /**
   * `baseSpawnOpts` + `env: { HTTPS_PROXY, HTTP_PROXY, NO_PROXY }`. Keys
   * present on `baseSpawnOpts.env` are preserved; the three proxy keys are
   * overridden (later wins).
   */
  readonly spawnOpts: SpawnOpts;
  /**
   * Idempotent broker teardown. Safe to call multiple times. Safe to call
   * after the adapter's own `shutdown()` has completed.
   */
  shutdown(): Promise<void>;
}

/**
 * Default `NO_PROXY` value. Keeps broker-internal traffic + other-loopback
 * tools out of the proxy tunnel. `127.0.0.1` and `localhost` cover every
 * run-local dev-tool the adapter subprocesses call into (docker daemons,
 * localhost dashboards, etc.).
 */
const DEFAULT_NO_PROXY = "127.0.0.1,localhost";

/**
 * Create a started broker, build the adjusted `SpawnOpts`, and wire the
 * optional event sink. The broker is fully started (listening + `url`
 * populated) before this function resolves.
 */
export async function withEgressBroker(
  opts: WithEgressBrokerOptions,
): Promise<WithEgressBrokerResult> {
  const brokerHandle = createEgressBroker({
    policy: opts.policy,
    ...(opts.host !== undefined ? { host: opts.host } : {}),
    ...(opts.port !== undefined ? { port: opts.port } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });

  // Wire the event sink BEFORE we start — the broker is quiescent until
  // listen completes, but subscribing early guarantees the caller sees
  // every event from the first connection onwards.
  const unsubscribers: Array<() => void> = [];
  if (opts.onEvent) {
    const handler = opts.onEvent;
    unsubscribers.push(
      brokerHandle.on("policy.egress_allowed", (ev) => {
        try {
          handler("allowed", ev);
        } catch {
          // best-effort — broker emitter already swallows listener throws,
          // but the extra guard keeps the helper honest if a listener
          // synchronously throws inside our own wrapper.
        }
      }),
    );
    unsubscribers.push(
      brokerHandle.on("policy.egress_denied", (ev) => {
        try {
          handler("denied", ev);
        } catch {
          // best-effort — see above.
        }
      }),
    );
  }

  try {
    await brokerHandle.start();
  } catch (cause) {
    // Start failure — reap any subscribers we created, rethrow to the
    // caller so their own cleanup path can run.
    for (const un of unsubscribers) {
      try {
        un();
      } catch {
        // ignore
      }
    }
    throw cause;
  }

  const brokerUrl = brokerHandle.url;
  const mergedEnv: Record<string, string> = {};
  if (opts.baseSpawnOpts.env) {
    for (const [k, v] of Object.entries(opts.baseSpawnOpts.env)) {
      if (typeof v === "string") mergedEnv[k] = v;
    }
  }
  mergedEnv.HTTPS_PROXY = brokerUrl;
  mergedEnv.HTTP_PROXY = brokerUrl;
  mergedEnv.NO_PROXY = DEFAULT_NO_PROXY;

  const spawnOpts: SpawnOpts = {
    ...opts.baseSpawnOpts,
    env: mergedEnv,
  };

  let shutdownStarted = false;
  let shutdownPromise: Promise<void> | null = null;
  const shutdown = async (): Promise<void> => {
    if (shutdownStarted) {
      // Second caller — wait for the first to finish, but don't double-reap.
      if (shutdownPromise) {
        try {
          await shutdownPromise;
        } catch {
          // ignore — first caller already saw it.
        }
      }
      return;
    }
    shutdownStarted = true;
    shutdownPromise = (async () => {
      for (const un of unsubscribers) {
        try {
          un();
        } catch {
          // best-effort
        }
      }
      try {
        await brokerHandle.shutdown();
      } catch {
        // Broker shutdown is itself best-effort; swallow so a caller's
        // finally-block cleanup never fails because the broker already
        // tore itself down on an error path.
      }
    })();
    await shutdownPromise;
  };

  return {
    brokerHandle,
    spawnOpts,
    shutdown,
  };
}
