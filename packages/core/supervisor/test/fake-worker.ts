/**
 * `FakeWorker` — in-memory `WorkerHandle` fixture for supervisor tests.
 *
 * Supports:
 *   - Crash-on-start via `failOnStart`.
 *   - Deferred crashes via `crash(reason, error?)`.
 *   - Clean exits via `exitNormal()`.
 *   - External kill via `kill(reason)`.
 *
 * The fixture tracks every lifecycle call so tests can assert sequence.
 * Listeners subscribed via `onExit` receive exactly one notification per
 * lifecycle (the first crash/kill/normal-exit wins); subsequent signals
 * are silently dropped to match the `WorkerHandle` contract.
 */

import type { ExitInfo, ExitReason, WorkerHandle } from "../src/types.ts";

export interface FakeWorkerOptions {
  readonly id: string;
  /** Reject `start()` with this error instead of resolving. */
  readonly failOnStart?: Error;
  /** Throw from `stop()` instead of resolving. */
  readonly failOnStop?: Error;
}

export class FakeWorker implements WorkerHandle {
  public readonly id: string;
  public startCalls = 0;
  public stopCalls = 0;
  public stopReason: string | null = null;
  private readonly listeners = new Set<(info: ExitInfo) => void>();
  private exited = false;
  private readonly failOnStart: Error | undefined;
  private readonly failOnStop: Error | undefined;

  constructor(opts: FakeWorkerOptions) {
    this.id = opts.id;
    this.failOnStart = opts.failOnStart;
    this.failOnStop = opts.failOnStop;
  }

  async start(): Promise<void> {
    this.startCalls += 1;
    if (this.failOnStart) throw this.failOnStart;
  }

  async stop(reason: string): Promise<void> {
    this.stopCalls += 1;
    this.stopReason = reason;
    if (this.failOnStop) throw this.failOnStop;
  }

  onExit(listener: (info: ExitInfo) => void): () => void {
    if (this.exited) return () => {};
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Fire a synthetic exit. Exactly-once semantics. */
  signal(reason: ExitReason, error?: Error): void {
    if (this.exited) return;
    this.exited = true;
    const info: ExitInfo = error !== undefined ? { reason, error } : { reason };
    for (const listener of [...this.listeners]) {
      listener(info);
    }
    this.listeners.clear();
  }

  crash(error?: Error): void {
    this.signal("crashed", error);
  }

  kill(): void {
    this.signal("killed");
  }

  exitNormal(): void {
    this.signal("normal");
  }
}

/**
 * Build a factory + a ledger of every `FakeWorker` the factory produces.
 *
 * Each call to the returned factory pushes a new worker onto `workers` and
 * returns it. Use `configureNext(opts)` to customize the options for the
 * NEXT factory call — handy for scripting "first start succeeds, third
 * restart fails to boot".
 */
export function fakeFactory(baseId: string): {
  readonly factory: () => Promise<FakeWorker>;
  readonly workers: FakeWorker[];
  configureNext(opts: Omit<FakeWorkerOptions, "id">): void;
} {
  const workers: FakeWorker[] = [];
  let nextOpts: Omit<FakeWorkerOptions, "id"> | null = null;
  const factory = async (): Promise<FakeWorker> => {
    const opts: FakeWorkerOptions = { id: baseId, ...(nextOpts ?? {}) };
    nextOpts = null;
    const w = new FakeWorker(opts);
    workers.push(w);
    return w;
  };
  return {
    factory,
    workers,
    configureNext(opts) {
      nextOpts = opts;
    },
  };
}
