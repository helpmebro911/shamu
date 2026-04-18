/**
 * @shamu/watchdog — public surface.
 *
 * Out-of-process watchdog: four signal evaluators, agreement buffer,
 * two-observation promotion rule, and a subprocess wrapper that runs
 * the loop with the shamu SQLite DB opened read-only.
 */

export type { AgreementBufferOptions, IngestResult } from "./agreement.ts";
export { AgreementBuffer } from "./agreement.ts";
export { canonicalizeArgs } from "./canonicalize.ts";
export type { CiTripwire, CiTripwireObservation, CiTripwireOptions } from "./ci-tripwire.ts";
export { createCiTripwire } from "./ci-tripwire.ts";
export type { WatchdogEmitter, WatchdogEvent } from "./events.ts";
export { noopEmitter } from "./events.ts";
export { evaluateCheckpointLag, evaluateRunCheckpointLag } from "./signals/checkpoint-lag.ts";
export { evaluateCostVelocity } from "./signals/cost-velocity.ts";
export {
  evaluateNoWriteActivity,
  evaluateRunNoWriteActivity,
} from "./signals/no-write-activity.ts";
export type { NormalizedToolCall } from "./signals/tool-loop.ts";
export {
  evaluateRunToolLoop,
  evaluateToolLoop,
  ToolLoopDedupState,
} from "./signals/tool-loop.ts";
export type { ReadOnlyPreparedStatement, ReadOnlyWatchdogDatabase } from "./store.ts";
export { openReadOnlyDatabase } from "./store.ts";
export type { SpawnWatchdogOptions, WatchdogHandle } from "./subprocess.ts";
export { spawnWatchdogSubprocess } from "./subprocess.ts";
export type {
  Confidence,
  Observation,
  SignalKind,
  WatchdogAlert,
  WatchdogCiTripwire,
  WatchdogConfig,
  WatchdogHint,
  WriteToolAllowlist,
} from "./types.ts";
export { DEFAULT_WATCHDOG_CONFIG } from "./types.ts";
export type { WatchdogState } from "./watchdog.ts";
export { createWatchdogState, runWatchdog } from "./watchdog.ts";
