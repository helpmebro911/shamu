/**
 * `Swarm` — top-of-tree composition of role supervisors.
 *
 * PLAN.md § 4: a Swarm supervises Role supervisors (`planner`, `executor`,
 * `reviewer`, …); each role supervises workers. This file implements the
 * outer ring; the per-role policy application is delegated to
 * `Supervisor`. A Swarm itself is NOT an OTP supervisor in the restart
 * sense — it is the glue that wires role supervisors to one shared bus and
 * reacts to role-level escalations.
 *
 * Contract:
 *   - Roles added via `addRole(name, policy, specs)` are created eagerly;
 *     `start()` starts them in insertion order. A role that fails to
 *     start publishes its own `EscalationRaised`; the swarm stops the
 *     roles already running and transitions to `stopped`.
 *   - An `EscalationRaised` with `target === "swarm"` halts every role;
 *     `target === "role"` leaves sibling roles running (the failed role
 *     will have already transitioned to `stopped` itself). This matches
 *     the PLAN.md defaults (planner/reviewer → swarm, executor → role).
 *   - Listeners attach via `subscribe()` and receive every
 *     `SupervisorEvent` from every role.
 */

import type { BusListener } from "./bus.ts";
import { EventBus } from "./bus.ts";
import type { SupervisorEvent } from "./events.ts";
import { Supervisor, type SupervisorClock } from "./supervisor.ts";
import type { ChildSpec, RestartPolicy, SupervisorState } from "./types.ts";

export interface SwarmOptions {
  readonly swarmId?: string;
  readonly clock?: SupervisorClock;
  readonly intensityClock?: () => number;
}

interface RoleEntry {
  readonly roleId: string;
  readonly supervisor: Supervisor;
}

export class Swarm {
  public readonly swarmId: string | null;

  private readonly bus = new EventBus<SupervisorEvent>();
  private readonly roles: RoleEntry[] = [];
  private readonly clock: SupervisorClock | undefined;
  private readonly intensityClock: (() => number) | undefined;
  private _state: SupervisorState = "idle";
  private readonly internalUnsubscribe: () => void;

  constructor(options: SwarmOptions = {}) {
    this.swarmId = options.swarmId ?? null;
    this.clock = options.clock;
    this.intensityClock = options.intensityClock;

    // Internal listener enforces the swarm-level escalation rule: a role
    // that publishes `target: "swarm"` triggers every sibling to stop.
    // Done via subscribe so the external API stays one-bus.
    this.internalUnsubscribe = this.bus.subscribe((event) => {
      if (event.kind !== "escalation_raised") return;
      if (event.target !== "swarm") return;
      if (this._state !== "running") return;
      // Fire-and-forget: the escalation listener is synchronous, so we
      // schedule the teardown on a microtask to avoid reentrancy into
      // publish() while we're still inside a dispatch.
      queueMicrotask(() => {
        this.stop("swarm_escalation").catch(() => {
          // Teardown errors are already swallowed inside Supervisor.stop;
          // nothing more to do here.
        });
      });
    });
  }

  get state(): SupervisorState {
    return this._state;
  }

  /**
   * Register a role supervisor. Must be called before `start()`. Returns
   * the underlying `Supervisor` so the caller can inspect it in tests; in
   * production code, prefer subscribing to the swarm's bus instead of
   * reaching into a role.
   */
  addRole(roleId: string, policy: RestartPolicy, specs: readonly ChildSpec[]): Supervisor {
    if (this._state !== "idle") {
      throw new Error(`Swarm.addRole: disallowed in state ${this._state}`);
    }
    if (this.roles.some((r) => r.roleId === roleId)) {
      throw new Error(`duplicate roleId: ${roleId}`);
    }
    const supervisor = new Supervisor(policy, specs, {
      roleId,
      ...(this.swarmId !== null ? { swarmId: this.swarmId } : {}),
      bus: this.bus,
      ...(this.clock ? { clock: this.clock } : {}),
      ...(this.intensityClock ? { intensityClock: this.intensityClock } : {}),
    });
    this.roles.push({ roleId, supervisor });
    return supervisor;
  }

  /** Look up a role by id. Returns `undefined` if not registered. */
  role(roleId: string): Supervisor | undefined {
    return this.roles.find((r) => r.roleId === roleId)?.supervisor;
  }

  /** Bus subscription — one stream for every role in the swarm. */
  subscribe(listener: BusListener<SupervisorEvent>): () => void {
    return this.bus.subscribe(listener);
  }

  /**
   * Start every role in insertion order. If any role fails to reach
   * `running` (i.e. its start escalated), the swarm halts all earlier
   * roles and resolves in `stopped`.
   */
  async start(): Promise<void> {
    if (this._state !== "idle") {
      throw new Error(`Swarm.start: expected idle, got ${this._state}`);
    }
    this._state = "starting";
    for (const entry of this.roles) {
      await entry.supervisor.start();
      if (entry.supervisor.state !== "running") {
        // A supervisor that ends start() in any state other than "running"
        // has already published an escalation. Halt the rest of the swarm.
        await this.teardownStartedRoles(entry.roleId, "swarm_start_failed");
        this._state = "stopped";
        this.internalUnsubscribe();
        this.bus.clear();
        return;
      }
    }
    this._state = "running";
  }

  /**
   * Stop every role in reverse registration order. Idempotent. After
   * `stop()`, the swarm's bus is cleared so no stray events slip through
   * to subscribers that forgot to dispose.
   */
  async stop(reason = "swarm_stop"): Promise<void> {
    if (this._state === "stopped") return;
    if (this._state === "stopping") return;
    this._state = "stopping";
    for (let i = this.roles.length - 1; i >= 0; i--) {
      const entry = this.roles[i];
      if (!entry) continue;
      await entry.supervisor.stop(reason);
    }
    this._state = "stopped";
    this.internalUnsubscribe();
    this.bus.clear();
  }

  /**
   * Stop roles that have already been started (up to but not including
   * the failing role). Used during a fault in `start()`.
   */
  private async teardownStartedRoles(failingRoleId: string, reason: string): Promise<void> {
    for (let i = this.roles.length - 1; i >= 0; i--) {
      const entry = this.roles[i];
      if (!entry) continue;
      if (entry.roleId === failingRoleId) continue;
      if (entry.supervisor.state === "running") {
        await entry.supervisor.stop(reason);
      }
    }
  }
}
