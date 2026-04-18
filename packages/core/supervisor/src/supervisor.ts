/**
 * `Supervisor` — OTP-shaped supervision over a fixed list of `ChildSpec`s.
 *
 * Lifecycle contract:
 *   idle → starting → running → stopping → stopped
 *   Any failure during `start()` lands in `stopped`; same for intensity
 *   exceeded during the running phase (after publishing an escalation).
 *
 * Restart strategies (per-child policy, resolved at construction):
 *   - one_for_one: only the failed child restarts.
 *   - rest_for_one: the failed child + every sibling that appeared AFTER it
 *     in the spec order restart. Earlier siblings keep running.
 *
 * Escalation:
 *   Each child has its own intensity tracker. If the tracker's window would
 *   exceed `policy.intensity` on the next restart, the supervisor publishes
 *   an `EscalationRaised` on the bus and transitions to `stopped` WITHOUT
 *   invoking the factory again. The parent (role/swarm) owns the next
 *   step; the supervisor does not auto-bounce back to running.
 *
 * Invariants enforced by the implementation:
 *   - childIds are unique inside a supervisor; duplicates throw at
 *     construction time.
 *   - A crashed child's `WorkerHandle` is fully discarded; a fresh factory
 *     call produces the replacement.
 *   - `onExit` listeners are registered before `start()` returns so a
 *     worker that exits synchronously-after-start is observed.
 *   - Exit reason "normal" is terminal for that child slot; the supervisor
 *     does not restart normals. A later phase may add a "transient"/
 *     "permanent" policy knob; today, normal-exit is simply "done".
 */

import type { BusListener } from "./bus.ts";
import { EventBus } from "./bus.ts";
import type {
  ChildRestarted,
  ChildStarted,
  ChildStopped,
  EscalationCause,
  EscalationRaised,
  SupervisorEvent,
} from "./events.ts";
import { IntensityTracker } from "./intensity.ts";
import { resolvePolicy, validateRestartPolicy } from "./policy.ts";
import type {
  ChildSpec,
  ExitInfo,
  ExitReason,
  RestartPolicy,
  SupervisorState,
  WorkerHandle,
} from "./types.ts";

/** Injectable wall-clock source. Separated from the intensity clock so
 *  tests can freeze either independently. */
export type SupervisorClock = () => number;
const defaultSupervisorClock: SupervisorClock = () => Date.now();

export interface SupervisorOptions {
  /**
   * Optional identifier surfaced on published events. Defaults to `null`.
   * The `Swarm` wrapper sets it to the role name so listeners can filter.
   */
  readonly roleId?: string;
  /**
   * Optional swarm id. `Swarm` fills this in; standalone tests leave null.
   */
  readonly swarmId?: string;
  /**
   * Bus to publish lifecycle + escalation events on. Supply one shared by
   * the whole `Swarm` so listeners get a single subscription point. If
   * omitted, each supervisor creates its own private bus (handy in tests).
   */
  readonly bus?: EventBus<SupervisorEvent>;
  /** Override the wall-clock for deterministic event timestamps. */
  readonly clock?: SupervisorClock;
  /**
   * Override the intensity-window clock. Also injected into every child's
   * tracker. Defaults to the same source as `clock` when omitted.
   */
  readonly intensityClock?: () => number;
}

interface ChildRecord {
  readonly spec: ChildSpec;
  readonly policy: RestartPolicy;
  readonly intensity: IntensityTracker;
  handle: WorkerHandle | null;
  /** Disposer returned by `handle.onExit`. */
  unsubscribeExit: (() => void) | null;
  /** 0 on first start; increments on each restart. */
  startCount: number;
  /**
   * True while the supervisor has asked the child to stop (via stop() or
   * an orchestrated rest_for_one restart). Used to suppress spurious
   * restart bookkeeping when the exit listener fires.
   */
  stopping: boolean;
}

/**
 * Supervise a fixed set of children under a single role-level policy.
 */
