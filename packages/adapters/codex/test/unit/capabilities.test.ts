/**
 * Capability manifest unit test.
 *
 * The manifest is frozen at module load; any mutation attempt must throw
 * under strict mode. The shape is asserted field-by-field so a
 * capability regression (e.g., accidentally flipping `resume: false`)
 * trips this test loudly.
 */

import { describe, expect, it } from "vitest";
import { CODEX_CAPABILITIES } from "../../src/index.ts";

describe("CodexAdapter: capability manifest", () => {
  it("is frozen and declares the Codex-shaped capabilities", () => {
    expect(CODEX_CAPABILITIES.resume).toBe(true);
    expect(CODEX_CAPABILITIES.fork).toBe(false);
    expect(CODEX_CAPABILITIES.interrupt).toBe("cooperative");
    expect(CODEX_CAPABILITIES.permissionModes).toEqual(["default", "acceptEdits"]);
    expect(CODEX_CAPABILITIES.mcp).toBe("stdio");
    expect(CODEX_CAPABILITIES.customTools).toBe(false);
    expect(CODEX_CAPABILITIES.patchVisibility).toBe("events");
    expect(CODEX_CAPABILITIES.usageReporting).toBe("per-turn");
    expect(CODEX_CAPABILITIES.costReporting).toBe("subscription");
    expect(CODEX_CAPABILITIES.sandboxing).toBe("process");
    expect(CODEX_CAPABILITIES.streaming).toBe("events");
    expect(Object.isFrozen(CODEX_CAPABILITIES)).toBe(true);
  });
});
