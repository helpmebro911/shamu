/**
 * Output helpers.
 *
 * Every command supports:
 *   - human text (default) — ANSI colors only when stdout is a TTY
 *   - `--json` newline-delimited JSON events
 *   - `--watch` tail-follow (status, logs) — re-renders on change
 *
 * These helpers centralize the stdout/stderr boundary so commands stay terse.
 */

// TODO(1.B): wire the real redactor from @shamu/shared/redactor. Placeholder
// that is a pass-through so the output surface is stable now; swap in later.
function redact(text: string): string {
  return text;
}

export type OutputMode = "human" | "json";

export interface OutputOptions {
  readonly json: boolean;
}

/** Resolve the output mode from the command's `--json` flag. */
export function modeFrom(opts: OutputOptions): OutputMode {
  return opts.json ? "json" : "human";
}

/** Write a human-facing line to stdout. Suppressed when `--json` is active. */
export function writeHuman(mode: OutputMode, line: string): void {
  if (mode !== "human") return;
  process.stdout.write(`${redact(line)}\n`);
}

/** Write a newline-delimited JSON object to stdout. Only active under `--json`. */
export function writeJson(mode: OutputMode, obj: unknown): void {
  if (mode !== "json") return;
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

/** Always print a diagnostic line to stderr; never swallowed by `--json`. */
export function writeDiag(line: string): void {
  process.stderr.write(`${redact(line)}\n`);
}

/** True if stdout is a TTY and ANSI is appropriate. */
export function ansiEnabled(): boolean {
  return Boolean(process.stdout.isTTY);
}

/**
 * Render a watch/tail loop with graceful cancellation.
 *
 * The `tick` callback is invoked repeatedly until cancelled via SIGINT/SIGTERM
 * or the returned AbortSignal. This is a placeholder shape for later phases —
 * SQLite trigger-driven updates land in Phase 2+. For now `tick` is just polled
 * on `intervalMs`.
 */
export interface WatchOptions {
  readonly intervalMs: number;
  readonly signal?: AbortSignal;
}

export async function writeWatch(
  tick: () => Promise<void> | void,
  options: WatchOptions,
): Promise<void> {
  const controller = new AbortController();
  const onSigint = (): void => controller.abort();
  const onSigterm = (): void => controller.abort();
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  const parentAbort = (): void => controller.abort();
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener("abort", parentAbort, { once: true });
  }

  try {
    while (!controller.signal.aborted) {
      await tick();
      await sleepCancelable(options.intervalMs, controller.signal);
    }
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    if (options.signal) options.signal.removeEventListener("abort", parentAbort);
  }
}

function sleepCancelable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
