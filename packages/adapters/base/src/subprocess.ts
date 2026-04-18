/**
 * `spawnVendorSubprocess` — the one true way to spawn a vendor CLI.
 *
 * Wraps `Bun.spawn` with the contract contract every downstream adapter
 * relies on:
 *
 * 1. **Detached process group (T13).** `detached: true` so every grandchild
 *    the vendor CLI spawns shares the same pgid. `kill()` sends the signal
 *    to `-pgid` (the negative pid is the POSIX convention for "signal this
 *    whole group"), ensuring a rogue `claude → xargs → rg` chain dies with
 *    the parent.
 * 2. **Allow-listed env.** Only keys explicitly passed in `env` reach the
 *    child. `PATH` / `HOME` / `LANG` / `USER` are auto-injected if the
 *    caller doesn't override — they're universally required for a vendor
 *    CLI to resolve Node / keychains / locale. A caller who wants a strict
 *    minimum passes `envMode: "strict"`.
 * 3. **CWD pinned.** `cwd` is required; there is no "inherit cwd" mode.
 * 4. **`vendorCliPath` override** lands as `cmd[0]` when provided.
 * 5. **Node-style drain on stdin writes.** Per 0.A, vendor CLIs are Node
 *    processes; fire-and-forget writes hang Claude under load. We expose
 *    `write(chunk)` as an async function that awaits backpressure before
 *    resolving.
 * 6. **JSONL line splitter on stdout.** `readLines()` is an async iterable
 *    of complete lines (newline stripped), buffered across chunk boundaries.
 * 7. **Clean reap.** `closed` is a `Promise<{code, signal}>` that resolves
 *    once the child has exited, regardless of whether `kill()` was called.
 */

import { SpawnError, SubprocessClosedError } from "./errors.ts";

// The `Bun` global is provided by `@types/bun`. We don't import from "bun"
// directly — that module's type exports shift across Bun versions. Instead
// we pin to the public `Bun.Subprocess<...>` shape through a local alias.
type BunSubprocess = Bun.Subprocess<"pipe", "pipe", "pipe">;

/**
 * Minimum env vars to inject when `envMode: "loose"` (the default). The
 * values are read from `process.env` at spawn time — if any are missing,
 * the corresponding key is simply not passed (no empty-string).
 */
const LOOSE_ENV_ALLOWLIST: readonly string[] = ["PATH", "HOME", "LANG", "USER"];

export type EnvMode = "loose" | "strict";

export interface SpawnVendorSubprocessOptions {
  /** argv. First element is the binary; use `vendorCliPath` to override it. */
  readonly cmd: readonly string[];
  /** The run's worktree. Must be absolute. */
  readonly cwd: string;
  /** Allow-listed env. Keys outside this map are not exposed to the child. */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Default "loose" auto-injects `PATH/HOME/LANG/USER` from the current
   * process. "strict" skips auto-injection — the caller must supply everything.
   */
  readonly envMode?: EnvMode;
  /** Override cmd[0]. Canonical `SpawnOpts.vendorCliPath` flows here. */
  readonly vendorCliPath?: string;
  /**
   * If true (default), the subprocess is spawned detached so kill(-pgid)
   * works. Flip to false only in a test double that's running within the
   * Vitest VM — real adapters should always detach.
   */
  readonly detached?: boolean;
}

export interface VendorSubprocessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface VendorSubprocessHandle {
  readonly pid: number;
  /** Resolves once the child has exited. */
  readonly closed: Promise<VendorSubprocessExit>;
  /** Node-style backpressure write. Rejects after the process has closed. */
  write(chunk: string | Uint8Array): Promise<void>;
  /** JSONL line reader. Strips the trailing `\n`; yields `""` for blank lines. */
  readLines(): AsyncIterable<string>;
  /** Stderr as decoded text chunks. */
  readStderr(): AsyncIterable<string>;
  /** Send a signal. Default SIGTERM. Reaches the whole process group when detached. */
  kill(signal?: NodeJS.Signals | number): void;
}

/** Narrow env resolution. Returns only keys the caller approved. */
function resolveEnv(
  supplied: Readonly<Record<string, string>> | undefined,
  mode: EnvMode,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (mode === "loose") {
    for (const key of LOOSE_ENV_ALLOWLIST) {
      const v = process.env[key];
      if (typeof v === "string" && v.length > 0) out[key] = v;
    }
  }
  if (supplied) {
    for (const [k, v] of Object.entries(supplied)) {
      if (typeof v === "string") out[k] = v;
    }
  }
  return out;
}

