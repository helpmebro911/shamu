/**
 * `shamu linear tunnel` — spawn `cloudflared` and pipe its stdout/stderr
 * through so the caller sees the ephemeral URL it prints.
 *
 * Scope is NOT enforced at the cloudflared layer — cloudflared tunnels a
 * whole listener, not a URL prefix. The `/webhooks/linear` scope is enforced
 * by the server (every other path 404s), which implements G10 in practice.
 * The CLI surface still messages the restriction so operators don't assume a
 * broader reach.
 *
 * Behaviour:
 *   - Check `cloudflared` is on `PATH` first; surface a clear error if not.
 *   - Spawn with `--url http://<host>:<port>` and stdio inherited.
 *   - Install a one-shot SIGTERM handler that reaps the child cleanly; the
 *     handler is removed after the child exits so we don't leak listeners.
 *   - Return a handle with `{pid, exited, stop()}` so callers can await or
 *     kill programmatically.
 */

import type { ChildProcess } from "node:child_process";
import { spawn as nodeSpawn, spawnSync } from "node:child_process";

export interface TunnelOptions {
  /** Local host that the webhook server listens on. */
  readonly host: string;
  /** Local port that the webhook server listens on. */
  readonly port: number;
  /** Override for the `cloudflared` binary (absolute or on PATH). */
  readonly bin?: string;
  /** Override for stdout destination. Defaults to `process.stdout`. */
  readonly stdout?: NodeJS.WritableStream;
  /** Override for stderr destination. Defaults to `process.stderr`. */
  readonly stderr?: NodeJS.WritableStream;
  /**
   * Injected spawn implementation. Defaults to `node:child_process.spawn`.
   * Tests use this to avoid actually launching cloudflared.
   */
  readonly spawnImpl?: SpawnImpl;
  /**
   * Injected PATH-lookup. Defaults to `spawnSync(bin, ['--version'])`.
   * Tests use this to stub away the binary-presence check.
   */
  readonly checkBinary?: (bin: string) => BinaryCheckResult;
  /** Grace period (ms) between SIGTERM and hard-kill when stopping. Default 3000. */
  readonly stopGraceMs?: number;
  /**
   * Install a `process.on("SIGTERM", ...)` handler that calls `stop()` on
   * this tunnel. Default: true for callers that own the process (CLI);
   * tests pass false.
   */
  readonly installSigtermHandler?: boolean;
}

export interface TunnelHandle {
  readonly pid: number | null;
  readonly argv: readonly string[];
  /** Resolves when the child has exited (code + signal). */
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** Send SIGTERM and wait for exit (SIGKILL after grace period). */
  stop(): Promise<void>;
}

export type BinaryCheckResult = { present: true } | { present: false; detail: string };

export type SpawnImpl = (
  command: string,
  args: readonly string[],
  options: {
    stdio: ["ignore", "pipe", "pipe"];
  },
) => ChildProcess;

/** Default PATH lookup for cloudflared. */
export const defaultCheckBinary = (bin: string): BinaryCheckResult => {
  try {
    const result = spawnSync(bin, ["--version"], { stdio: "ignore" });
    if (result.error) {
      const err = result.error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        return { present: false, detail: `${bin} not found on PATH` };
      }
      return { present: false, detail: err.message };
    }
    return { present: true };
  } catch (cause) {
    return {
      present: false,
      detail: cause instanceof Error ? cause.message : String(cause),
    };
  }
};

const defaultSpawnImpl: SpawnImpl = (command, args, options) =>
  nodeSpawn(command, [...args], options);

/** Build the exact argv `cloudflared` receives. Exposed so tests can assert. */
export function buildTunnelArgs(host: string, port: number): readonly string[] {
  return ["tunnel", "--url", `http://${host}:${port}`];
}

/**
 * Error thrown when cloudflared is not on PATH. Caller maps this onto a
 * user-visible message and a non-zero exit code.
 */
export class TunnelBootError extends Error {
  public readonly code = "tunnel_boot_failed" as const;
  constructor(message: string) {
    super(message);
    this.name = "TunnelBootError";
  }
}

/**
 * Launch a cloudflared tunnel pointed at `http://host:port`. Returns a
 * handle the caller can await or stop. SIGTERM cleanup is installed by
 * default when `installSigtermHandler` is true.
 */
export function startTunnel(opts: TunnelOptions): TunnelHandle {
  const bin = opts.bin ?? "cloudflared";
  const check = opts.checkBinary ?? defaultCheckBinary;
  const presence = check(bin);
  if (!presence.present) {
    throw new TunnelBootError(
      `cloudflared is not available (${presence.detail}). Install cloudflared and try again; see https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/`,
    );
  }

  const spawnImpl = opts.spawnImpl ?? defaultSpawnImpl;
  const stdoutSink = opts.stdout ?? process.stdout;
  const stderrSink = opts.stderr ?? process.stderr;
  const stopGraceMs = opts.stopGraceMs ?? 3000;
  const installSigterm = opts.installSigtermHandler ?? true;

  const argv = buildTunnelArgs(opts.host, opts.port);
  const child = spawnImpl(bin, argv, { stdio: ["ignore", "pipe", "pipe"] });

  if (child.stdout) {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutSink.write(chunk);
    });
  }
  if (child.stderr) {
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderrSink.write(chunk);
    });
  }

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("exit", (code, signal) => {
      resolve({ code, signal });
    });
  });

  const stop = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      child.kill("SIGTERM");
    } catch {
      // Already gone.
    }
    const exitedWithinGrace = await Promise.race([
      exited.then(() => true),
      new Promise<boolean>((resolve) => {
        setTimeout(() => resolve(false), stopGraceMs);
      }),
    ]);
    if (!exitedWithinGrace) {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
      await exited;
    }
  };

  let sigtermListener: (() => void) | null = null;
  if (installSigterm) {
    sigtermListener = () => {
      void stop();
    };
    process.once("SIGTERM", sigtermListener);
    // Also detach the listener once the child exits so repeated start/stop
    // doesn't leak handlers across lifetimes.
    void exited.then(() => {
      if (sigtermListener) {
        process.removeListener("SIGTERM", sigtermListener);
        sigtermListener = null;
      }
    });
  }

  return {
    pid: child.pid ?? null,
    argv,
    exited,
    stop,
  };
}

/**
 * Render the user-facing scope message. CLI surfaces this via
 * `process.stdout` before the cloudflared URL lands.
 */
export function scopeMessage(path: string): string {
  return [
    `cloudflared will forward to every path on the local listener.`,
    `Only ${path} is exposed by the server; all other paths return 404.`,
    `Do not re-use this tunnel for a wider-scoped service.`,
  ].join("\n");
}
