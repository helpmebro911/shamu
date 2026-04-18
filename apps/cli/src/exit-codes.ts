/**
 * Exit-code taxonomy.
 *
 * Every command returns one of these. `src/index.ts` maps the return value to
 * `process.exit(...)` exactly once. Unhandled errors in async paths are caught
 * at the top level and mapped to `INTERNAL`.
 *
 * Codes are intentionally sparse — we leave gaps between groups (0..4 user/config,
 * 10..13 runtime, 20 internal) so later phases can insert new codes without
 * breaking existing callers.
 */
export const ExitCode = {
  /** Command completed successfully. */
  OK: 0,
  /** Caller ran ctrl-c or an explicit cancel. */
  USER_CANCEL: 1,
  /** Invalid args, missing command, malformed config. */
  USAGE: 2,
  /** Config file invalid or unresolvable. */
  CONFIG_ERROR: 3,
  /** Keychain unreachable or missing auth. */
  CREDENTIALS_ERROR: 4,
  /** Agent run ended red (agent-ci failed, reviewer blocked). */
  RUN_FAILED: 10,
  /** Watchdog tripped, stale-lease escalation, OTP max-intensity. */
  SUPERVISOR_ESCALATION: 11,
  /** agent-ci produced a red result for this run specifically. */
  CI_RED: 12,
  /** SIGINT/SIGTERM received during run. */
  INTERRUPTED: 13,
  /** Unhandled error, bug. */
  INTERNAL: 20,
} as const;

export type ExitCodeName = keyof typeof ExitCode;
export type ExitCodeValue = (typeof ExitCode)[ExitCodeName];

/** Human-readable label for an exit code. Useful in `--json` payloads and logs. */
export function labelFor(code: ExitCodeValue): ExitCodeName {
  const entry = (Object.entries(ExitCode) as [ExitCodeName, ExitCodeValue][]).find(
    ([, value]) => value === code,
  );
  // Every ExitCodeValue is present in ExitCode by construction.
  if (!entry) throw new Error(`unknown exit code ${code}`);
  return entry[0];
}