/**
 * Minimal "Node-style drain" wrapper over a Bun stdin Writable.
 *
 * Bun.spawn's `stdin` (when `stdin: "pipe"`) is a Bun `FileSink`: `.write`
 * returns either a `number` (bytes enqueued) or a `Promise<number>` (when
 * the internal buffer is full, resolving after a drain). That Promise is
 * the Bun equivalent of Node's `"drain"` event — awaiting it is exactly
 * what 0.A identified as required for Claude/Codex stability.
 *
 * The caller just awaits `write(...)`; we hide the union return type.
 */
export interface BunFileSink {
  write(chunk: string | Uint8Array): number | Promise<number>;
  end?(): void | Promise<void>;
  flush?(): number | Promise<number>;
}

export async function drainingWrite(sink: BunFileSink, chunk: string | Uint8Array): Promise<void> {
  try {
    const r = sink.write(chunk);
    if (typeof r === "number") {
      // Synchronous accept; nothing to await.
      return;
    }
    await r;
  } catch (cause) {
    throw new SubprocessClosedError("Subprocess stdin closed before write completed", cause);
  }
}

/**
 * Drain a `ReadableStream<Uint8Array>` into newline-delimited text chunks.
 * Buffers across chunk boundaries; yields each line WITHOUT the trailing
 * `\n`. Trailing content without a newline is yielded at stream close.
 *
 * Exported for unit tests; production callers go through the handle's
 * `readLines()`.
 */
export async function* readStreamLines(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string, void, unknown> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl = buffer.indexOf("\n");
      while (nl !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        yield line;
        nl = buffer.indexOf("\n");
      }
    }
    // Flush the decoder in case of a trailing multi-byte sequence.
    buffer += decoder.decode();
    if (buffer.length > 0) yield buffer;
  } finally {
    reader.releaseLock();
  }
}

/** Exported sibling of `readStreamLines` that yields unstructured text. */
export async function* readStreamText(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string, void, unknown> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      yield decoder.decode(value, { stream: true });
    }
    const tail = decoder.decode();
    if (tail.length > 0) yield tail;
  } finally {
    reader.releaseLock();
  }
}

/**
 * The production entry point. Spawns a vendor CLI with the hardened defaults.
 *
 * Under Bun, returns a handle exposing backpressure-aware `write`, a JSONL
 * line iterator, stderr iterator, and a `closed` promise. Under non-Bun
 * runtimes (Vitest child worker) this throws `SpawnError` — every real
 * caller is already Bun-resident. Tests use `createVirtualHandle` instead.
 */
export function spawnVendorSubprocess(opts: SpawnVendorSubprocessOptions): VendorSubprocessHandle {
  if (typeof Bun === "undefined" || typeof Bun.spawn !== "function") {
    throw new SpawnError(
      "spawnVendorSubprocess requires Bun; tests should use createVirtualHandle() instead",
    );
  }
  if (!opts.cmd || opts.cmd.length === 0) {
    throw new SpawnError("spawnVendorSubprocess: cmd must be a non-empty argv");
  }
  if (typeof opts.cwd !== "string" || opts.cwd.length === 0) {
    throw new SpawnError("spawnVendorSubprocess: cwd must be an absolute path");
  }
  const envMode = opts.envMode ?? "loose";
  const env = resolveEnv(opts.env, envMode);
  const argv = opts.vendorCliPath ? [opts.vendorCliPath, ...opts.cmd.slice(1)] : [...opts.cmd];
  const detached = opts.detached ?? true;

  const spawnOpts = {
    cmd: argv,
    cwd: opts.cwd,
    env,
    stdin: "pipe" as const,
    stdout: "pipe" as const,
    stderr: "pipe" as const,
    ...(detached ? { detached: true } : {}),
  };

  let proc: BunSubprocess;
  try {
    // `Bun.spawn` is overloaded; the three-pipe variant we want is one
    // overload among many. The cast through `unknown` keeps the rest of
    // this module honest about the input shape without pinning to the
    // exact overload layout of a specific bun-types release.
    proc = Bun.spawn(spawnOpts as unknown as Parameters<typeof Bun.spawn>[0]) as BunSubprocess;
  } catch (cause) {
    throw new SpawnError(
      `Failed to spawn ${argv[0]}: ${(cause as Error)?.message ?? cause}`,
      cause,
    );
  }

  const pid = proc.pid;
  if (typeof pid !== "number") {
    throw new SpawnError("Bun.spawn returned a subprocess without a pid");
  }

  // `proc.exited` resolves with the exit code; we wrap it to include signal.
  const closed: Promise<VendorSubprocessExit> = (async () => {
    const code = await proc.exited;
    // Bun doesn't surface `signalCode` on `Subprocess` in current typings;
    // consult it optionally.
    const signal = (proc as unknown as { signalCode?: NodeJS.Signals | null }).signalCode ?? null;
    return { code, signal };
  })();

  // `proc.stdin` is a Bun FileSink.
  const stdin = proc.stdin as unknown as BunFileSink;

  return {
    pid,
    closed,
    write: (chunk) => drainingWrite(stdin, chunk),
    readLines: () => readStreamLines(proc.stdout as ReadableStream<Uint8Array>),
    readStderr: () => readStreamText(proc.stderr as ReadableStream<Uint8Array>),
    kill: (signal) => killProcessGroup(proc, pid, detached, signal),
  };
}

