/**
 * Adapter registry for the CLI.
 *
 * Maps a user-facing adapter name (e.g. `"echo"`) to an async factory that
 * dynamically imports the concrete adapter module and returns an instance.
 * Dynamic import keeps vendor SDK cost off the startup path for callers
 * that only ever use, say, the echo adapter.
 *
 * Later phases add `claude`, `codex`, etc.; add them to `ADAPTER_LOADERS`.
 * The registry intentionally does not load capability manifests here —
 * every adapter loads its own at construction.
 */

import type { AgentAdapter } from "@shamu/adapters-base";

export type AdapterName = "echo" | "claude" | "codex";

type AdapterLoader = () => Promise<AgentAdapter>;

const ADAPTER_LOADERS: Readonly<Record<AdapterName, AdapterLoader>> = {
  echo: async () => {
    const mod = await import("@shamu/adapter-echo");
    return new mod.EchoAdapter();
  },
  claude: async () => {
    // Dynamic import keeps the Anthropic SDK off the startup path for users
    // running `shamu run --adapter echo`.
    const mod = await import("@shamu/adapter-claude");
    return new mod.ClaudeAdapter();
  },
  codex: async () => {
    const mod = await import("@shamu/adapter-codex");
    return new mod.CodexAdapter();
  },
};

/** True iff `name` is a recognized adapter. Cheap, does no I/O. */
export function isKnownAdapter(name: string): name is AdapterName {
  return Object.hasOwn(ADAPTER_LOADERS, name);
}

/** List of registered adapter names — handy for usage strings. */
export function knownAdapterNames(): readonly string[] {
  return Object.keys(ADAPTER_LOADERS);
}

/** Resolve and instantiate a named adapter. */
export async function loadAdapter(name: AdapterName): Promise<AgentAdapter> {
  const loader = ADAPTER_LOADERS[name];
  return loader();
}
