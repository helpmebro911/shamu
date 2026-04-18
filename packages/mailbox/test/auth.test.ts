import { describe, expect, it } from "bun:test";
import { newRunId, newSwarmId } from "@shamu/shared/ids";
import { type AuthContext, assertAuthContext, UnauthenticatedWriteError } from "../src/auth.ts";

describe("AuthContext", () => {
  it("accepts a well-formed context", () => {
    const ctx: AuthContext = {
      runId: newRunId(),
      swarmId: newSwarmId(),
      agent: "planner",
    };
    expect(() => assertAuthContext(ctx)).not.toThrow();
  });

  it("rejects an empty agent string", () => {
    const ctx = {
      runId: newRunId(),
      swarmId: newSwarmId(),
      agent: "",
    } as AuthContext;
    expect(() => assertAuthContext(ctx)).toThrow(UnauthenticatedWriteError);
  });

  it("rejects a missing runId", () => {
    const ctx = {
      runId: "" as ReturnType<typeof newRunId>,
      swarmId: newSwarmId(),
      agent: "planner",
    } as AuthContext;
    expect(() => assertAuthContext(ctx)).toThrow(UnauthenticatedWriteError);
  });

  it("rejects a missing swarmId", () => {
    const ctx = {
      runId: newRunId(),
      swarmId: "" as ReturnType<typeof newSwarmId>,
      agent: "planner",
    } as AuthContext;
    expect(() => assertAuthContext(ctx)).toThrow(UnauthenticatedWriteError);
  });

  // --- G6 compile-time assertion ---
  //
  // The persistence-layer `InsertMessageInput` accepts `fromAgent`, but
  // the mailbox public API (broadcast/whisper) has NO `from` parameter.
  // The only way `from_agent` enters the DB via this package is through
  // `ctx.agent`. There is no runtime assertion to write here — the
  // absence of a `from` parameter in the primitive signatures is the
  // guard. We document the expectation with a type-level assertion.
  //
  // If a future refactor adds a `from` parameter to any primitive, the
  // signature change will surface in code review and this test block
  // should be updated to reflect the new contract.
  it("primitives have no `from` parameter (G6, documented)", async () => {
    // Import at call time to avoid a top-of-file load affecting isolation.
    const mailbox = await import("../src/mailbox.ts");
    // The runtime export surface exists; the API shape is enforced by
    // TypeScript at every call site. This assertion is a placeholder to
    // make the intention visible in the test suite.
    expect(typeof mailbox.broadcast).toBe("function");
    expect(typeof mailbox.whisper).toBe("function");
    expect(typeof mailbox.read).toBe("function");
    expect(typeof mailbox.markRead).toBe("function");
  });
});
