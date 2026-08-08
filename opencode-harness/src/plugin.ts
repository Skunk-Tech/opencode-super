import { tool, type Plugin } from "@opencode-ai/plugin";
import fs from "fs";
import path from "path";
import { globalHarnessDir, ensureDir } from "./paths";
import { appendEvidence, loadState, readEvidence, listSnapshots, rollback } from "./store";
import { buildInjection, buildCompactionContext, buildContinuationNudge } from "./inject";
import { gatherEvidenceSummary, applyOps, type RefineOp } from "./refine";
import { runAutoRefine, readRefineState, AUTO_REFINE_MIN_EVIDENCE, AUTO_REFINE_MAX_OPS, type AutoRefineClient } from "./autorefine";
import { checkForUpdates, ownBundlePath, readVersionMarker } from "./updater";

export function looksLikeError(output: string | undefined, metadata?: Record<string, unknown> | null, tool?: string): boolean {
  if (tool === "bash") {
    const exit = metadata?.exit;
    return typeof exit === "number" && exit !== 0;
  }
  return false;
}

function recordSessionProject(sessionID: string, project: string): void {
  if (!project) return;
  ensureDir(globalHarnessDir());
  const file = path.join(globalHarnessDir(), "sessions.json");
  let map: Record<string, string> = {};
  if (fs.existsSync(file)) {
    try {
      map = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      // corrupt sessions.json: fall back to an empty map so evidence capture continues
      map = {};
    }
  }
  map[sessionID] = project;
  fs.writeFileSync(file, JSON.stringify(map, null, 2), "utf8");
}

const REFINE_TEMPLATE = `Run the harness refine workflow (load the \`harness-refine\` skill) and apply evidence-backed refinements. Focus: $ARGUMENTS (optional).`;

const HARNESS_TEMPLATE = `Handle a harness management request using the appropriate harness tools:
- status -> \`harness_status\`
- history -> \`harness_history\`
- rollback <id> -> \`harness_rollback\` with id $1

Request: $ARGUMENTS`;

export const AUTO_REFINE_ENABLED = true;
export const AUTO_UPDATE_ENABLED = true;
export const UPDATE_CHECK_HOURS = 6;
export const UPDATE_REPO = "Skunk-Tech/opencode-super";

type SessionActivity = { lastFinish?: string; sawToolCalls: boolean };

export function isPrematureStop(finish: string | undefined, sawToolCalls: boolean): boolean {
  return finish === "stop" && sawToolCalls;
}

