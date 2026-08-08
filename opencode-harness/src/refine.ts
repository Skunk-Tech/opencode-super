import { readEvidence, loadState, writeMemory, writeSpec, deleteEntry, snapshot, type Memory, type Spec } from "./store";

export type RefineOp = {
  op: "memory" | "spec" | "delete";
  kind: "memory" | "spec";
  specKind?: "skill" | "subagent";
  name: string;
  scope: "global" | "project";
  body: string;
  confidence?: number;
  evidence?: string[];
};

export function gatherEvidenceSummary(dir: string, focus?: string): string {
  const rows = readEvidence(dir);
  const filtered = focus ? rows.filter((r) => (r.args ?? "").includes(focus) || (r.output ?? "").includes(focus)) : rows;
  const window = filtered.slice(-20);
  if (window.length === 0) return focus ? `No harness evidence matching "${focus}".` : "No harness evidence recorded yet.";
  const lines = window.map((r) => {
    const target = r.tool ? `${r.tool}${r.args ? ` "${r.args}"` : ""}` : r.sessionID;
    return `- [${r.kind}] ${r.ts} ${target}${r.output ? ` :: ${r.output}` : ""}`;
  });
  return lines.join("\n");
}

export function applyOps(dir: string, ops: RefineOp[]): { snapshotID: string; applied: string[] } {
  if (ops.length === 0) return { snapshotID: "", applied: [] };
  const snapshotID = snapshot(dir);
  const now = new Date().toISOString();
  const applied: string[] = [];
  const state = loadState(dir);
  for (const op of ops) {
    if (op.op === "delete") {
      deleteEntry(dir, op.kind, op.name);
      applied.push(`delete:${op.kind}:${op.name}`);
      continue;
    }
    if (op.kind === "memory") {
      const memory: Memory = {
        name: op.name,
        scope: op.scope,
        confidence: op.confidence ?? 0.5,
        created: state.memories.find((m) => m.name === op.name)?.created ?? now,
        updated: now,
        evidence: op.evidence ?? [],
        body: op.body,
      };
      writeMemory(dir, memory);
      applied.push(`memory:${op.name}`);
    } else {
      const spec: Spec = {
        name: op.name,
        kind: op.specKind ?? "skill",
        scope: op.scope,
        confidence: op.confidence ?? 0.5,
        updated: now,
        evidence: op.evidence ?? [],
        body: op.body,
      };
      writeSpec(dir, spec);
      applied.push(`spec:${op.name}`);
    }
  }
  return { snapshotID, applied };
}