export class Supervisor {
  public readonly roleId: string | null;
  public readonly swarmId: string | null;

  private readonly records: ChildRecord[] = [];
  private readonly bus: EventBus<SupervisorEvent>;
  private readonly ownsBus: boolean;
  private readonly clock: SupervisorClock;
  private readonly intensityClock: () => number;
  private _state: SupervisorState = "idle";

  constructor(
    basePolicy: RestartPolicy,
    specs: readonly ChildSpec[],
    options: SupervisorOptions = {},
  ) {
    validateRestartPolicy(basePolicy);

    const seen = new Set<string>();
    for (const spec of specs) {
      if (seen.has(spec.childId)) {
        throw new Error(`duplicate childId in supervisor specs: ${spec.childId}`);
      }
      seen.add(spec.childId);
    }

    this.roleId = options.roleId ?? null;
    this.swarmId = options.swarmId ?? null;
    this.clock = options.clock ?? defaultSupervisorClock;
    this.intensityClock = options.intensityClock ?? this.clock;

    if (options.bus) {
      this.bus = options.bus;
      this.ownsBus = false;
    } else {
      this.bus = new EventBus<SupervisorEvent>();
      this.ownsBus = true;
    }

    for (const spec of specs) {
      const policy = resolvePolicy(basePolicy, spec.restartOverrides);
      this.records.push({
        spec,
        policy,
        intensity: new IntensityTracker(this.intensityClock),
        handle: null,
        unsubscribeExit: null,
        startCount: 0,
        stopping: false,
      });
    }
  }

  /** Current lifecycle state. */
  get state(): SupervisorState {
    return this._state;
  }

  /** Subscribe to supervisor events. Wraps the underlying bus. */
  subscribe(listener: BusListener<SupervisorEvent>): () => void {
    return this.bus.subscribe(listener);
  }

  /**
   * Start every child in spec order.
   *
   * If any child's factory rejects (or `start()` on its handle rejects),
   * the supervisor publishes an `EscalationRaised` with cause
   * `start_failed`, stops any earlier children, and resolves in the
   * `stopped` state. Partial start is treated as a startup fault.
   */
  async start(): Promise<void> {
    if (this._state !== "idle") {
      throw new Error(`Supervisor.start: expected idle, got ${this._state}`);
    }
    this._state = "starting";

    for (const record of this.records) {
      try {
        await this.bootRecord(record);
      } catch (err) {
        this.emitEscalation(
          record,
          "start_failed",
          err instanceof Error ? err.message : `start failed: ${String(err)}`,
        );
        await this.teardownRunningChildren("supervisor_start_failed");
        this._state = "stopped";
        return;
      }
    }

    this._state = "running";
  }

  /**
   * Stop every child in reverse spec order. Idempotent. Safe to call from
   * any state except `starting` (which is transient and would race the
   * start loop).
   */
  async stop(reason = "supervisor_stop"): Promise<void> {
    if (this._state === "stopped" || this._state === "idle") {
      this._state = "stopped";
      if (this.ownsBus) this.bus.clear();
      return;
    }
    if (this._state === "stopping") return;
    this._state = "stopping";
    await this.teardownRunningChildren(reason);
    this._state = "stopped";
    if (this.ownsBus) this.bus.clear();
  }