export const HarnessPlugin: Plugin = async ({ directory, client }) => {
  const global = globalHarnessDir();
  const activity = new Map<string, SessionActivity>();

  // The SDK client returns { data, error } shapes; adapt it to the AutoRefineClient contract
  // (create resolves to the session, promptAsync accepts { path, body }).
  const refineClient: AutoRefineClient = {
    session: {
      create: async (opts) => {
        const res = await client.session.create({ query: opts.query, throwOnError: true });
        return { id: res.data.id };
      },
      promptAsync: (opts) => client.session.promptAsync(opts as Parameters<typeof client.session.promptAsync>[0]),
    },
  };

  const recordFinish = (sessionID: string, finish: string | undefined): void => {
    if (!sessionID || finish === undefined) return;
    const cur = activity.get(sessionID) ?? { sawToolCalls: false };
    cur.lastFinish = finish;
    if (finish === "tool-calls") cur.sawToolCalls = true;
    activity.set(sessionID, cur);
  };

  const ownPath = ownBundlePath();
  const updateStateFile = path.join(global, "update-state.json");
  const recordUpdateState = (state: Record<string, unknown>): void => {
    try { fs.writeFileSync(updateStateFile, JSON.stringify({ ...state, checkedAt: new Date().toISOString() }, null, 2), "utf8"); } catch { /* best-effort */ }
  };
  const checkUpdate = (): void => {
    void checkForUpdates(ownPath ?? "", UPDATE_REPO, { enabled: AUTO_UPDATE_ENABLED }).then((result) => {
      if (result === "updated") recordUpdateState({ pendingRestart: true, latest: readVersionMarker(ownPath ?? "") ?? "unknown" });
      else if (result === "current") recordUpdateState({ pendingRestart: false });
    }).catch(() => { /* silent */ });
  };
  const initialTimer = setTimeout(checkUpdate, 30_000);
  const intervalTimer = setInterval(checkUpdate, UPDATE_CHECK_HOURS * 3_600_000);
  // Timers keep a reference so they are not garbage-collected. opencode's server process
  // is long-lived, and plugins only run while opencode is open, so a wall-clock interval
  // plus a startup check is the supported schedule.

  return {
    config: async (config) => {
      config.command = config.command ?? {};
      if (!config.command["refine"]) {
        config.command["refine"] = { description: "Run the Continual Harness refine loop over recent evidence", agent: "refiner", template: REFINE_TEMPLATE };
      }
      if (!config.command["harness"]) {
        config.command["harness"] = { description: "Inspect or manage the Continual Harness (status, history, rollback)", agent: "refiner", template: HARNESS_TEMPLATE };
      }
      config.agent = config.agent ?? {};
      if (!config.agent["refiner"]) {
        config.agent["refiner"] = {
          description: "Runs the Continual Harness refine loop and harness management tools",
          mode: "subagent",
          permission: { edit: "deny", bash: "deny", skill: { "harness-refine": "allow" } } as unknown as Record<string, unknown>,
          prompt: "You are the refiner for the opencode Continual Harness. You analyze evidence, apply conservative refinements via the harness_* tools, and report results. You never edit files directly.",
        };
      }
    },

    "tool.execute.after": async (input, output) => {
      if (input.tool === "harness_refine" || input.tool === "harness_apply") return;
      recordSessionProject(input.sessionID, directory);
      const failure = looksLikeError(output.output, output.metadata, input.tool);
      if (!failure) return;
      const rows = readEvidence(global);
      const lastSameTool = rows.filter((r) => r.sessionID === input.sessionID && r.tool === input.tool).slice(-1)[0];
      const isRetry = lastSameTool && lastSameTool.kind === "tool_failure";
      appendEvidence(global, {
        ts: new Date().toISOString(),
        sessionID: input.sessionID,
        kind: isRetry ? "retry" : "tool_failure",
        tool: input.tool,
        args: JSON.stringify(input.args ?? {}).slice(0, 200),
        output: output.output,
        project: directory,
      });
    },

    event: async ({ event }) => {
      const props = (event as { properties?: Record<string, any> }).properties ?? {};
      const id = typeof props.sessionID === "string" ? props.sessionID : (props.info as { id?: string } | undefined)?.id;
      if (!id) return;
      if (event.type === "message.updated") {
        const info = props.info as { role?: string; finish?: string } | undefined;
        if (info?.role === "assistant") recordFinish(id, info.finish);
      } else if (event.type === "session.error") {
        appendEvidence(global, { ts: new Date().toISOString(), sessionID: id, kind: "session_error", project: directory });
      } else if (event.type === "session.idle") {
        const cur = activity.get(id);
        if (isPrematureStop(cur?.lastFinish, cur?.sawToolCalls ?? false)) {
          appendEvidence(global, { ts: new Date().toISOString(), sessionID: id, kind: "premature_stop", finish: cur?.lastFinish, project: directory });
        }
        appendEvidence(global, { ts: new Date().toISOString(), sessionID: id, kind: "session_idle", project: directory });
        activity.delete(id);
        void runAutoRefine(refineClient, directory, global, { enabled: AUTO_REFINE_ENABLED, minEvidence: AUTO_REFINE_MIN_EVIDENCE, maxOps: AUTO_REFINE_MAX_OPS });
      } else if (event.type === "session.created") {
        appendEvidence(global, { ts: new Date().toISOString(), sessionID: id, kind: "session_created", project: directory });
      }
    },

    "experimental.chat.system.transform": async (_input, output) => {
      const injection = buildInjection(loadState(global), "global");
      if (injection) output.system.push(injection);
      output.system.push(buildContinuationNudge());
    },

    "experimental.session.compacting": async (_input, output) => {
      output.context.push(...buildCompactionContext(loadState(global), "global"));
    },

    tool: {
      harness_refine: tool({
        description: "Review recent harness evidence and the current session trajectory, then recommend evidence-backed refinements (memories, spec updates, or new skills/agents). Conservative: weak evidence means no change.",
        args: {
          focus: tool.schema.string().optional().describe("Optional focus area to filter evidence."),
        },
        async execute(args) {
          const focus = (args as { focus?: string }).focus;
          return `## Harness evidence (recent)\n${gatherEvidenceSummary(global, focus)}\n\n## Current state\n${JSON.stringify(loadState(global), null, 2)}\n\nAssess candidates on frequency, cost, risk, stability, and existing coverage. If a candidate scores strong (>=0.6), propose it via harness_apply with kind=memory|spec|delete (use specKind=skill|subagent for spec writes) and the exact body. For new skills/agents, only if repeated friction justifies it. Otherwise report 'No change recommended'.`;
        },
      }),

      harness_apply: tool({
        description: "Apply concrete harness refinements. Snapshots state first; every write is rollback-able via harness_rollback.",
        args: {
          ops: tool.schema.array(tool.schema.object({
            op: tool.schema.enum(["memory", "spec", "delete"]),
            kind: tool.schema.enum(["memory", "spec"]),
            specKind: tool.schema.enum(["skill", "subagent"]).optional(),
            name: tool.schema.string(),
            scope: tool.schema.enum(["global", "project"]),
            body: tool.schema.string(),
            confidence: tool.schema.number().optional(),
            evidence: tool.schema.array(tool.schema.string()).optional(),
          })).describe("Refinement operations to apply."),
        },
        async execute(args) {
          const ops = (args as { ops: RefineOp[] }).ops;
          const { snapshotID, applied } = applyOps(global, ops);
          return `Applied ${applied.length} op(s). Snapshot: ${snapshotID}\nOps: ${applied.join(", ")}`;
        },
      }),

      harness_status: tool({
        description: "Show the current harness state: memory/spec counts, evidence totals, and snapshots.",
        args: {},
        async execute() {
          const state = loadState(global);
          const snapshots = listSnapshots(global);
          const refine = readRefineState(global);
          let update = "no check yet";
          try {
            if (fs.existsSync(updateStateFile)) {
              const u = JSON.parse(fs.readFileSync(updateStateFile, "utf8"));
              update = u.pendingRestart ? `update available (${u.latest}), restart opencode to load` : `up to date (checked ${u.checkedAt})`;
            }
          } catch { /* corrupt update-state.json */ }
          return `## Harness status\nglobal: ${global}\nmemories: ${state.memories.length}\nspecs: ${state.specs.length}\nevidence entries: ${readEvidence(global).length}\nsnapshots: ${snapshots.length}\nlast auto-refine: ${refine.lastAutoRefineAt ?? "never"}\nupdates: ${update}`;
        },
      }),

      harness_history: tool({
        description: "List harness snapshot ids for rollback.",
        args: {},
        async execute() {
          const snapshots = listSnapshots(global);
          return snapshots.length ? snapshots.join("\n") : "No snapshots yet.";
        },
      }),

      harness_rollback: tool({
        description: "Roll back the harness state to a previous snapshot id.",
        args: {
          id: tool.schema.string().describe("Snapshot id from harness_history."),
        },
        async execute(args) {
          const id = (args as { id: string }).id;
          try {
            rollback(global, id);
            return `Rolled back to snapshot ${id}`;
          } catch (e) {
            const avail = listSnapshots(global);
            return `Rollback failed: ${(e as Error).message}. Available: ${avail.join(", ") || "none"}`;
          }
        },
      }),
    },
  };
};
