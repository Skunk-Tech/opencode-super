import { tool, type Plugin } from "@opencode-ai/plugin";
import fs from "fs";
import path from "path";
import { globalHarnessDir, projectHarnessDir, ensureDir } from "./paths";
import { appendEvidence, loadState, loadMergedState, readEvidence, listSnapshots, rollback } from "./store";
import { buildInjection, buildCompactionContext, buildContinuationNudge, buildStateSummary } from "./inject";
import { gatherEvidenceSummary, applyOps, validateOps, type RefineOp } from "./refine";
import { runAutoRefine, readRefineState, AUTO_REFINE_MIN_EVIDENCE, AUTO_REFINE_MAX_OPS, AUTO_REFINE_COOLDOWN_MS, type AutoRefineClient } from "./autorefine";
import { checkForUpdates, ownBundlePath, readVersionMarker } from "./updater";

export type HarnessPluginOptions = {
  /** Registered model (provider/modelID) used for the plugin's refiner work. */
  model?: string;
  /** Override for automatic refine (defaults to AUTO_REFINE_ENABLED). */
  autoRefineEnabled?: boolean;
  /** Minimum real-signal evidence rows that trigger an auto-refine. */
  minEvidence?: number;
  /** Cooldown between auto-refine runs, in ms. */
  cooldownMs?: number;
};

export function looksLikeError(output: string | undefined, metadata?: Record<string, unknown> | null, tool?: string): boolean {
  if (tool === "bash") {
    const exit = metadata?.exit;
    return typeof exit === "number" && exit !== 0;
  }
  return false;
}

const sessionProjectSeen = new Set<string>();
const lastFailureKinds = new Map<string, "tool_failure" | "retry">();

/**
 * Map sessionID -> project so sessions can be attributed to their working dir.
 * sessions.json can grow to hundreds of KB; a rewrite on every tool execution
 * (the old behaviour) is massive write amplification across a fleet. We only
 * touch disk when a genuinely NEW session id appears, and always merge from the
 * on-disk file first so concurrent plugin instances cannot clobber each other.
 */
