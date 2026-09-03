import fs from "fs";
import path from "path";
import { readEvidence, type EvidenceEntry } from "./store";
import { ensureDir } from "./paths";

export const AUTO_REFINE_MIN_EVIDENCE = 5;
export const AUTO_REFINE_MAX_OPS = 3;
/** Minimum wall-clock gap between automatic refine runs (1 hour). */
export const AUTO_REFINE_COOLDOWN_MS = 60 * 60 * 1000;
/** Evidence kinds that count as real signal for triggering auto-refine. */
export const SIGNAL_KINDS = new Set(["tool_failure", "retry"]);

export type RefineState = {
  lastAutoRefineAt?: string;
  watermark?: string;
};

export function refineStateFile(dir: string): string {
  return path.join(dir, "refine-state.json");
}

export function readRefineState(dir: string): RefineState {
  const file = refineStateFile(dir);
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as RefineState;
  } catch {
    return {};
  }
}

export function writeRefineState(dir: string, state: RefineState): void {
  ensureDir(dir);
  fs.writeFileSync(refineStateFile(dir), JSON.stringify(state, null, 2), "utf8");
}

export function newEvidenceSince(rows: EvidenceEntry[], watermark: string | undefined): EvidenceEntry[] {
  if (!watermark) return rows;
  return rows.filter((r) => r.ts > watermark);
}

/** Filter to real-signal rows only (tool failures + retries), excluding harness lifecycle noise. */
export function signalEvidence(rows: EvidenceEntry[]): EvidenceEntry[] {
  return rows.filter((r) => SIGNAL_KINDS.has(r.kind));
}

export function isRefineDue(
  rows: EvidenceEntry[],
  state: RefineState,
  minNew = AUTO_REFINE_MIN_EVIDENCE,
  cooldownMs = AUTO_REFINE_COOLDOWN_MS,
): boolean {
  const fresh = signalEvidence(newEvidenceSince(rows, state.watermark));
  if (fresh.length < minNew) return false;
  if (state.lastAutoRefineAt) {
    const last = Date.parse(state.lastAutoRefineAt);
    if (!Number.isNaN(last) && Date.now() - last < cooldownMs) return false;
  }
  return true;
}

export type AutoRefineClient = {
  session: {
    create(opts: { query?: { directory?: string }; body?: { parentID?: string } }): Promise<{ id: string }>;
    promptAsync(opts: unknown): Promise<unknown>;
  };
};

export type ModelRef = { providerID: string; modelID: string };

/**
 * Split a model reference string ("provider/modelID") into provider + model.
 * opencode model ids may themselves contain slashes (e.g. "ds/deepseek-v4-flash"
 * under provider "omni-deepseek"), so the provider is everything before the
 * FIRST slash. A bare model id (no slash) yields providerID "" so callers can
 * decide whether to attach an explicit model to a session.
 */
export function parseModelRef(model: string | undefined): ModelRef | undefined {
  if (!model) return undefined;
  const idx = model.indexOf("/");
  if (idx <= 0) return { providerID: "", modelID: model };
  return { providerID: model.slice(0, idx), modelID: model.slice(idx + 1) };
}

const REFINE_PROMPT = `Run the harness refine workflow (load the \`harness-refine\` skill) and apply evidence-backed refinements. Be conservative: weak evidence means no change. Apply at most $MAX_OPS ops.`;

let refining = false;

export async function runAutoRefine(
  client: AutoRefineClient,
  directory: string,
  global: string,
  project: string,
  opts: { enabled?: boolean; minEvidence?: number; maxOps?: number; parentID?: string; model?: string; cooldownMs?: number } = {},
): Promise<boolean> {
  if (opts.enabled === false) return false;
  if (refining) return false;
  const state = readRefineState(project);
  if (state.lastAutoRefineAt) {
    const last = Date.parse(state.lastAutoRefineAt);
    if (!Number.isNaN(last) && Date.now() - last < (opts.cooldownMs ?? AUTO_REFINE_COOLDOWN_MS)) return false;
  }
  const rows = readEvidence(global).filter((r) => r.project === directory);
  if (!isRefineDue(rows, state, opts.minEvidence ?? AUTO_REFINE_MIN_EVIDENCE)) return false;
  refining = true;
  try {
    const session = await client.session.create({
      query: { directory },
      body: opts.parentID ? { parentID: opts.parentID } : undefined,
    });
    const ref = parseModelRef(opts.model);
    const body: Record<string, unknown> = {
      agent: "refiner",
      parts: [{ type: "text", text: REFINE_PROMPT.replace("$MAX_OPS", String(opts.maxOps ?? AUTO_REFINE_MAX_OPS)) }],
    };
    if (ref && ref.providerID) {
      body.model = { providerID: ref.providerID, modelID: ref.modelID };
    }
    await client.session.promptAsync({ path: { id: session.id }, body });
    const watermark = rows.reduce((max, r) => (r.ts > max ? r.ts : max), "");
    writeRefineState(project, { lastAutoRefineAt: new Date().toISOString(), watermark });
    return true;
  } catch {
    return false;
  } finally {
    refining = false;
  }
}
