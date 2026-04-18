/**
 * Per-role default restart policies and policy merging/validation helpers.
 *
 * Defaults mirror PLAN.md § 4:
 *
 *   planner:  intensity 3 / 60s, one_for_one, escalate swarm
 *   executor: intensity 5 / 300s, one_for_one, escalate role
 *   reviewer: intensity 2 / 120s, one_for_one, escalate swarm
 *
 * `validateRestartPolicy` rejects nonsense early so a misconfigured role
 * fails at boot instead of silently never escalating (intensity=0) or
 * thrashing (withinMs=0).
 */

import type {
  EscalationTarget,
  KnownRole,
  RestartPolicy,
  RestartPolicyOverrides,
  RestartStrategy,
} from "./types.ts";

const VALID_STRATEGIES: ReadonlySet<RestartStrategy> = new Set<RestartStrategy>([
  "one_for_one",
  "rest_for_one",
]);

const VALID_ESCALATE: ReadonlySet<EscalationTarget> = new Set<EscalationTarget>(["role", "swarm"]);

/**
 * Default restart policies keyed by role name. Exposed as a frozen object so
 * callers cannot mutate the defaults in place — overrides must be applied
 * explicitly via `resolvePolicy`.
 */
export const DEFAULT_ROLE_POLICIES: Readonly<Record<KnownRole, RestartPolicy>> = Object.freeze({
  planner: Object.freeze({
    strategy: "one_for_one" as RestartStrategy,
    intensity: 3,
    withinMs: 60_000,
    escalate: "swarm" as EscalationTarget,
  }),
  executor: Object.freeze({
    strategy: "one_for_one" as RestartStrategy,
    intensity: 5,
    withinMs: 300_000,
    escalate: "role" as EscalationTarget,
  }),
  reviewer: Object.freeze({
    strategy: "one_for_one" as RestartStrategy,
    intensity: 2,
    withinMs: 120_000,
    escalate: "swarm" as EscalationTarget,
  }),
});

/**
 * Thrown when a caller supplies a policy whose fields are out of range. Not
 * a `ShamuError` subclass on purpose — this is a programmer error in the
 * wiring-up code, not an operator-visible fault. Fail loud, fail early.
 */
export class InvalidPolicyError extends Error {
  public override readonly name = "InvalidPolicyError";
}

/**
 * Validate a fully-resolved `RestartPolicy`. Throws `InvalidPolicyError` on
 * the first problem it spots. Returns the input unchanged on success so it
 * can be used fluently.
 */
export function validateRestartPolicy(policy: RestartPolicy): RestartPolicy {
  if (!VALID_STRATEGIES.has(policy.strategy)) {
    throw new InvalidPolicyError(`unknown restart strategy: ${String(policy.strategy)}`);
  }
  if (!VALID_ESCALATE.has(policy.escalate)) {
    throw new InvalidPolicyError(`unknown escalate target: ${String(policy.escalate)}`);
  }
  if (!Number.isInteger(policy.intensity) || policy.intensity < 0) {
    throw new InvalidPolicyError(`intensity must be a non-negative integer: ${policy.intensity}`);
  }
  if (!Number.isFinite(policy.withinMs) || policy.withinMs <= 0) {
    throw new InvalidPolicyError(`withinMs must be a positive number of ms: ${policy.withinMs}`);
  }
  return policy;
}

/**
 * Merge per-child overrides onto a role-level base policy and validate the
 * result. Callers rely on this at supervisor construction time so every
 * child has a concrete, validated policy before any worker is spawned.
 */
export function resolvePolicy(
  base: RestartPolicy,
  overrides?: RestartPolicyOverrides,
): RestartPolicy {
  const merged: RestartPolicy = {
    strategy: overrides?.strategy ?? base.strategy,
    intensity: overrides?.intensity ?? base.intensity,
    withinMs: overrides?.withinMs ?? base.withinMs,
    escalate: overrides?.escalate ?? base.escalate,
  };
  return validateRestartPolicy(merged);
}

/**
 * Look up the default policy for a well-known role. Surfaces an explicit
 * error if a caller passes an unknown role string — easier to debug than a
 * silent fall-through to `executor` defaults.
 */
export function defaultPolicyForRole(role: KnownRole): RestartPolicy {
  const policy = DEFAULT_ROLE_POLICIES[role];
  if (!policy) {
    throw new InvalidPolicyError(`no default policy registered for role: ${String(role)}`);
  }
  return policy;
}
