/**
 * @shamu/core-supervisor — public surface.
 *
 * The OTP-shaped supervision tree for Shamu workers. Modules are also
 * addressable individually (`@shamu/core-supervisor/supervisor`,
 * `@shamu/core-supervisor/policy`, etc.) for explicit imports and
 * tree-shaking.
 */

export { type BusListener, EventBus } from "./bus.ts";
export type {
  ChildRestarted,
  ChildStarted,
  ChildStopped,
  EscalationCause,
  EscalationRaised,
  SupervisorEvent,
  SupervisorEventKind,
} from "./events.ts";
export {
  defaultIntensityClock,
  type IntensityClock,
  IntensityTracker,
} from "./intensity.ts";
export {
  DEFAULT_ROLE_POLICIES,
  defaultPolicyForRole,
  InvalidPolicyError,
  resolvePolicy,
  validateRestartPolicy,
} from "./policy.ts";
export {
  Supervisor,
  type SupervisorClock,
  type SupervisorOptions,
} from "./supervisor.ts";
export { Swarm, type SwarmOptions } from "./swarm.ts";
export type {
  ChildSpec,
  EscalationTarget,
  ExitInfo,
  ExitReason,
  KnownRole,
  RestartPolicy,
  RestartPolicyOverrides,
  RestartStrategy,
  SupervisorState,
  WorkerHandle,
} from "./types.ts";
