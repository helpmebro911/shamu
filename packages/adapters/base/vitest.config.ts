import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    reporters: process.env.CI ? ["default", "junit"] : ["default"],
    outputFile: {
      junit: "./coverage/junit.xml",
    },
    // The contract-suite source module (`src/contract/**`) is production code
    // consumed by downstream adapter test suites. We still exercise it here
    // via `test/contract-suite.test.ts`, which runs the suite against a
    // `FakeAdapter` fixture so the coverage counts the scenarios.
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov", "json-summary"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/*.spec.ts", "**/node_modules/**", "**/dist/**"],
    },
  },
});
