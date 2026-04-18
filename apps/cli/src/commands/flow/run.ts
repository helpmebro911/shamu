/**
 * `shamu flow run <module-spec>` — execute a flow DAG module.
 *
 * Track 4.C glue between the 4.A flow engine and 4.B (or any externally
 * authored) flow module. The spec-form is deliberately permissive: a
 * bare workspace package name OR a path to a `.ts`/`.js` file. This lets
 * users write one-off flows as local scripts while the canonical flow
 * (4.B) ships as `@shamu/flows-plan-execute-review`.
 *
 * Behavior highlights:
 *   - Mints a fresh WorkflowRunId via the shared ULID factory (G8 —
 *     orchestrator owns the id).
 *   - Persists `flow_runs` rows on every terminal / gate event so a crash
 *     mid-flow leaves enough in the DB to resume.
 *   - JSON-mode emits newline-delimited events exactly mirroring the
 *     internal FlowEvent bus, with a `ts` field copied from the event's
 *     `at`. Human mode emits one short summary line per event.
 *   - Exit codes:
 *       succeeded → 0 (OK)
 *       paused    → 2 (USAGE — a paused flow needs caller attention; no
 *                   dedicated code in the taxonomy yet, and USAGE is the
 *                   closest "the human has to act" signal. Track 4.C
 *                   explicitly asks for 2 here.)
 *       failed    → 10 (RUN_FAILED)
 *   - --resume <id>: loads the prior flow_runs row, deserializes
 *     state_json, and threads it through `FlowEngine.run({ resumeFrom })`.
 */

import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import type { FlowEvent, FlowRunState } from "@shamu/core-flow";
import { deserialize, EventBus, FlowEngine, RunnerRegistry, serialize } from "@shamu/core-flow";
import type { ShamuDatabase } from "@shamu/persistence";
import * as flowRunsQueries from "@shamu/persistence/queries/flow-runs";
import { workflowRunId as brandWorkflowRunId, newWorkflowRunId } from "@shamu/shared";
import { defineCommand } from "citty";
import { ExitCode, type ExitCodeValue } from "../../exit-codes.ts";
import { writeDiag, writeHuman, writeJson } from "../../output.ts";
import { openRunDatabase } from "../../services/run-db.ts";
import { commonArgs, done, outputMode, withServices } from "../_shared.ts";
import {
  type FlowModule,
  FlowModuleContractError,
  loadFlowModule,
  type RegisterRunnersOptions,
} from "../flow-contract.ts";

