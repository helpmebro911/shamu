/**
 * Toolchain canary. Delete or repurpose once real packages land in Track 1.B.
 * Pure, total, no side effects — exists solely to prove Biome, tsc, and Vitest
 * all agree on a file under the monorepo workspace.
 */
export function greet(name: string): string {
  return `Hello, ${name}.`;
}