function recordSessionProject(sessionID: string, project: string): void {
  if (!project) return;
  const key = `${sessionID}|${project}`;
  if (sessionProjectSeen.has(key)) return;
  sessionProjectSeen.add(key);
  ensureDir(globalHarnessDir());
  const file = path.join(globalHarnessDir(), "sessions.json");
  let map: Record<string, string> = {};
  if (fs.existsSync(file)) {
    try {
      map = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      map = {};
    }
  }
  if (map[sessionID] === project) {
    // Already persisted (e.g. written by another plugin instance).
    return;
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

const OPS_SCHEMA = tool.schema.array(tool.schema.object({
  op: tool.schema.enum(["memory", "spec", "delete"]),
  kind: tool.schema.enum(["memory", "spec"]),
  specKind: tool.schema.enum(["skill", "subagent", "team"]).optional(),
  name: tool.schema.string(),
  scope: tool.schema.enum(["global", "project"]),
  body: tool.schema.string(),
  confidence: tool.schema.number().optional(),
  evidence: tool.schema.array(tool.schema.string()).optional(),
}));

export type HarnessEventContext = {
  directory: string;
  global: string;
  project: string;
  client: AutoRefineClient;
  autoRefineEnabled: boolean;
  minEvidence: number;
  maxOps: number;
  cooldownMs: number;
  model?: string;
};

export type HarnessEventLike = {
  type: string;
  properties?: Record<string, any>;
};

/**
 * Handle a single harness event. Pure and dependency-injectable so it can be
 * tested against temp dirs instead of the real global harness store.
 *
 * Evidence capture is intentionally SIGNAL-ONLY:
 *  - session.error  -> a real failure worth recording (auth, overflow, etc.)
 *  - session.idle   -> triggers auto-refine, but records NOTHING (lifecycle noise)
 *  - session.created -> records NOTHING (lifecycle noise)
 *  - premature_stop  -> REMOVED. The old finish==="stop" && sawToolCalls detector
 *    fired on every normal tool-using session (opencode ends a normal turn with
 *    finish "stop" after tool round-trips), manufacturing ~9k false evidence rows
 *    that drove auto-refine in a self-sustaining loop.
 */
export async function handleHarnessEvent(ctx: HarnessEventContext, event: HarnessEventLike): Promise<void> {
  const props = event.properties ?? {};
  const id = typeof props.sessionID === "string" ? props.sessionID : (props.info as { id?: string } | undefined)?.id;
  if (!id) return;
  if (event.type === "session.error") {
    appendEvidence(ctx.global, { ts: new Date().toISOString(), sessionID: id, kind: "session_error", project: ctx.directory });
  } else if (event.type === "session.idle") {
    await runAutoRefine(ctx.client, ctx.directory, ctx.global, ctx.project, {
      enabled: ctx.autoRefineEnabled,
      minEvidence: ctx.minEvidence,
      maxOps: ctx.maxOps,
      cooldownMs: ctx.cooldownMs,
      parentID: id,
      model: ctx.model,
    });
  }
  // session.created and all message.updated lifecycle events are intentionally ignored.
}

export const HarnessPlugin: Plugin = async ({ directory, client }, options) => {
  const global = globalHarnessDir();
  const project = projectHarnessDir(directory);
  const pluginOptions = (options ?? {}) as HarnessPluginOptions;

  // The SDK client returns { data, error } shapes; adapt it to the AutoRefineClient contract
  // (create resolves to the session, promptAsync accepts { path, body }).
  const refineClient: AutoRefineClient = {
    session: {
      create: async (opts) => {
        const res = await client.session.create({ query: opts.query, body: opts.body, throwOnError: true });
        return { id: res.data.id };
      },
      promptAsync: (opts) => client.session.promptAsync(opts as Parameters<typeof client.session.promptAsync>[0]),
    },
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
      config.agent = config.agent ?? {};
      const model = (config.agent?.refiner?.model as string | undefined) || pluginOptions.model || "";
      if (!config.command["refine"]) {
        config.command["refine"] = { description: "Run the Continual Harness refine loop over recent evidence", agent: "refiner", model: model || undefined, template: REFINE_TEMPLATE };
      } else if (model && !(config.command["refine"] as { model?: string }).model) {
        (config.command["refine"] as { model?: string }).model = model;
      }
      if (!config.command["harness"]) {
        config.command["harness"] = { description: "Inspect or manage the Continual Harness (status, history, rollback)", agent: "refiner", model: model || undefined, template: HARNESS_TEMPLATE };
      } else if (model && !(config.command["harness"] as { model?: string }).model) {
        (config.command["harness"] as { model?: string }).model = model;
      }
      if (!config.agent["refiner"]) {
        config.agent["refiner"] = {
          description: "Runs the Continual Harness refine loop and harness management tools",
          mode: "subagent",
          model: pluginOptions.model || undefined,
          permission: { edit: "deny", bash: "deny", skill: { "harness-refine": "allow" } } as unknown as Record<string, unknown>,
          prompt: "You are the refiner for the opencode Continual Harness. You analyze evidence, apply conservative refinements via the harness_* tools, and report results. You never edit files directly.",
        };
      }
      if (!config.agent["harness-redteam"]) {
        config.agent["harness-redteam"] = {
          description: "Adversarial reviewer. Challenges refiner-proposed harness ops for counter-evidence, scope, and grounding.",
          mode: "subagent",
          model: pluginOptions.model || undefined,
          permission: { edit: "deny", bash: "deny" } as unknown as Record<string, unknown>,
          prompt: "You are the adversary for the opencode Continual Harness. Given a set of proposed harness ops (memory/spec writes or deletes) and the full evidence summary, challenge each one: find counter-evidence in the full harness store, question scope, demand the evidence supports the claim, flag over-generalization and single-session memories, and recommend accept/revise/reject per op. You never edit files directly; you only report challenges.",
        };
      }
    },

    "tool.execute.after": async (input, output) => {
      if (input.tool === "harness_refine" || input.tool === "harness_apply") return;
      recordSessionProject(input.sessionID, directory);
      const failure = looksLikeError(output.output, output.metadata, input.tool);
      if (!failure) return;
      // Retry detection used to re-read and re-parse the entire evidence file on
      // every failure; with a 15MB store that is huge amplification across a
      // fleet. Track the last outcome per (session, tool) in memory instead.
      const retryKey = `${input.sessionID}|${input.tool}`;
      const isRetry = lastFailureKinds.get(retryKey) === "tool_failure";
      lastFailureKinds.set(retryKey, isRetry ? "retry" : "tool_failure");
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
      await handleHarnessEvent(
        {
          directory,
          global,
          project,
          client: refineClient,
          autoRefineEnabled: pluginOptions.autoRefineEnabled ?? AUTO_REFINE_ENABLED,
          minEvidence: pluginOptions.minEvidence ?? AUTO_REFINE_MIN_EVIDENCE,
          maxOps: AUTO_REFINE_MAX_OPS,
          cooldownMs: pluginOptions.cooldownMs ?? AUTO_REFINE_COOLDOWN_MS,
          model: pluginOptions.model,
        },
        event as HarnessEventLike,
      );
    },

    "experimental.chat.system.transform": async (_input, output) => {
      if (!output.system.some((s) => typeof s === "string" && s.includes("<harness-memories"))) {
        const injection = buildInjection(loadMergedState(global, project), "project");
        if (injection) output.system.push(injection);
      }
      if (!output.system.some((s) => typeof s === "string" && s.includes("<harness-continuation"))) {
        output.system.push(buildContinuationNudge());
      }
    },

    "experimental.session.compacting": async (_input, output) => {
      const hasMemories = output.context.some((c) => typeof c === "string" && c.includes("## Harness memories"));
      if (!hasMemories) {
        output.context.push(...buildCompactionContext(loadMergedState(global, project), "project"));
      }
    },

    tool: {
      harness_refine: tool({
        description: "Review recent harness evidence and the current session trajectory, then recommend evidence-backed refinements (memories, spec updates, or new skills/agents). Conservative: weak evidence means no change.",
        args: {
          focus: tool.schema.string().optional().describe("Optional focus area to filter evidence."),
        },
        async execute(args) {
          const focus = (args as { focus?: string }).focus;
          return `## Harness evidence (recent)\n${gatherEvidenceSummary(global, focus, directory)}\n\n## Current state\n${buildStateSummary(loadMergedState(global, project), "project")}\n\nAssess candidates on frequency, cost, risk, stability, and existing coverage. If a candidate scores strong (>=0.6), propose it via harness_apply with kind=memory|spec|delete (use specKind=skill|subagent|team for spec writes), scope=global for cross-project or scope=project for this repo, and the exact body. For team specs, use the fixed body shape (Pattern/Task type/Roles/Coordination/Use when) and consult the harness-refine skill's pattern reference. For new skills/agents/teams, only if repeated friction justifies it. IMPORTANT: before applying, run the full harness-refine workflow — dispatch the harness-redteam subagent to challenge your ops, then call harness_audit on the draft ops and fix any FAIL or addressed warnings. Otherwise report 'No change recommended'.`;
        },
      }),

      harness_audit: tool({
        description: "Validate proposed harness ops against ground truth before applying. Read-only; never writes or snapshots. Checks evidence grounding, body structure, name conflicts, scope consistency, and adversarial concerns (single-session evidence, contested evidence, high-confidence contradictions). Returns a PASS/FAIL verdict per op with reasons.",
        args: {
          ops: OPS_SCHEMA.describe("Refinement operations to validate."),
        },
        async execute(args) {
          const ops = (args as { ops: RefineOp[] }).ops;
          const verdicts = validateOps(global, project, ops);
          if (verdicts.length === 0) return "No ops to audit.";
          return verdicts.map((v) => {
            const parts = [`${v.pass ? "PASS" : "FAIL"} op#${v.index} ${v.op.op}:${v.op.kind}:${v.op.name}`];
            if (v.reasons.length) parts.push(`reasons: ${v.reasons.join("; ")}`);
            if (v.warnings.length) parts.push(`warnings: ${v.warnings.join("; ")}`);
            return parts.join(" | ");
          }).join("\n");
        },
      }),

      harness_apply: tool({
        description: "Apply concrete harness refinements. Snapshots state first; every write is rollback-able via harness_rollback.",
        args: {
          ops: OPS_SCHEMA.describe("Refinement operations to apply."),
        },
        async execute(args) {
          const ops = (args as { ops: RefineOp[] }).ops;
          const { snapshotID, applied, rejected, verified } = applyOps(global, project, ops);
          const lines = [`Applied ${applied.length} op(s). Snapshot: ${snapshotID}`];
          if (applied.length) lines.push(`Applied: ${applied.join(", ")}`);
          if (rejected.length) lines.push(`Rejected (${rejected.length}): ${rejected.map((r) => `${r.op} — ${r.reason}`).join("; ")}`);
          const failedVerify = verified.filter((v) => !v.ok);
          if (verified.length) lines.push(`Verified: ${verified.map((v) => `${v.kind}:${v.name}=${v.ok ? "ok" : "FAIL"}`).join(", ")}`);
          if (failedVerify.length) lines.push(`ROLLBACK: snapshot ${snapshotID} — ${failedVerify.map((v) => `${v.kind}:${v.name}`).join(", ")} did not write correctly`);
          return lines.join("\n");
        },
      }),

      harness_team: tool({
        description: "Fetch a stored team-architecture spec by name, or list all stored team specs.",
        args: {
          name: tool.schema.string().optional().describe("Team spec name to fetch."),
        },
        async execute(args) {
          const name = (args as { name?: string }).name;
          const state = loadMergedState(global, project);
          const teams = state.specs.filter((s) => s.kind === "team");
          if (name) {
            const hit = teams.find((t) => t.name === name);
            if (!hit) {
              return `No team spec named "${name}". Available teams:\n${teams.length ? teams.map((t) => `- ${t.name}`).join("\n") : "none"}`;
            }
            return `## Team: ${hit.name}\n${hit.body}`;
          }
          return teams.length ? teams.map((t) => `- ${t.name}: ${t.body}`).join("\n") : "No team specs stored yet.";
        },
      }),

      harness_status: tool({
        description: "Show the current harness state: memory/spec counts, evidence totals, and snapshots.",
        args: {},
        async execute() {
          const state = loadMergedState(global, project);
          const snapshots = listSnapshots(global);
          const refine = readRefineState(project);
          let update = "no check yet";
          try {
            if (fs.existsSync(updateStateFile)) {
              const u = JSON.parse(fs.readFileSync(updateStateFile, "utf8"));
              update = u.pendingRestart ? `update available (${u.latest}), restart opencode to load` : `up to date (checked ${u.checkedAt})`;
            }
          } catch { /* corrupt update-state.json */ }
          return `## Harness status\nglobal: ${global}\nproject: ${project}\nmemories: ${state.memories.length}\nspecs: ${state.specs.length}\nevidence entries: ${readEvidence(global).length}\nsnapshots: ${snapshots.length}\nlast auto-refine: ${refine.lastAutoRefineAt ?? "never"}\nupdates: ${update}`;
        },
      }),

      harness_history: tool({
        description: "List harness snapshot ids for rollback.",
        args: {},
        async execute() {
          const globalSnaps = listSnapshots(global);
          const projectSnaps = listSnapshots(project);
          const snaps = [...new Set([...globalSnaps, ...projectSnaps])];
          return snaps.length ? snaps.join("\n") : "No snapshots yet.";
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
            if (listSnapshots(project).includes(id)) rollback(project, id);
            return `Rolled back to snapshot ${id}`;
          } catch (e) {
            const avail = [...new Set([...listSnapshots(global), ...listSnapshots(project)])];
            return `Rollback failed: ${(e as Error).message}. Available: ${avail.join(", ") || "none"}`;
          }
        },
      }),
    },
  };
};