export const flowRunCommand = defineCommand({
  meta: {
    name: "run",
    description:
      "Run a flow module. <module-spec> is a package name (e.g. @shamu/flows-plan-execute-review) or a path to a .ts/.js file exporting flowDefinition + registerRunners.",
  },
  args: {
    ...commonArgs,
    "module-spec": {
      type: "positional",
      description: "Package name or path to the flow module.",
      required: true,
    },
    task: {
      type: "string",
      description: "Task description forwarded to the flow as initialInputs.task.",
      required: true,
    },
    cwd: {
      type: "string",
      description: "Workspace cwd passed to registerRunners (default: process.cwd()).",
    },
    "max-iterations": {
      type: "string",
      description:
        "Max iterations for loops / review cycles. Forwarded to parseOptions when present.",
    },
    "flow-opt": {
      type: "string",
      description:
        "Repeatable key=value option forwarded to the module's parseOptions(record). Example: --flow-opt plannerModel=gpt-5.4.",
    },
    resume: {
      type: "string",
      description: "Resume from a prior flow-run-id (loads state_json, passes as resumeFrom).",
    },
    db: {
      type: "string",
      description:
        "Override the SQLite path (advanced). Default: $SHAMU_STATE_DIR/shamu.db or .shamu/state/shamu.db.",
    },
    "state-dir": {
      type: "string",
      description:
        "Directory for the SQLite state file (overrides $SHAMU_STATE_DIR; default .shamu/state).",
    },
  },
  async run({ args, rawArgs }): Promise<ExitCodeValue> {
    const mode = outputMode(args);
    const svc = await withServices(args);
    if (!svc.ok) return svc.exitCode;

    const spec = args["module-spec"];
    if (typeof spec !== "string" || spec.length === 0) {
      writeDiag("flow run: <module-spec> is required");
      return done(ExitCode.USAGE);
    }

    const task = args.task;
    if (typeof task !== "string" || task.length === 0) {
      writeDiag("flow run: --task is required and must be non-empty");
      return done(ExitCode.USAGE);
    }

    // --flow-opt is repeatable; citty surfaces repeats as an array OR a
    // single string depending on the invocation. `rawArgs` is the stable
    // source of truth — harvest every occurrence and accumulate.
    const flowOpts = collectFlowOpts(rawArgs);
    const workspaceCwd = (args.cwd as string | undefined) ?? process.cwd();

    const maxIterationsRaw = args["max-iterations"];
    const maxIterationsParsed = parseMaxIterations(maxIterationsRaw);
    if (maxIterationsParsed.kind === "error") {
      writeDiag(`flow run: ${maxIterationsParsed.message}`);
      return done(ExitCode.USAGE);
    }

    // Open the DB first — we want a clean USAGE exit if the state dir
    // can't be created, without having loaded the flow module.
    const dbPath = args.db as string | undefined;
    const stateDir = args["state-dir"] as string | undefined;
    let db: ShamuDatabase;
    try {
      if (dbPath !== undefined && dbPath.length > 0) {
        db = openRunDatabase({ stateDir: absoluteParent(dbPath) });
      } else if (stateDir !== undefined && stateDir.length > 0) {
        db = openRunDatabase({ stateDir });
      } else {
        db = openRunDatabase();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      writeDiag(`flow run: failed to open SQLite database: ${message}`);
      return done(ExitCode.INTERNAL);
    }

    let flowModule: FlowModule;
    try {
      flowModule = await loadFlowModule(spec);
    } catch (err) {
      if (err instanceof FlowModuleContractError) {
        writeDiag(`flow run: ${err.message}`);
      } else {
        const message = err instanceof Error ? err.message : String(err);
        writeDiag(`flow run: failed to load module '${spec}': ${message}`);
      }
      try {
        db.close();
      } catch {
        // best-effort close; don't mask the failure.
      }
      return done(ExitCode.USAGE);
    }

    // Combine options: parseOptions (module-specific) overrides the
    // max-iterations default; if the module does not export parseOptions,
    // max-iterations lands directly on RegisterRunnersOptions.
    let parseOpts: Partial<RegisterRunnersOptions> = {};
    if (flowModule.parseOptions !== undefined) {
      try {
        const combined = { ...flowOpts };
        if (maxIterationsParsed.value !== null) {
          combined.maxIterations = String(maxIterationsParsed.value);
        }
        parseOpts = flowModule.parseOptions(combined);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        writeDiag(`flow run: parseOptions threw: ${message}`);
        try {
          db.close();
        } catch {
          // best-effort
        }
        return done(ExitCode.USAGE);
      }
    } else if (maxIterationsParsed.value !== null) {
      parseOpts = { maxIterations: maxIterationsParsed.value };
    }
    const registerOpts: RegisterRunnersOptions = {
      workspaceCwd,
      ...parseOpts,
    };

    const logger = svc.services.logger;

    try {
      // Resume path: load the prior row and deserialize its state. The
      // flowRunId the engine sees on resume stays the SAME as the stored
      // id (we're appending progress to the same SQLite row). Minting a
      // new id on resume would orphan the prior state.
      let resumeFrom: FlowRunState | null = null;
      let flowRunId = newWorkflowRunId();
      const resumeArg = args.resume as string | undefined;
      if (resumeArg !== undefined && resumeArg.length > 0) {
        const priorId = brandWorkflowRunId(resumeArg);
        const row = flowRunsQueries.getFlowRun(db, priorId);
        if (!row) {
          writeDiag(`flow run: --resume '${resumeArg}' not found in flow_runs`);
          try {
            db.close();
          } catch {
            // best-effort
          }
          return done(ExitCode.USAGE);
        }
        try {
          resumeFrom = deserialize(row.stateJson);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          writeDiag(`flow run: failed to deserialize prior state: ${message}`);
          try {
            db.close();
          } catch {
            // best-effort
          }
          return done(ExitCode.INTERNAL);
        }
        flowRunId = priorId;
      }

      const registry = new RunnerRegistry();
      try {
        flowModule.registerRunners(registry, registerOpts);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        writeDiag(`flow run: registerRunners threw: ${message}`);
        try {
          db.close();
        } catch {
          // best-effort
        }
        return done(ExitCode.INTERNAL);
      }

      const bus = new EventBus<FlowEvent>();
      let latestState: FlowRunState | null = resumeFrom;
      let flowRowCreated = resumeFrom !== null;

      // Logger + JSON sink. We subscribe BEFORE invoking engine.run so
      // the flow_started event is captured.
      const sinkDispose = bus.subscribe((ev) => {
        logger.info(`flow: ${ev.kind}`, {
          flowRunId: ev.flowRunId,
          ...eventLogContext(ev),
        });
        if (mode === "json") {
          process.stdout.write(`${JSON.stringify(toJsonEvent(ev))}\n`);
        } else {
          writeHuman(mode, formatFlowEventLine(ev));
        }
      });

      // Persistence sink: write flow_runs rows on lifecycle transitions.
      const persistDispose = bus.subscribe((ev) => {
        try {
          if (ev.kind === "flow_started") {
            if (!flowRowCreated) {
              flowRunsQueries.insertFlowRun(db, {
                flowRunId: ev.flowRunId,
                flowId: ev.flowId,
                dagVersion: ev.version,
                status: "running",
                stateJson: serialize(
                  latestState ?? {
                    flowRunId: ev.flowRunId,
                    flowId: ev.flowId,
                    version: ev.version,
                    entry: flowModule.flowDefinition.entry,
                    nodeStatus: {},
                    nodeOutputs: {},
                    pendingGate: null,
                    startedAt: ev.at,
                    updatedAt: ev.at,
                    totalCostUsd: null,
                    costSamples: [],
                  },
                ),
                resumedFrom: ev.resumedFrom,
                startedAt: ev.at,
              });
              flowRowCreated = true;
            }
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          writeDiag(`flow run: persistence failure on ${ev.kind}: ${message}`);
        }
      });

      const engine = new FlowEngine({ registry, bus });
      const controller = new AbortController();
      const onSigint = (): void => controller.abort();
      process.on("SIGINT", onSigint);
      process.on("SIGTERM", onSigint);

      try {
        const finalState = await engine.run(flowModule.flowDefinition, {
          flowRunId,
          initialInputs: { task },
          ...(resumeFrom !== null ? { resumeFrom } : {}),
          signal: controller.signal,
        });
        latestState = finalState;
      } finally {
        process.off("SIGINT", onSigint);
        process.off("SIGTERM", onSigint);
        sinkDispose();
        persistDispose();
      }

      // Determine terminal status from final state + most recent event. The
      // engine emits a `flow_completed` which is the authoritative signal;
      // by the time we return, that's already been fed through the sinks,
      // so we rely on the state's own indicators.
      const terminalStatus = deriveTerminalStatus(latestState);

      // Flush final state + status to SQLite. `updateFlowRunState` is a
      // no-op if the row wasn't created (defensive — if flow_started was
      // lost somehow, we still want the run visible).
      if (latestState !== null) {
        try {
          if (!flowRowCreated) {
            flowRunsQueries.insertFlowRun(db, {
              flowRunId: latestState.flowRunId,
              flowId: latestState.flowId,
              dagVersion: latestState.version,
              status: terminalStatus,
              stateJson: serialize(latestState),
              resumedFrom: null,
              startedAt: latestState.startedAt,
            });
            flowRowCreated = true;
          } else {
            flowRunsQueries.updateFlowRunState(
              db,
              latestState.flowRunId,
              terminalStatus,
              serialize(latestState),
              Date.now(),
            );
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          writeDiag(`flow run: failed to flush final state: ${message}`);
        }
      }

      writeJson(mode, {
        kind: "flow-run-summary",
        flowRunId,
        status: terminalStatus,
        totalCostUsd: latestState?.totalCostUsd ?? null,
      });
      writeHuman(
        mode,
        `flow ${flowRunId} ${terminalStatus} (cost=${latestState?.totalCostUsd ?? "null"})`,
      );

      return done(exitCodeFor(terminalStatus));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      writeDiag(`flow run: ${message}`);
      return done(ExitCode.INTERNAL);
    } finally {
      try {
        db.close();
      } catch {
        // best-effort close
      }
    }
  },
});

// --- Helpers ---------------------------------------------------------------

interface MaxIterationsOk {
  readonly kind: "ok";
  readonly value: number | null;
}
interface MaxIterationsErr {
  readonly kind: "error";
  readonly message: string;
}
type MaxIterationsResult = MaxIterationsOk | MaxIterationsErr;

function parseMaxIterations(raw: string | undefined): MaxIterationsResult {
  if (raw === undefined || raw === "") return { kind: "ok", value: null };
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    return {
      kind: "error",
      message: `--max-iterations must be a positive integer, got '${raw}'`,
    };
  }
  return { kind: "ok", value: n };
}

/**
 * Scan rawArgs for every `--flow-opt key=value` pair. citty collapses
 * repeated flags; rawArgs is the stable source of truth here.
 */
function collectFlowOpts(rawArgs: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === "--flow-opt") {
      const next = rawArgs[i + 1];
      if (typeof next === "string") {
        const eq = next.indexOf("=");
        if (eq > 0) {
          const key = next.slice(0, eq);
          const value = next.slice(eq + 1);
          out[key] = value;
        }
        i++;
      }
    } else if (typeof arg === "string" && arg.startsWith("--flow-opt=")) {
      const body = arg.slice("--flow-opt=".length);
      const eq = body.indexOf("=");
      if (eq > 0) {
        out[body.slice(0, eq)] = body.slice(eq + 1);
      }
    }
  }
  return out;
}

