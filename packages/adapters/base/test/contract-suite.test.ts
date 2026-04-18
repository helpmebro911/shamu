/**
 * Integration test: run the shared contract suite against `FakeAdapter`.
 *
 * Proves two things at once:
 * 1. The contract suite actually asserts behavior (a broken fake would fail).
 * 2. The fake's event stream shape is a useful reference for the echo
 *    adapter (Phase 1.E) and later vendor adapters.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll } from "vitest";
import type { AgentHandle } from "../src/adapter.ts";
import { runAdapterContractSuite } from "../src/contract/index.ts";
import type { AdapterUnderTest } from "../src/contract/types.ts";
import { FAKE_CAPABILITIES, FakeAdapter } from "./fake-adapter.ts";

let rootDir: string;

beforeAll(() => {
  rootDir = mkdtempSync(join(tmpdir(), "shamu-contract-"));
});

afterAll(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

const adapter = new FakeAdapter();
const aut: AdapterUnderTest = {
  adapter,
  vendor: adapter.vendor,
  capabilities: FAKE_CAPABILITIES,
  factory: async (ctx) => adapter.spawn(ctx.spawnOpts),
  teardown: async (handle: AgentHandle) => {
    try {
      await handle.shutdown("contract-teardown");
    } catch {
      // Shutdown is idempotent in the fake; swallow.
    }
  },
  worktreeFor: async (scenarioName) => {
    const dir = join(rootDir, scenarioName.replace(/[^a-z0-9_-]/gi, "_"));
    mkdirSync(dir, { recursive: true });
    return dir;
  },
};

runAdapterContractSuite(aut, { timeoutMs: 5_000 });