  /**
   * Add a child at runtime. Allowed in `idle` (before start()) and
   * `running` (dynamic add). Throws from `stopping`/`stopped` to avoid
   * half-states.
   *
   * A child added while `running` is started immediately; its intensity
   * window starts empty. Ordering is append-only, which matters for
   * `rest_for_one`.
   */
  async addChild(spec: ChildSpec, policyOverride?: RestartPolicy): Promise<void> {
    if (this._state !== "idle" && this._state !== "running") {
      throw new Error(`Supervisor.addChild: disallowed in state ${this._state}`);
    }
    if (this.records.some((r) => r.spec.childId === spec.childId)) {
      throw new Error(`duplicate childId: ${spec.childId}`);
    }
    const basePolicy = policyOverride
      ? validateRestartPolicy(policyOverride)
      : this.records[0]?.policy;
    if (!basePolicy) {
      throw new Error("Supervisor.addChild: no policy available; supply policyOverride");
    }
    const record: ChildRecord = {
      spec,
      policy: resolvePolicy(basePolicy, spec.restartOverrides),
      intensity: new IntensityTracker(this.intensityClock),
      handle: null,
      unsubscribeExit: null,
      startCount: 0,
      stopping: false,
    };
    this.records.push(record);
    if (this._state === "running") {
      try {
        await this.bootRecord(record);
      } catch (err) {
        this.emitEscalation(
          record,
          "start_failed",
          err instanceof Error ? err.message : `start failed: ${String(err)}`,
        );
        // Leave record in place but unstarted; caller can inspect state.
      }
    }
  }

  /**
   * Remove a child and stop its handle. No-op if the child isn't present.
   */
  async removeChild(childId: string, reason = "removed"): Promise<void> {
    const idx = this.records.findIndex((r) => r.spec.childId === childId);
    if (idx === -1) return;
    const record = this.records[idx];
    if (!record) return;
    await this.stopRecord(record, reason);
    this.records.splice(idx, 1);
  }

  /** Snapshot of the record view, primarily for tests + inspection UIs. */
  children(): ReadonlyArray<{
    readonly childId: string;
    readonly startCount: number;
    readonly restartsInWindow: number;
    readonly policy: RestartPolicy;
  }> {
    return this.records.map((r) => ({
      childId: r.spec.childId,
      startCount: r.startCount,
      restartsInWindow: r.intensity.count(r.policy.withinMs),
      policy: r.policy,
    }));
  }

  // --- Internals ------------------------------------------------------------

  private async bootRecord(record: ChildRecord): Promise<void> {
    const handle = await record.spec.factory();
    record.handle = handle;
    record.stopping = false;
    // Subscribe BEFORE `start()` so a handle that exits synchronously from
    // inside start() still notifies us. A disposer is stored; we tear it
    // down any time we stop the child (orchestrated) OR the child exits
    // and we create a fresh handle.
    record.unsubscribeExit = handle.onExit((info) => {
      this.handleExit(record, info);
    });
    await handle.start();
    this.bus.publish(this.makeChildStarted(record));
  }

  private async stopRecord(record: ChildRecord, reason: string): Promise<void> {
    if (!record.handle) return;
    record.stopping = true;
    const handle = record.handle;
    const dispose = record.unsubscribeExit;
    record.unsubscribeExit = null;
    record.handle = null;
    if (dispose) dispose();
    try {
      await handle.stop(reason);
    } catch {
      // Swallow: a handle that fails to stop cleanly is already dead; we
      // don't want teardown to turn into cascading failures. A richer
      // impl could log via @shamu/shared/logger — deferred.
    }
    this.bus.publish(this.makeChildStopped(record, reason));
  }

  private async teardownRunningChildren(reason: string): Promise<void> {
    // Reverse spec order so dependents come down before their dependencies.
    for (let i = this.records.length - 1; i >= 0; i--) {
      const record = this.records[i];
      if (!record) continue;
      await this.stopRecord(record, reason);
    }
  }

  private handleExit(record: ChildRecord, info: ExitInfo): void {
    // If we deliberately stopped the child, the exit is expected; nothing
    // to do. The `stopRecord` path already published `child_stopped`.
    if (record.stopping) return;

    // The handle is dead regardless of reason; drop our references so a
    // restart installs a fresh one.
    if (record.unsubscribeExit) {
      record.unsubscribeExit();
      record.unsubscribeExit = null;
    }
    record.handle = null;

    if (info.reason === "normal") {
      // Normal exit is terminal for this child. Publish a ChildStopped for
      // observability and do not restart. If this was the last running
      // child, the supervisor nevertheless remains in `running` — the
      // parent decides whether to stop the whole supervisor.
      this.bus.publish(this.makeChildStopped(record, "normal"));
      return;
    }

    // Crash or kill: consult policy + intensity.
    this.restartOrEscalate(record, info.reason).catch((err) => {
      // The restart orchestration is async (awaits factory + start). If
      // it throws, escalate via the same path `start_failed` uses so the
      // user still sees a signal.
      this.emitEscalation(
        record,
        "start_failed",
        err instanceof Error ? err.message : `restart failed: ${String(err)}`,
      );
    });
  }