function deriveTerminalStatus(state: FlowRunState | null): "succeeded" | "failed" | "paused" {
  if (state === null) return "failed";
  if (state.pendingGate !== null) return "paused";
  // If any node failed, flow failed. If any is still running/pending, we
  // treat it as failed too (engine should never leave partial state on a
  // normal return — belt + suspenders).
  for (const status of Object.values(state.nodeStatus)) {
    if (status === "failed") return "failed";
    if (status === "running" || status === "pending") return "failed";
    if (status === "paused") return "paused";
  }
  return "succeeded";
}

function exitCodeFor(status: "succeeded" | "failed" | "paused"): ExitCodeValue {
  if (status === "succeeded") return ExitCode.OK;
  if (status === "paused") return ExitCode.USAGE;
  return ExitCode.RUN_FAILED;
}

/**
 * Strip the `kind` discriminator so JSON listeners get a typed envelope
 * `{ ts, kind, flowRunId, payload }` rather than the raw union shape.
 * Per the 4.C spec.
 */
function toJsonEvent(ev: FlowEvent): {
  readonly ts: number;
  readonly kind: string;
  readonly flowRunId: string;
  readonly payload: Record<string, unknown>;
} {
  // Destructure out the fields we surface as top-level; the rest becomes
  // `payload`. Done per-kind so the engine's field names are preserved
  // verbatim.
  switch (ev.kind) {
    case "flow_started": {
      const { kind, at, flowRunId, ...rest } = ev;
      return { ts: at, kind, flowRunId, payload: rest };
    }
    case "node_started": {
      const { kind, at, flowRunId, ...rest } = ev;
      return { ts: at, kind, flowRunId, payload: rest };
    }
    case "node_completed": {
      const { kind, at, flowRunId, ...rest } = ev;
      return { ts: at, kind, flowRunId, payload: rest };
    }
    case "node_failed": {
      const { kind, at, flowRunId, ...rest } = ev;
      return { ts: at, kind, flowRunId, payload: rest };
    }
    case "human_gate_reached": {
      const { kind, at, flowRunId, ...rest } = ev;
      return { ts: at, kind, flowRunId, payload: rest };
    }
    case "flow_completed": {
      const { kind, at, flowRunId, ...rest } = ev;
      return { ts: at, kind, flowRunId, payload: rest };
    }
  }
}

