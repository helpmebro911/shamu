/**
 * `shamu flow status <flow-run-id>` — inspect a persisted flow run.
 *
 * Reads `flow_runs.*` for the given id, deserializes `state_json`, and
 * emits either:
 *   - Human: a per-node status table + aggregate cost.
 *   - JSON: the full row with `state_json` parsed into an object.
 *
 * Exit codes:
 *   - OK when the row exists (regardless of its status — status is a
 *     property of the run, not a failure of the lookup).
 *   - USAGE when the id is not found.
 */

import type { FlowRunState } from "@shamu/core-flow";
import { deserialize } from "@shamu/core-flow";
import type { ShamuDatabase } from "@shamu/persistence";
import * as flowRunsQueries from "@shamu/persistence/queries/flow-runs";
import { workflowRunId as brandWorkflowRunId } from "@shamu/shared";
import { defineCommand } from "citty";
import { ExitCode, type ExitCodeValue } from "../../exit-codes.ts";
import { writeDiag, writeHuman, writeJson } from "../../output.ts";
import { openRunDatabase } from "../../services/run-db.ts";
import { commonArgs, done, outputMode, withServices } from "../_shared.ts";

export const flowStatusCommand = defineCommand({
  meta: {
    name: "status",
    description: "Show the persisted status of a flow run by id.",
  },
  args: {
    ...commonArgs,
    "flow-run-id": {
      type: "positional",
      description: "Flow-run id (WorkflowRunId / ULID).",
      required: true,
    },
    "state-dir": {
      type: "string",
      description:
        "Directory for the SQLite state file (overrides $SHAMU_STATE_DIR; default .shamu/state).",
    },
  },
  async run({ args }): Promise<ExitCodeValue> {
    const mode = outputMode(args);
    const svc = await withServices(args);
    if (!svc.ok) return svc.exitCode;

    const raw = args["flow-run-id"];
    if (typeof raw !== "string" || raw.length === 0) {
      writeDiag("flow status: <flow-run-id> is required");
      return done(ExitCode.USAGE);
    }
    const id = brandWorkflowRunId(raw);

    const stateDir = args["state-dir"] as string | undefined;
    let db: ShamuDatabase;
    try {
      db =
        stateDir !== undefined && stateDir.length > 0
          ? openRunDatabase({ stateDir })
          : openRunDatabase();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      writeDiag(`flow status: failed to open SQLite database: ${message}`);
      return done(ExitCode.INTERNAL);
    }

    try {
      const row = flowRunsQueries.getFlowRun(db, id);
      if (!row) {
        if (mode === "json") {
          writeJson(mode, {
            kind: "error",
            category: "not-found",
            flowRunId: raw,
            message: `flow run '${raw}' not found`,
          });
        } else {
          writeDiag(`flow status: '${raw}' not found`);
        }
        return done(ExitCode.USAGE);
      }

      // Parse state_json. A malformed blob is a hard internal error (the
      // engine should never persist unparseable state) but we still surface
      // the raw row so the caller isn't stuck.
      let state: FlowRunState | null = null;
      let stateParseError: string | null = null;
      try {
        state = deserialize(row.stateJson);
      } catch (err) {
        stateParseError = err instanceof Error ? err.message : String(err);
        svc.services.logger.warn("flow status: state_json deserialize failed", {
          flowRunId: raw,
          error: stateParseError,
        });
      }

      if (mode === "json") {
        writeJson(mode, {
          kind: "flow-status",
          flowRunId: row.flowRunId,
          flowId: row.flowId,
          dagVersion: row.dagVersion,
          status: row.status,
          resumedFrom: row.resumedFrom,
          startedAt: row.startedAt,
          updatedAt: row.updatedAt,
          state: state === null ? null : stateToJson(state),
          ...(stateParseError === null ? {} : { stateParseError }),
        });
        return done(ExitCode.OK);
      }

      writeHuman(
        mode,
        `Flow ${row.flowRunId} (${row.status}, startedAt=${isoOrRaw(row.startedAt)}, updatedAt=${isoOrRaw(row.updatedAt)})`,
      );
      writeHuman(mode, `  flowId=${row.flowId} v=${row.dagVersion}`);
      if (row.resumedFrom !== null) {
        writeHuman(mode, `  resumedFrom=${row.resumedFrom}`);
      }
      if (state !== null) {
        writeHuman(mode, `  totalCostUsd=${state.totalCostUsd ?? "null"}`);
        const entries = Object.entries(state.nodeStatus);
        if (entries.length === 0) {
          writeHuman(mode, "  no node activity recorded");
        } else {
          writeHuman(mode, "  nodes:");
          for (const [nodeIdStr, status] of entries) {
            writeHuman(mode, `    - ${nodeIdStr}: ${status}`);
          }
        }
        if (state.pendingGate !== null) {
          writeHuman(
            mode,
            `  pendingGate: node=${state.pendingGate.nodeId} token=${state.pendingGate.resumeToken}`,
          );
        }
      } else if (stateParseError !== null) {
        writeHuman(mode, `  state: <unparseable: ${stateParseError}>`);
      }
      return done(ExitCode.OK);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      writeDiag(`flow status: ${message}`);
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

/** Convert branded state to a plain JSON-friendly structure. */
function stateToJson(state: FlowRunState): Record<string, unknown> {
  return {
    flowRunId: state.flowRunId,
    flowId: state.flowId,
    version: state.version,
    entry: state.entry,
    nodeStatus: state.nodeStatus,
    nodeOutputs: state.nodeOutputs,
    pendingGate: state.pendingGate,
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
    totalCostUsd: state.totalCostUsd,
    costSamples: state.costSamples,
  };
}

function isoOrRaw(epoch: number): string {
  try {
    const d = new Date(epoch);
    const iso = d.toISOString();
    return Number.isNaN(d.getTime()) ? String(epoch) : iso;
  } catch {
    return String(epoch);
  }
}
