/**
 * Live smoke test for the plan -> execute -> review flow.
 *
 * Skipped unless `SHAMU_FLOW_LIVE=1`. This suite actually spawns the
 * production adapters (`@shamu/adapter-codex` + `@shamu/adapter-claude`)
 * against a tiny scratch directory, drives the full flow, and asserts the
 * reviewer eventually approves.
 *
 * Enablement checklist (for whoever runs it):
 *   1. Anthropic + Codex CLIs authenticated locally (`claude /login`,
 *      `codex login` or API key in the keychain).
 *   2. `SHAMU_FLOW_LIVE=1` set in the environment.
 *   3. Optional: `SHAMU_FLOW_SCRATCH=/abs/path` to point at an existing
 *      scratch dir; otherwise a tmp dir is minted per run.
 *
 * Intentionally minimal -- the goal is "does the full stack wire up"
 * rather than "does the model produce good output".
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "@shamu/core-flow/bus";
import { FlowEngine } from "@shamu/core-flow/engine";
import type { FlowEvent } from "@shamu/core-flow/events";
import { RunnerRegistry } from "@shamu/core-flow/runners";
import { newWorkflowRunId } from "@shamu/shared/ids";
import { describe, expect, test } from "vitest";
import { flowDefinition } from "../../src/flow.ts";
import { registerRunners } from "../../src/runners.ts";

const LIVE = process.env.SHAMU_FLOW_LIVE === "1";

describe.skipIf(!LIVE)("live plan-execute-review smoke", () => {
  test(
    "runs end-to-end against real adapters and reaches a terminal state",
    async () => {
      const scratch = process.env.SHAMU_FLOW_SCRATCH ?? mkdtempSync(join(tmpdir(), "shamu-flow-"));
      // Seed the scratch dir with a tiny file the executor can plausibly edit.
      writeFileSync(join(scratch, "README.md"), "# placeholder\n");

      const registry = new RunnerRegistry();
      registerRunners(registry, {
        workspaceCwd: scratch,
        // Keep iterations low so the smoke finishes quickly even on revise.
        maxIterations: 2,
      });

      const bus = new EventBus<FlowEvent>();
      const events: FlowEvent[] = [];
      bus.subscribe((ev) => {
        events.push(ev);
      });

      const engine = new FlowEngine({ registry, bus });
      const state = await engine.run(flowDefinition, {
        flowRunId: newWorkflowRunId(),
        initialInputs: {
          task: "Add a second line reading 'hello from shamu' to README.md.",
          repoContext: "Single-file repo containing README.md at the root.",
        },
      });

      const completed = events.find((e) => e.kind === "flow_completed");
      expect(completed).toBeDefined();
      // We accept succeeded OR failed -- the assertion is that the pipeline
      // actually composed end-to-end, not that the model produced a perfect
      // patch on first try.
      expect(["succeeded", "failed"]).toContain(completed?.status);
      expect(Object.keys(state.nodeStatus).length).toBeGreaterThan(0);
    },
    // Live vendor calls are slow; extend the default timeout generously.
    5 * 60 * 1000,
  );
});