function formatFlowEventLine(ev: FlowEvent): string {
  const head = `[flow ${ev.flowRunId}] ${ev.kind}`;
  switch (ev.kind) {
    case "flow_started":
      return `${head} flowId=${ev.flowId} v=${ev.version}`;
    case "node_started":
      return `${head} node=${ev.nodeId} attempt=${ev.attempt}${ev.role ? ` role=${ev.role}` : ""}`;
    case "node_completed":
      return `${head} node=${ev.nodeId} ok=${ev.output.ok} cached=${ev.cached} dur=${ev.durationMs}ms cost=${ev.output.costUsd ?? "null"}`;
    case "node_failed":
      return `${head} node=${ev.nodeId} retriable=${ev.error.retriable} willRetry=${ev.willRetry}: ${ev.error.message}`;
    case "human_gate_reached":
      return `${head} node=${ev.nodeId} resumeToken=${ev.resumeToken}`;
    case "flow_completed":
      return `${head} status=${ev.status} cost=${ev.totalCostUsd ?? "null"} nodes=${ev.nodeCount}`;
  }
}

/**
 * Build a structured logger context for a flow event. Keeps the contract
 * with `@shamu/shared/logger` uniform: no bare event-object dumps.
 */
function eventLogContext(ev: FlowEvent): Record<string, unknown> {
  switch (ev.kind) {
    case "flow_started":
      return { flowId: ev.flowId, version: ev.version, resumedFrom: ev.resumedFrom };
    case "node_started":
      return { nodeId: ev.nodeId, attempt: ev.attempt };
    case "node_completed":
      return { nodeId: ev.nodeId, cached: ev.cached, ok: ev.output.ok, durationMs: ev.durationMs };
    case "node_failed":
      return { nodeId: ev.nodeId, retriable: ev.error.retriable, willRetry: ev.willRetry };
    case "human_gate_reached":
      return { nodeId: ev.nodeId, resumeToken: ev.resumeToken };
    case "flow_completed":
      return {
        status: ev.status,
        totalCostUsd: ev.totalCostUsd,
        costConfidence: ev.costConfidence,
        nodeCount: ev.nodeCount,
      };
  }
}

/**
 * If `--db` points at a specific file, we still open the database via
 * `openRunDatabase(stateDir)`. Compute a stateDir = the parent dir of
 * the requested file. Callers that don't pass `--db` are handled before
 * we reach here.
 */
function absoluteParent(path: string): string {
  const abs = resolvePath(path);
  if (!existsSync(abs)) {
    const lastSlash = abs.lastIndexOf("/");
    if (lastSlash < 0) return process.cwd();
    return abs.slice(0, lastSlash);
  }
  // If the path exists as a dir, treat it as the stateDir; if it exists
  // as a file, take its parent.
  const lastSlash = abs.lastIndexOf("/");
  if (lastSlash < 0) return process.cwd();
  return abs.slice(0, lastSlash);
}
