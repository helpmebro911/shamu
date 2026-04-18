/**
 * Capability declarations.
 *
 * Per PLAN.md § 1 (G8): capabilities are declared at adapter build time and
 * are immutable at runtime. Adapters CANNOT self-upgrade. The loader reads a
 * JSON manifest from disk, Zod-validates it, and freezes the result.
 */

import { readFileSync } from "node:fs";
import { z } from "zod";
import { ConfigError } from "./errors.ts";

const permissionModeSchema = z.enum(["default", "acceptEdits", "plan", "bypassPermissions"]);

export const capabilitiesSchema = z.object({
  resume: z.boolean(),
  fork: z.boolean(),
  interrupt: z.enum(["cooperative", "hard", "none"]),
  permissionModes: z.array(permissionModeSchema).min(1),
  mcp: z.enum(["in-process", "stdio", "http", "none"]),
  customTools: z.boolean(),
  patchVisibility: z.enum(["events", "filesystem-only"]),
  usageReporting: z.enum(["per-turn", "per-call", "none"]),
  costReporting: z.enum(["native", "computed", "subscription", "unknown"]),
  sandboxing: z.enum(["process", "container", "remote", "none"]),
  streaming: z.enum(["events", "final-only"]),
});

export type Capabilities = z.infer<typeof capabilitiesSchema>;
export type PermissionMode = z.infer<typeof permissionModeSchema>;

/**
 * Parse+freeze an already-materialized object. Throws ConfigError on any
 * schema violation so callers get a typed error back.
 */
export function freezeCapabilities(raw: unknown): Readonly<Capabilities> {
  const parsed = capabilitiesSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(
      `Invalid capability manifest: ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
      parsed.error,
    );
  }
  return Object.freeze({ ...parsed.data });
}

/**
 * Load + validate a capability manifest from disk.
 *
 * Synchronous on purpose — capability manifests are small, read once at
 * adapter startup, and the whole rest of the subsystem (dispatch, tests,
 * contract suite) assumes `capabilities` is a settled value.
 */
export function loadCapabilities(manifestPath: string): Readonly<Capabilities> {
  let text: string;
  try {
    text = readFileSync(manifestPath, "utf8");
  } catch (cause) {
    throw new ConfigError(`Could not read capability manifest at ${manifestPath}`, cause);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (cause) {
    throw new ConfigError(`Capability manifest at ${manifestPath} is not valid JSON`, cause);
  }
  return freezeCapabilities(json);
}
