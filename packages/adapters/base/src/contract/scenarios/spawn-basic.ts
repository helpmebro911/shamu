/**
 * Scenario: spawn + receive session_start + at least one assistant_* + turn_end.
 *
 * The contract-suite entry row "spawn → working handle" / "events async
 * iterable yields session_start, ≥1 assistant_*, turn_end in order."
 *
 * Every adapter MUST satisfy this — there's no capability that disables it.
 * Scenario deliberately uses `requires: []`.
 */

import type { AgentHandle } from "../../adapter.ts";
import type { AgentEvent, AgentEventKind } from "../../events.ts";
import { checkOrderingInvariants } from "../../events.ts";
import type { Scenario, ScenarioContext } from "../types.ts";

export const spawnBasicScenario: Scenario = {
  id: "spawn-basic",
  description:
    "spawn yields a handle; stream includes session_start, at least one assistant_*, and a turn_end in order",
  requires: [],
  async run(ctx: ScenarioContext, handle: AgentHandle): Promise<void> {
    await handle.send(ctx.helloTurn);
    const collected = await collectUntilTurnEnd(handle, ctx.timeoutMs);

    assertOrdered(collected, "session_start", "turn_end");
    const hasAssistant = collected.some(
      (ev) => ev.kind === "assistant_delta" || ev.kind === "assistant_message",
    );
    if (!hasAssistant) {
      throw new Error(
        `spawn-basic: expected at least one assistant_delta or assistant_message; got ${collected
          .map((e) => e.kind)
          .join(", ")}`,
      );
    }

    const violations = checkOrderingInvariants(collected);
    if (violations.length > 0) {
      throw new Error(
        `spawn-basic: ordering violations: ${violations.map((v) => v.message).join("; ")}`,
      );
    }
  },
};

/**
 * Drain events from the handle until a `turn_end` is observed or the
 * timeout elapses. Returns the collected prefix; rethrows on timeout.
 */
export async function collectUntilTurnEnd(
  handle: AgentHandle,
  timeoutMs: number,
): Promise<AgentEvent[]> {
  const collected: AgentEvent[] = [];
  await withTimeout(
    (async () => {
      for await (const ev of handle.events) {
        collected.push(ev);
        if (ev.kind === "turn_end") return;
      }
    })(),
    timeoutMs,
    "waiting for turn_end",
  );
  return collected;
}

/**
 * Reject the underlying promise if it doesn't resolve inside `ms`.
 *
 * `Promise.race` with a setTimeout is the stock pattern; we keep the
 * original error intact when the inner promise rejects first.
 */
export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms ${label}`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function assertOrdered(events: readonly AgentEvent[], ...required: AgentEventKind[]): void {
  let cursor = 0;
  for (const ev of events) {
    if (ev.kind === required[cursor]) cursor += 1;
    if (cursor === required.length) return;
  }
  throw new Error(
    `assertOrdered: expected ${required.join(" → ")} but stream was ${events
      .map((e) => e.kind)
      .join(", ")}`,
  );
}
