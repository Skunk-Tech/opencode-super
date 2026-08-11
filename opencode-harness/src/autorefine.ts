import fs from "fs";
import path from "path";
import { readEvidence, type EvidenceEntry } from "./store";
import { ensureDir } from "./paths";

export const AUTO_REFINE_MIN_EVIDENCE = 5;
export const AUTO_REFINE_MAX_OPS = 3;

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

export function isRefineDue(rows: EvidenceEntry[], state: RefineState, minNew = AUTO_REFINE_MIN_EVIDENCE): boolean {
  return newEvidenceSince(rows, state.watermark).length >= minNew;
}

export type AutoRefineClient = {
  session: {
    create(opts: { query?: { directory?: string } }): Promise<{ id: string }>;
    promptAsync(opts: unknown): Promise<unknown>;
  };
};

const REFINE_PROMPT = `Run the harness refine workflow (load the \`harness-refine\` skill) and apply evidence-backed refinements. Be conservative: weak evidence means no change. Apply at most $MAX_OPS ops.`;

let refining = false;

export async function runAutoRefine(
  client: AutoRefineClient,
  directory: string,
  global: string,
  project: string,
  opts: { enabled?: boolean; minEvidence?: number; maxOps?: number } = {},
): Promise<boolean> {
  if (opts.enabled === false) return false;
  if (refining) return false;
  const state = readRefineState(project);
  const rows = readEvidence(global).filter((r) => r.project === directory);
  if (!isRefineDue(rows, state, opts.minEvidence ?? AUTO_REFINE_MIN_EVIDENCE)) return false;
  refining = true;
  try {
    const session = await client.session.create({ query: { directory } });
    await client.session.promptAsync({
      path: { id: session.id },
      body: {
        agent: "refiner",
        parts: [{ type: "text", text: REFINE_PROMPT.replace("$MAX_OPS", String(opts.maxOps ?? AUTO_REFINE_MAX_OPS)) }],
      },
    });
    const watermark = rows.reduce((max, r) => (r.ts > max ? r.ts : max), "");
    writeRefineState(project, { lastAutoRefineAt: new Date().toISOString(), watermark });
    return true;
  } catch {
    return false;
  } finally {
    refining = false;
  }
}
