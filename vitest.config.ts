import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    passWithNoTests: true,
    reporters: process.env.CI ? ["default", "junit"] : ["default"],
    outputFile: {
      junit: "./coverage/junit.xml",
    },
    // Each package with Vitest tests lives in its own workspace and invokes
    // `vitest run` from its own cwd, so this root config is only applied to
    // tests not owned by a package (none today). Per-package configs
    // override. `packages/persistence` deliberately opts out because it
    // depends on `bun:sqlite`, which isn't loadable in Vitest 4's Node
    // child pool; those tests use Bun's native test runner (`bun test`).
    exclude: ["**/node_modules/**", "**/dist/**", "docs/**", "packages/persistence/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov", "json-summary"],
      reportsDirectory: "./coverage",
      include: [
        "packages/core/src/**/*.ts",
        "packages/adapters/base/src/**/*.ts",
        "packages/watchdog/src/**/*.ts",
        "packages/mailbox/src/**/*.ts",
      ],
      exclude: ["**/*.test.ts", "**/*.spec.ts", "**/node_modules/**", "**/dist/**"],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
});
