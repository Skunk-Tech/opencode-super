import { readEvidence, loadState, loadMergedState, writeMemory, writeSpec, deleteEntry, snapshot, type Memory, type Spec } from "./store";

export type RefineOp = {
  op: "memory" | "spec" | "delete";
  kind: "memory" | "spec";
  specKind?: "skill" | "subagent" | "team";
  name: string;
  scope: "global" | "project";
  body: string;
  confidence?: number;
  evidence?: string[];
};

export function gatherEvidenceSummary(dir: string, focus?: string, project?: string): string {
  const rows = readEvidence(dir);
  const scoped = project ? rows.filter((r) => r.project === project) : rows;
  const filtered = focus ? scoped.filter((r) => (r.args ?? "").includes(focus) || (r.output ?? "").includes(focus)) : scoped;
  const window = filtered.slice(-20);
  if (window.length === 0) return focus ? `No harness evidence matching "${focus}".` : "No harness evidence recorded yet.";
  const lines = window.map((r) => {
    const target = r.tool ? `${r.tool}${r.args ? ` "${r.args}"` : ""}` : r.sessionID;
    return `- [${r.kind}] ${r.ts} ${target}${r.output ? ` :: ${r.output}` : ""}`;
  });
  return lines.join("\n");
}

export function applyOps(global: string, project: string, ops: RefineOp[]): { snapshotID: string; applied: string[] } {
  if (ops.length === 0) return { snapshotID: "", applied: [] };
  const now = new Date().toISOString();
  const applied: string[] = [];
  const globalState = loadState(global);
  const projectState = loadState(project);
  const touchesProject = ops.some((op) => op.scope === "project");
  const snapshotID = snapshot(global);
  if (touchesProject) snapshot(project, snapshotID);
  for (const op of ops) {
    const dir = op.scope === "project" ? project : global;
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
        created: (op.scope === "project" ? projectState : globalState).memories.find((m) => m.name === op.name)?.created ?? now,
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
