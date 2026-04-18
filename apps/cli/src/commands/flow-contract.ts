/**
 * Consumer-side flow-module contract for `shamu flow run`.
 *
 * Every flow module (e.g. `@shamu/flows-plan-execute-review`) conforms to
 * a narrow, runtime-validated surface:
 *
 *   - `flowDefinition`: a FlowDefinition object.
 *   - `registerRunners(registry, opts)`: wires the module's runners into
 *     the RunnerRegistry the engine will use.
 *   - Optional `name: string`.
 *   - Optional `parseOptions(record): Partial<RegisterRunnersOptions>`.
 *
 * This module is internal to the CLI — intentionally not exposed from
 * `apps/cli/package.json`'s exports. We duplicate the contract types here
 * rather than importing from `@shamu/flows-plan-execute-review` because
 * Track 4.B may be running concurrently; taking a hard dep on 4.B would
 * couple ship order. Any flow module, built in-tree or out, works as long
 * as it matches this shape.
 *
 * The validation uses Zod. Runners themselves are *functions*, which Zod
 * can't introspect meaningfully — we only verify their presence and that
 * they're callable. The flow definition, in contrast, is plain data, so
 * we hand it to `@shamu/core-flow`'s typing after shape-check without
 * further parsing (the engine's topological walk will catch any
 * structural problems at run-time).
 */

import { pathToFileURL } from "node:url";
import type { RunnerRegistry } from "@shamu/core-flow/runners";
import type { FlowDefinition } from "@shamu/core-flow/types";
import { z } from "zod";

/**
 * Options the CLI passes into `registerRunners(...)`. Matches the
 * contract PLANned in Track 4.C. Optional fields let a flow module
 * ignore knobs it doesn't care about — `workspaceCwd` is the only one
 * guaranteed to be populated.
 */
export interface RegisterRunnersOptions {
  readonly anthropicCliPath?: string;
  readonly codexCliPath?: string;
  readonly workspaceCwd: string;
  readonly maxIterations?: number;
  readonly plannerModel?: string;
  readonly executorModel?: string;
  readonly reviewerModel?: string;
}

/**
 * Public surface a flow module is required to export. `name` and
 * `parseOptions` are optional; everything else is mandatory.
 */
export interface FlowModule {
  readonly flowDefinition: FlowDefinition;
  readonly registerRunners: (registry: RunnerRegistry, opts: RegisterRunnersOptions) => void;
  readonly name?: string;
  readonly parseOptions?: (cliOpts: Record<string, string>) => Partial<RegisterRunnersOptions>;
}

/**
 * Runtime shape check. Zod is permissive on `flowDefinition.nodes` — we
 * only need the outer keys; the engine owns deeper validation. We treat
 * `registerRunners` as an opaque callable via `z.custom` because Zod does
 * not model function signatures.
 */
const flowDefinitionShape = z.object({
  id: z.string().min(1),
  version: z.number().int().nonnegative(),
  nodes: z.array(z.unknown()),
  entry: z.string().min(1),
});

const callable = z.custom<(...args: readonly unknown[]) => unknown>(
  (v) => typeof v === "function",
  { message: "expected a function" },
);

export const flowModuleSchema = z.object({
  flowDefinition: flowDefinitionShape,
  registerRunners: callable,
  name: z.string().min(1).optional(),
  parseOptions: callable.optional(),
});

/**
 * Raise if a dynamic-imported module doesn't match our contract.
 * `specSource` is the raw spec the user passed (a package name or path)
 * so the error string is actionable. We don't print the full Zod issue
 * tree — just the top-level missing/invalid keys, which is what the CLI
 * user actually needs.
 */
export class FlowModuleContractError extends Error {
  constructor(
    public readonly specSource: string,
    public readonly reason: string,
  ) {
    super(`flow module '${specSource}' does not match the shamu flow contract: ${reason}`);
    this.name = "FlowModuleContractError";
  }
}

/**
 * Resolve a module spec to a value `await import(...)` understands.
 *
 * Supported:
 *   - Bare package name (e.g. `@shamu/flows-plan-execute-review`): let
 *     Node module resolution handle it. We pass the string through as-is.
 *   - Absolute or relative path ending in `.ts`/`.js`: convert to a
 *     `file://` URL so Bun/Node resolves from disk without going through
 *     the require resolver. Relative paths resolve against `baseDir`
 *     (defaults to process.cwd()).
 */
export function resolveModuleSpec(spec: string, baseDir: string = process.cwd()): string {
  if (spec.length === 0) {
    throw new TypeError("resolveModuleSpec: spec must be a non-empty string");
  }
  const looksLikePath =
    spec.startsWith(".") ||
    spec.startsWith("/") ||
    spec.endsWith(".ts") ||
    spec.endsWith(".js") ||
    spec.endsWith(".mjs");
  if (!looksLikePath) return spec;
  // Resolve relative paths against baseDir; absolute paths untouched.
  const abs = spec.startsWith("/") ? spec : joinPath(baseDir, spec);
  return pathToFileURL(abs).href;
}

// Tiny local path joiner. Keeping it dependency-free so the module can be
// imported by test fixtures that don't want a node:path transitive dep
// (and Bun/Node path semantics are fine either way on macOS + Linux).
function joinPath(base: string, rel: string): string {
  if (rel.startsWith("/")) return rel;
  const trimmedBase = base.endsWith("/") ? base.slice(0, -1) : base;
  return `${trimmedBase}/${rel.startsWith("./") ? rel.slice(2) : rel}`;
}

/**
 * Dynamic-import `spec`, validate the module's surface, and return the
 * typed handle. Throws `FlowModuleContractError` on any mismatch; any
 * other failure (import resolution, syntax error in the module itself)
 * propagates through unchanged so the caller sees the underlying cause.
 */
export async function loadFlowModule(
  spec: string,
  opts: { readonly baseDir?: string } = {},
): Promise<FlowModule> {
  const target = resolveModuleSpec(spec, opts.baseDir ?? process.cwd());
  const imported = (await import(target)) as Record<string, unknown>;
  const parsed = flowModuleSchema.safeParse(imported);
  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];
    const path = firstIssue?.path.join(".") ?? "<root>";
    const message = firstIssue?.message ?? "shape mismatch";
    throw new FlowModuleContractError(spec, `${path}: ${message}`);
  }
  // Zod's parsed output types the callables as `(...unknown[]) => unknown`;
  // we re-narrow here so the engine gets the real signatures.
  const m = parsed.data;
  const out: FlowModule = {
    flowDefinition: imported.flowDefinition as FlowDefinition,
    registerRunners: imported.registerRunners as FlowModule["registerRunners"],
    ...(m.name !== undefined ? { name: m.name } : {}),
    ...(m.parseOptions !== undefined
      ? { parseOptions: imported.parseOptions as NonNullable<FlowModule["parseOptions"]> }
      : {}),
  };
  return out;
}