  private async restartOrEscalate(
    record: ChildRecord,
    exitReason: Exclude<ExitReason, "normal">,
  ): Promise<void> {
    const { policy } = record;
    if (record.intensity.shouldEscalate(policy.intensity, policy.withinMs)) {
      this.emitEscalation(
        record,
        "intensity_exceeded",
        `restart budget exceeded: ${record.intensity.count(policy.withinMs)} restarts within ${policy.withinMs}ms`,
      );
      // Intensity-exceeded: stop the whole supervisor. The parent handles
      // what happens next (role reports up, swarm halts, CLI sink shows
      // the escalation). We do NOT auto-restart.
      if (this._state !== "stopping" && this._state !== "stopped") {
        await this.teardownRunningChildren("intensity_exceeded");
        this._state = "stopped";
        if (this.ownsBus) this.bus.clear();
      }
      return;
    }

    // Record the restart stamp BEFORE attempting the restart so a storm of
    // factory failures still trips escalation on the Nth.
    record.intensity.record();
    record.startCount += 1;
    this.bus.publish(this.makeChildRestarted(record, exitReason));

    // Apply strategy.
    if (policy.strategy === "rest_for_one") {
      await this.restartRestForOne(record);
      return;
    }
    // Default path: one_for_one.
    await this.bootRecord(record);
  }

  private async restartRestForOne(failed: ChildRecord): Promise<void> {
    const idx = this.records.indexOf(failed);
    if (idx === -1) {
      // Shouldn't happen — record is from our own array.
      return;
    }
    // Stop children that started AFTER the failed one, in reverse order.
    for (let i = this.records.length - 1; i > idx; i--) {
      const later = this.records[i];
      if (!later) continue;
      await this.stopRecord(later, "rest_for_one");
    }
    // Restart the failed one first, then every later sibling in order.
    await this.bootRecord(failed);
    for (let i = idx + 1; i < this.records.length; i++) {
      const later = this.records[i];
      if (!later) continue;
      await this.bootRecord(later);
    }
  }

  private emitEscalation(record: ChildRecord, cause: EscalationCause, reason: string): void {
    const event: EscalationRaised = {
      kind: "escalation_raised",
      swarmId: this.swarmId,
      roleId: this.roleId,
      childId: record.spec.childId,
      cause,
      reason,
      at: this.clock(),
      restartsInWindow: record.intensity.count(record.policy.withinMs),
      target: record.policy.escalate,
    };
    this.bus.publish(event);
  }

  private makeChildStarted(record: ChildRecord): ChildStarted {
    return {
      kind: "child_started",
      swarmId: this.swarmId,
      roleId: this.roleId,
      childId: record.spec.childId,
      at: this.clock(),
      startCount: record.startCount,
    };
  }

  private makeChildStopped(record: ChildRecord, reason: string): ChildStopped {
    return {
      kind: "child_stopped",
      swarmId: this.swarmId,
      roleId: this.roleId,
      childId: record.spec.childId,
      at: this.clock(),
      reason,
    };
  }

  private makeChildRestarted(
    record: ChildRecord,
    exitReason: Exclude<ExitReason, "normal">,
  ): ChildRestarted {
    return {
      kind: "child_restarted",
      swarmId: this.swarmId,
      roleId: this.roleId,
      childId: record.spec.childId,
      at: this.clock(),
      exitReason,
    };
  }
}