/**
 * Signal a subprocess. When `detached` is true we signal the whole process
 * group via `process.kill(-pgid, signal)` so grandchildren die with the
 * parent (PLAN T13). Falls back to `proc.kill(signal)` otherwise.
 *
 * Exported separately so adapters that manage their own process lifecycle
 * (e.g., re-exec into a different binary) can reuse the reap semantics.
 */
export function killProcessGroup(
  proc: { kill: (signal?: number | NodeJS.Signals) => void },
  pid: number,
  detached: boolean,
  signal?: NodeJS.Signals | number,
): void {
  const sig = signal ?? "SIGTERM";
  if (!detached) {
    try {
      proc.kill(sig);
    } catch {
      // Already dead or permission denied; nothing to recover.
    }
    return;
  }
  // process.kill(-pid, signal) signals the process group on POSIX systems.
  // On Windows (not supported; Phase 1 is macOS + Linux only) this would
  // throw, and we'd fall back to a direct kill.
  try {
    process.kill(-pid, sig);
  } catch {
    try {
      proc.kill(sig);
    } catch {
      // Give up; `closed` will resolve once the child actually exits.
    }
  }
}

// ---------------------------------------------------------------------------
// Test doubles — exported for `@shamu/adapters-base/test/*` and the
// contract suite's `FakeAdapter`. Not re-exported from the package root
// because production code should never reach for them.
// ---------------------------------------------------------------------------

export interface VirtualHandleOptions {
  /** Lines to yield from `readLines()`, in order. */
  readonly stdoutLines?: readonly string[];
  /** Stderr chunks. */
  readonly stderrChunks?: readonly string[];
  /** Optional exit info. Default `{ code: 0, signal: null }`. */
  readonly exit?: VendorSubprocessExit;
  /** Artificial delay between stdout lines (ms). Default 0. */
  readonly yieldDelayMs?: number;
}

/**
 * Build a `VendorSubprocessHandle` that emits prerecorded stdout lines and
 * stderr chunks, without spawning a real child. The contract suite's
 * `FakeAdapter` uses this to prove the suite actually asserts behavior
 * without touching a real vendor binary.
 *
 * `write()` is a no-op that logs to an internal buffer readable via
 * `writtenChunks`.
 */
export function createVirtualHandle(
  options: VirtualHandleOptions = {},
): VendorSubprocessHandle & { readonly writtenChunks: readonly string[] } {
  const written: string[] = [];
  const exit: VendorSubprocessExit = options.exit ?? { code: 0, signal: null };
  const lines = [...(options.stdoutLines ?? [])];
  const stderr = [...(options.stderrChunks ?? [])];
  const yieldDelayMs = options.yieldDelayMs ?? 0;
  let killed = false;
  let resolveClosed!: (v: VendorSubprocessExit) => void;
  const closed = new Promise<VendorSubprocessExit>((r) => {
    resolveClosed = r;
  });

  async function* yieldLines(): AsyncGenerator<string, void, unknown> {
    for (const line of lines) {
      if (killed) break;
      if (yieldDelayMs > 0) await new Promise((r) => setTimeout(r, yieldDelayMs));
      yield line;
    }
    resolveClosed(exit);
  }
  async function* yieldStderr(): AsyncGenerator<string, void, unknown> {
    for (const chunk of stderr) {
      if (killed) break;
      yield chunk;
    }
  }

  return {
    pid: -1,
    closed,
    get writtenChunks(): readonly string[] {
      return written;
    },
    write: async (chunk) => {
      if (killed) throw new SubprocessClosedError("virtual handle is closed");
      written.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    },
    readLines: () => yieldLines(),
    readStderr: () => yieldStderr(),
    kill: () => {
      killed = true;
      resolveClosed({ code: null, signal: "SIGTERM" });
    },
  };
}
