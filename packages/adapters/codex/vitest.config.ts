import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    reporters: process.env.CI ? ["default", "junit"] : ["default"],
    outputFile: {
      junit: "./coverage/junit.xml",
    },
    // Live-mode vendor tests live under `test/live/*.test.ts.skip` and are
    // not collected by default; Vitest's picomatch includes do not match
    // files ending in `.skip`. Setting SHAMU_CODEX_LIVE=1 lets an operator
    // opt-in by renaming or calling vitest with a custom include glob.
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov", "json-summary"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/*.spec.ts", "**/node_modules/**", "**/dist/**"],
    },
  },
});
