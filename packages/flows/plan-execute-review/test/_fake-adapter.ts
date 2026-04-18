/**
 * Minimal in-memory `AgentAdapter` fake for runner tests.
 *
 * Lives under `test/` so it is never bundled into the package surface. The
 * implementation is the smallest thing that satisfies the contract:
 *   - Emits a single assistant_message (supplied by the caller).
 *   - Emits zero or more cost events (supplied by the caller).
 *   - Emits a final turn_end.
 *   - Respects the AgentEvent schema so `runSingleTurn`'s iteration over
 *     kinds matches production shape.
 *
 * Deliberately does NOT go through `@shamu/adapters-base` validators because
 * the runner itself does not validate events before inspecting `.kind` --
 * the vendor adapters own that. The test's job is to make sure the runner
 * reacts to the RIGHT `kind` fields and produces the right NodeOutput.
 */

import type {
  AgentAdapter,
  AgentEvent,
  AgentHandle,
  HandleHeartbeat,
  PermissionMode,
  SpawnOpts,
  UserTurn,
} from "@shamu/adapters-base";
import { type Capabilities, freezeCapabilities } from "@shamu/adapters-base";
import type { RunId, SessionId } from "@shamu/shared/ids";
import { newEventId, newSessionId, newTurnId } from "@shamu/shared/ids";

export interface FakeCostSample {
  readonly usd: number | null;
  readonly confidence: "exact" | "estimate" | "unknown";
  readonly source: string;
}

export interface FakeAdapterScript {
  readonly finalAssistantText: string;
  readonly costSamples?: readonly FakeCostSample[];
}

export interface FakeAdapterOptions {
  readonly vendor: string;
  readonly capabilities: Readonly<Capabilities>;
  /**
   * Script source. May be a single script (every spawn uses it) or a
   * function that yields scripts in order (for tests that re-spawn).
   */
  readonly scriptFor: (spawnIndex: number) => FakeAdapterScript;
}

export interface FakeAdapterHandle extends AgentHandle {
  readonly spawnIndex: number;
  readonly lastSpawnOpts: SpawnOpts;
}

export class FakeAdapter implements AgentAdapter {
  public readonly vendor: string;
  public readonly capabilities: Readonly<Capabilities>;
  private readonly scriptFor: (index: number) => FakeAdapterScript;
  public spawnCount = 0;
  public readonly handles: FakeAdapterHandle[] = [];

  constructor(options: FakeAdapterOptions) {
    this.vendor = options.vendor;
    this.capabilities = options.capabilities;
    this.scriptFor = options.scriptFor;
  }

  spawn(opts: SpawnOpts): Promise<AgentHandle> {
    const index = this.spawnCount;
    this.spawnCount += 1;
    const script = this.scriptFor(index);
    const handle = makeHandle({ opts, script, vendor: this.vendor, spawnIndex: index });
    this.handles.push(handle);
    return Promise.resolve(handle);
  }

  resume(_sessionId: string, opts: SpawnOpts): Promise<AgentHandle> {
    return this.spawn(opts);
  }
}

function makeHandle(input: {
  readonly opts: SpawnOpts;
  readonly script: FakeAdapterScript;
  readonly vendor: string;
  readonly spawnIndex: number;
}): FakeAdapterHandle {
  const { opts, script, vendor, spawnIndex } = input;
  const runId: RunId = opts.runId;
  const sessionId: SessionId = newSessionId();
  const turnId = newTurnId();

  const events: AgentEvent[] = [];
  let seq = 0;
  const envelope = () => {
    const s = seq;
    seq += 1;
    return {
      eventId: newEventId(),
      runId,
      sessionId,
      turnId,
      parentEventId: null,
      seq: s,
      tsMonotonic: s,
      tsWall: 1_700_000_000_000 + s,
      vendor,
      rawRef: null,
    };
  };

  // session_start -> assistant_message -> cost*... -> turn_end.
  events.push({
    ...envelope(),
    kind: "session_start",
    source: "spawn",
  });
  events.push({
    ...envelope(),
    kind: "assistant_message",
    text: script.finalAssistantText,
    stopReason: "stop",
  });
  for (const sample of script.costSamples ?? []) {
    events.push({
      ...envelope(),
      kind: "cost",
      usd: sample.usd,
      confidence: sample.confidence,
      source: sample.source,
    });
  }
  events.push({
    ...envelope(),
    kind: "turn_end",
    stopReason: "stop",
    durationMs: 0,
  });

  let released = false;
  const queuedEvents = [...events];

  let capturedSend: UserTurn | null = null;
  let lastSeq = events.length;

  const asyncIterable: AsyncIterable<AgentEvent> = {
    [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
      return {
        async next(): Promise<IteratorResult<AgentEvent>> {
          // Events are only released after the first `send()` to mimic real
          // adapters that buffer until a user turn is driven.
          while (!released) {
            await Promise.resolve();
          }
          const next = queuedEvents.shift();
          if (next === undefined)
            return { value: undefined, done: true } as IteratorResult<AgentEvent>;
          return { value: next, done: false };
        },
      };
    },
  };

  const handle: FakeAdapterHandle = {
    runId,
    sessionId,
    events: asyncIterable,
    spawnIndex,
    lastSpawnOpts: opts,
    heartbeat(): HandleHeartbeat {
      return { lastEventAt: 0, seq: lastSeq };
    },
    async send(message: UserTurn): Promise<void> {
      capturedSend = message;
      released = true;
      lastSeq = events.length;
    },
    async interrupt(): Promise<void> {
      released = true;
    },
    async setModel(_model: string): Promise<void> {
      // no-op
    },
    async setPermissionMode(_mode: PermissionMode): Promise<void> {
      // no-op
    },
    async shutdown(_reason: string): Promise<void> {
      released = true;
      queuedEvents.length = 0;
    },
  };

  Object.defineProperty(handle, "lastUserTurn", {
    get: () => capturedSend,
    enumerable: false,
  });

  return handle;
}

/** Minimal capability objects for test doubles. */
export const FAKE_CLAUDE_CAPS: Readonly<Capabilities> = freezeCapabilities({
  resume: true,
  fork: false,
  interrupt: "cooperative",
  permissionModes: ["default", "acceptEdits"],
  mcp: "in-process",
  customTools: true,
  patchVisibility: "events",
  usageReporting: "per-turn",
  costReporting: "native",
  sandboxing: "process",
  streaming: "events",
});

export const FAKE_CODEX_CAPS: Readonly<Capabilities> = freezeCapabilities({
  resume: true,
  fork: false,
  interrupt: "cooperative",
  permissionModes: ["default", "acceptEdits"],
  mcp: "stdio",
  customTools: false,
  patchVisibility: "events",
  usageReporting: "per-turn",
  costReporting: "subscription",
  sandboxing: "process",
  streaming: "events",
});

/** Render a planner/executor/reviewer JSON payload as a fenced model reply. */
export function fencedJson(obj: unknown, preamble = "Here is the output:"): string {
  return `${preamble}\n\n\`\`\`json\n${JSON.stringify(obj, null, 2)}\n\`\`\`\n`;
}
