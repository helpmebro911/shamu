/**
 * Exit-code plumbing between commands and the entry point.
 *
 * citty's `runCommand` discards subcommand return values (it only returns the
 * root handler's result). To make per-command exit codes first-class we use a
 * module-scoped holder: command handlers call `setExitCode` before returning;
 * `index.ts` reads the result once and invokes `process.exit` a single time.
 *
 * This keeps command handlers pure (they return an ExitCode) and lets tests
 * drive commands via `runCommand` without stubbing citty.
 */

import { ExitCode, type ExitCodeValue } from "./exit-codes.ts";

let currentExitCode: ExitCodeValue = ExitCode.OK;

export function setExitCode(code: ExitCodeValue): ExitCodeValue {
  currentExitCode = code;
  return code;
}

export function getExitCode(): ExitCodeValue {
  return currentExitCode;
}

export function resetExitCode(): void {
  currentExitCode = ExitCode.OK;
}
