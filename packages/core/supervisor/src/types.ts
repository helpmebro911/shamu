/**
 * Core type surface for the supervisor package.
 *
 * PLAN.md § 4 Supervisor:
 *   Swarm supervises Role supervisors; each Role supervises workers.
 *   Restart policies per role are config-driven; intensity-bounded.
 *
 * Workers are abstracted behind `WorkerHandle` rather than the concrete
 * `AgentHandle` from `@shamu/adapters-base` so tests can exercise the
 * supervisor without spinning vendor adapters. The real runtime wraps an
 * `AgentHandle` in a `WorkerHandle` shim; that shim lives in a later phase
 * (flow/runtime) and is NOT in this package's scope.
 */

/**
 * Why a worker exited.
 *
 * - "normal"  — expected shutdown (e.g. task completed). Supervisor leaves
 *               the child stopped and does NOT restart or escalate.
 * - "crashed" — worker threw / faulted. Supervisor consults strategy +
 *               intensity window.
 * - "killed"  — explicit external termination (parent stopped it, deadline
 *               hit, watchdog intervention). Treated like "crashed" for
 *               restart bookkeeping; the reason string carries detail.
 */
export type ExitReason = "normal" | "crashed" | "killed";

/** Payload delivered to `WorkerHandle.onExit` listeners. */
export interface ExitInfo {
  readonly reason: ExitReason;
  readonly error?: Error;
}

/**
 * Minimal worker contract the supervisor depends on.
 *
 * Implementations must:
 *   - Resolve `start()` once the worker is ready (or crash early by rejecting).
 *   - Resolve `stop(reason)` once the worker has settled; must be idempotent.
 *   - Deliver exactly one `onExit` notification per lifecycle. Subsequent
 *     listener registrations after the exit has already fired must be
 *     silently dropped (the supervisor only subscribes once per start).
 */
export interface WorkerHandle {
  readonly id: string;
  start(): Promise<void>;
  stop(reason: string): Promise<void>;
  /** Returns a disposer that unsubscribes the listener. */
  onExit(listener: (info: ExitInfo) => void): () => void;
}

/**
 * Restart strategies actually implemented in this package.
 *
 * - `one_for_one`  — only the failed child restarts; siblings untouched.
 * - `rest_for_one` — restart the failed child and every child that started
 *                    AFTER it in the spec order; earlier siblings untouched.
 *
 * `one_for_all` is deliberately out of scope. See followups in the track
 * writeup; if a role ever wants it, it lands as a separate strategy variant.
 */
export type RestartStrategy = "one_for_one" | "rest_for_one";

/**
 * Where to route an escalation when intensity is exceeded.
 *
 * - "role"  — the role-level supervisor itself escalates. Role stops; the
 *             swarm subscribes to the event and may halt or keep going
 *             depending on the role's `escalate` setting above it.
 * - "swarm" — the swarm escalates; all its roles stop. This is the default
 *             for `planner` and `reviewer` per PLAN.md § 4.
 *
 * The `SupervisorBus` subscriber decides what the user sees; the supervisor
 * itself only publishes the event.
 */
export type EscalationTarget = "role" | "swarm";

/**
 * Restart-window policy. N restarts within `withinMs` are tolerated; the
 * (N+1)th triggers escalation.
 *
 * Values come from per-role defaults (see `policy.ts`) and may be
 * overridden per child via `ChildSpec.restartOverrides`.
 */
export interface RestartPolicy {
  readonly strategy: RestartStrategy;
  readonly intensity: number;
  readonly withinMs: number;
  readonly escalate: EscalationTarget;
}

/**
 * Partial policy overrides usable per-child. All fields optional; missing
 * fields inherit from the role-level policy at resolve time.
 */
export interface RestartPolicyOverrides {
  readonly strategy?: RestartStrategy;
  readonly intensity?: number;
  readonly withinMs?: number;
  readonly escalate?: EscalationTarget;
}

/**
 * Declarative description of a child the supervisor owns.
 *
 * `factory` is invoked on first start AND on every restart, so the returned
 * handle is single-use from the supervisor's perspective. A crashed worker
 * is discarded; a fresh one is created.
 */
export interface ChildSpec {
  readonly childId: string;
  readonly factory: () => Promise<WorkerHandle>;
  readonly restartOverrides?: RestartPolicyOverrides;
}

/**
 * Runtime lifecycle state the supervisor exposes for inspection and tests.
 *
 * - "idle"     — constructed but `start()` has not been called.
 * - "starting" — `start()` is in flight.
 * - "running"  — all children have been started at least once and the
 *                supervisor is actively watching for exits.
 * - "stopping" — `stop()` is in flight.
 * - "stopped"  — terminal after a clean stop OR after escalation. The
 *                supervisor does not auto-restart from this state; the
 *                caller (parent/swarm) decides what to do next.
 */
export type SupervisorState = "idle" | "starting" | "running" | "stopping" | "stopped";

/**
 * Well-known role names used by the swarm's per-role policy defaults.
 *
 * Additional roles may be supplied to `Swarm` with their own policies; this
 * enum only names the ones the Shamu control plane special-cases today.
 */
export type KnownRole = "planner" | "executor" | "reviewer";
