/**
 * Structured JSON logger.
 *
 * Writes to stderr by default (stdout stays clean for `--json` CLI piping).
 * Context accumulates via `.child({ key: value })`. No `console.log`.
 *
 * Levels follow the canonical pinojs ordering; the numeric value is stable so
 * callers can compare (`entry.levelValue >= 40`).
 */

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

export interface LogEntry {
  readonly ts: number;
  readonly level: LogLevel;
  readonly levelValue: number;
  readonly msg: string;
  readonly context: Readonly<Record<string, unknown>>;
}

export type LogTransport = (entry: LogEntry) => void;

const LEVEL_VALUES: Readonly<Record<LogLevel, number>> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
};

export interface LoggerOptions {
  readonly level?: LogLevel;
  readonly context?: Readonly<Record<string, unknown>>;
  readonly transport?: LogTransport;
  /** Override `Date.now` for deterministic testing. */
  readonly now?: () => number;
}

export function stderrTransport(entry: LogEntry): void {
  const line = JSON.stringify(entry);
  // `console.error` is the project-wide exception — see biome.json; it writes
  // to stderr, which is the default transport sink.
  console.error(line);
}

export class Logger {
  private readonly levelValue: number;
  private readonly context: Readonly<Record<string, unknown>>;
  private readonly transport: LogTransport;
  private readonly now: () => number;
  public readonly level: LogLevel;

  constructor(opts: LoggerOptions = {}) {
    this.level = opts.level ?? "info";
    this.levelValue = LEVEL_VALUES[this.level];
    this.context = opts.context ?? {};
    this.transport = opts.transport ?? stderrTransport;
    this.now = opts.now ?? Date.now;
  }

  child(extra: Readonly<Record<string, unknown>>): Logger {
    return new Logger({
      level: this.level,
      context: { ...this.context, ...extra },
      transport: this.transport,
      now: this.now,
    });
  }

  private log(level: LogLevel, msg: string, extra?: Readonly<Record<string, unknown>>): void {
    const lv = LEVEL_VALUES[level];
    if (lv < this.levelValue) return;
    const context: Record<string, unknown> = { ...this.context };
    if (extra) Object.assign(context, extra);
    const entry: LogEntry = {
      ts: this.now(),
      level,
      levelValue: lv,
      msg,
      context,
    };
    this.transport(entry);
  }

  trace(msg: string, extra?: Readonly<Record<string, unknown>>): void {
    this.log("trace", msg, extra);
  }
  debug(msg: string, extra?: Readonly<Record<string, unknown>>): void {
    this.log("debug", msg, extra);
  }
  info(msg: string, extra?: Readonly<Record<string, unknown>>): void {
    this.log("info", msg, extra);
  }
  warn(msg: string, extra?: Readonly<Record<string, unknown>>): void {
    this.log("warn", msg, extra);
  }
  error(msg: string, extra?: Readonly<Record<string, unknown>>): void {
    this.log("error", msg, extra);
  }
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  return new Logger(opts);
}
