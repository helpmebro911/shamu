#!/usr/bin/env bun
/**
 * Shamu CLI entry.
 *
 * Delegates to `citty`'s `runCommand` (not `runMain` — that calls process.exit
 * internally and swallows sub-command return values). Command handlers return
 * and also record an ExitCode via `setExitCode`; this file maps the result to
 * a single `process.exit` call. Unhandled errors map to INTERNAL.
 */

import { renderUsage, runCommand } from "citty";
import { ExitCode, type ExitCodeValue } from "./exit-codes.ts";
import { writeDiag } from "./output.ts";
import { root } from "./root.ts";
import { getExitCode, resetExitCode, setExitCode } from "./runner.ts";

async function main(rawArgs: string[]): Promise<ExitCodeValue> {
  resetExitCode();

  // Manual --help / --version handling so citty doesn't process.exit on us
  // and so we control the output stream directly (consola async-flush has bit
  // us in subprocess tests where the process exits before the buffer drains).
  if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
    const [cmd, parent] = await resolveLeaf(rawArgs);
    const usage = await renderUsage(cmd, parent);
    await writeAndFlush(process.stdout, `${usage}\n`);
    return ExitCode.OK;
  }
  if (rawArgs.length === 1 && rawArgs[0] === "--version") {
    const meta = await resolveMeta(root);
    await writeAndFlush(process.stdout, `${meta.version ?? "0.0.0"}\n`);
    return ExitCode.OK;
  }

  try {
    const out = await runCommand(root, { rawArgs });
    // Handler may either return a numeric code directly (short path, mainly
    // for tests) or set it via setExitCode and return undefined (the norm).
    if (typeof out.result === "number") return out.result as ExitCodeValue;
    return getExitCode();
  } catch (err) {
    const isUsage = looksLikeUsageError(err);
    const message = err instanceof Error ? err.message : String(err);
    if (isUsage) {
      writeDiag(`error: ${message}`);
      try {
        const [cmd, parent] = await resolveLeaf(rawArgs);
        const usage = await renderUsage(cmd, parent);
        await writeAndFlush(process.stderr, `${usage}\n`);
      } catch {
        // Usage renderer is best-effort; don't mask the original error.
      }
      return ExitCode.USAGE;
    }
    writeDiag(`internal error: ${message}`);
    if (err instanceof Error && err.stack) writeDiag(err.stack);
    return ExitCode.INTERNAL;
  }
}

/**
 * Write a chunk and wait for the drain signal before resolving. Needed so the
 * top-level `process.exit` doesn't truncate piped output under load.
 */
function writeAndFlush(stream: NodeJS.WriteStream, chunk: string): Promise<void> {
  return new Promise((resolve) => {
    if (stream.write(chunk)) {
      resolve();
      return;
    }
    stream.once("drain", () => resolve());
  });
}

function looksLikeUsageError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && code.startsWith("E_")) return true;
  const msg = err.message.toLowerCase();
  return (
    msg.includes("unknown command") ||
    msg.includes("no command specified") ||
    msg.includes("missing required") ||
    msg.includes("required option")
  );
}

type CmdLike = Parameters<typeof runCommand>[0];

async function resolveLeaf(rawArgs: string[]): Promise<[CmdLike, CmdLike?]> {
  // Walk the subcommand tree to find the deepest command matching rawArgs so
  // `--help` can render the right usage block.
  let cmd: CmdLike = root;
  let parent: CmdLike | undefined;
  let args = rawArgs;
  while (true) {
    const subs = await resolveMaybe(cmd.subCommands);
    if (!subs) break;
    const idx = args.findIndex((a) => !a.startsWith("-"));
    if (idx < 0) break;
    const name = args[idx];
    if (!name) break;
    const sub = subs[name];
    if (!sub) break;
    const resolvedSub = await resolveMaybe(sub);
    if (!resolvedSub) break;
    parent = cmd;
    cmd = resolvedSub;
    args = args.slice(idx + 1);
  }
  return parent ? [cmd, parent] : [cmd];
}

async function resolveMeta(cmd: CmdLike): Promise<{ version?: string }> {
  const meta = await resolveMaybe(cmd.meta);
  return meta ?? {};
}

async function resolveMaybe<T>(
  value: T | Promise<T> | (() => T | Promise<T>) | undefined,
): Promise<T | undefined> {
  if (value === undefined) return undefined;
  if (typeof value === "function") {
    return await (value as () => T | Promise<T>)();
  }
  return await value;
}

void main(process.argv.slice(2)).then(
  (code) => {
    // Single exit path; after this, no more command work runs.
    setExitCode(code);
    process.exit(code);
  },
  (err) => {
    // Last-resort guard — main() catches its own errors; this only fires on a
    // bug above the try/catch (e.g., a synchronous throw in resolveLeaf).
    const message = err instanceof Error ? err.message : String(err);
    writeDiag(`fatal: ${message}`);
    process.exit(ExitCode.INTERNAL);
  },
);
