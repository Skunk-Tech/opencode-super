import fs from "fs";
import path from "path";
import { readEvidence, loadState, loadMergedState, writeMemory, writeSpec, deleteEntry, snapshot, listMemories, listSpecs, type Memory, type Spec, type EvidenceEntry } from "./store";

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

export type RejectedOp = { op: string; reason: string };
export type VerifiedWrite = { name: string; kind: "memory" | "spec"; ok: boolean };
export type ApplyResult = { snapshotID: string; applied: string[]; rejected: RejectedOp[]; verified: VerifiedWrite[] };

export function applyOps(global: string, project: string, ops: RefineOp[]): ApplyResult {
  if (ops.length === 0) return { snapshotID: "", applied: [], rejected: [], verified: [] };
  const verdicts = validateOps(global, project, ops);
  const now = new Date().toISOString();
  const applied: string[] = [];
  const rejected: RejectedOp[] = [];
  const verified: VerifiedWrite[] = [];
  const validOps = ops.filter((_, index) => {
    const verdict = verdicts.find((v) => v.index === index);
    if (verdict && verdict.reasons.length > 0) {
      rejected.push({ op: `${verdict.op.op}:${verdict.op.kind}:${verdict.op.name}`, reason: verdict.reasons.join("; ") });
      return false;
    }
    return true;
  });
  const globalState = loadState(global);
  const projectState = loadState(project);
  const touchesProject = validOps.some((op) => op.scope === "project");
  const snapshotID = snapshot(global);
  if (touchesProject) snapshot(project, snapshotID);
  if (validOps.length === 0) {
    return { snapshotID, applied: [], rejected, verified: [] };
  }
  for (const op of validOps) {
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
  for (const op of validOps) {
    const dir = op.scope === "project" ? project : global;
    if (op.op === "delete") {
      const stillThere = op.kind === "memory"
        ? fs.existsSync(path.join(dir, "memories", `${op.name}.md`))
        : fs.existsSync(path.join(dir, "specs", `${op.name}.md`));
      verified.push({ name: op.name, kind: op.kind, ok: !stillThere });
      continue;
    }
    const found = op.kind === "memory"
      ? listMemories(dir).find((m) => m.name === op.name && m.body.trim() === (op.body ?? "").trim())
      : listSpecs(dir).find((s) => s.name === op.name && s.body.trim() === (op.body ?? "").trim());
    verified.push({ name: op.name, kind: op.kind, ok: Boolean(found) });
  }
  return { snapshotID, applied, rejected, verified };
}

export type OpVerdict = {
  index: number;
  op: RefineOp;
  name: string;
  pass: boolean;
  reasons: string[];
  warnings: string[];
};

export function evidenceRefMatches(row: EvidenceEntry, ref: string): boolean {
  const trimmed = ref.trim();
  if (!trimmed) return false;
  const exact = `${row.ts} ${row.kind}${row.tool ? ` ${row.tool}` : ""}`;
  if (trimmed === exact) return true;
  if (trimmed === row.ts) return true;
  if (trimmed === row.kind) return true;
  if (row.tool && trimmed === row.tool) return true;
  return exact.includes(trimmed);
}

const TEAM_FIELDS = ["Pattern:", "Task type:", "Roles:", "Coordination:", "Use when:"];

export function validateOps(global: string, project: string, ops: RefineOp[]): OpVerdict[] {
  const evidence = readEvidence(global);
  const globalState = loadState(global);
  const projectState = loadState(project);

  return ops.map((op, index) => {
    const name = op.name;
    const reasons: string[] = [];
    const warnings: string[] = [];
    const targetScopeDir = op.scope === "project" ? project : global;
    const existing =
      op.scope === "project"
        ? projectState.memories.concat(projectState.specs as unknown as Memory[])
        : globalState.memories.concat(globalState.specs as unknown as Memory[]);
    const existingHit = existing.find((m) => (m as { name: string }).name === name);

    // specKind only valid on spec ops
    if (op.kind === "memory" && (op as { specKind?: string }).specKind) {
      reasons.push(`specKind is only valid on spec ops (op#${index} memory:${name})`);
    }

    // body structure
    const body = (op.body ?? "").trim();
    if (op.op !== "delete" && !body) reasons.push(`empty body for ${op.kind}:${name}`);
    if (op.kind === "spec" && (op as { specKind?: string }).specKind === "team") {
      for (const field of TEAM_FIELDS) {
        if (!body.includes(field)) reasons.push(`team spec missing "${field}" field`);
      }
    }

    // evidence grounding
    const refs = op.evidence ?? [];
    if (refs.length === 0) {
      warnings.push("no evidence refs; confidence is the only guard");
    } else {
      const unmatched = refs.filter((r) => !evidence.some((row) => evidenceRefMatches(row, r)));
      if (unmatched.length > 0) reasons.push(`unmatched evidence refs: ${unmatched.join(", ")}`);
      const matchedRows = evidence.filter((row) => refs.some((r) => evidenceRefMatches(row, r)));
      const sessions = new Set(matchedRows.map((r) => r.sessionID));
      if (sessions.size === 1 && matchedRows.length > 0) {
        warnings.push("evidence rests on a single session; lower confidence or gather more before promoting");
      }
      for (const row of matchedRows) {
        const contested = evidence.some((other) =>
          other.project === row.project &&
          other.tool === row.tool &&
          other.ts > row.ts &&
          other.kind === "retry"
        );
        if (contested) {
          warnings.push(`contested: a later retry exists for tool ${row.tool ?? "?"}; acknowledge counter-evidence`);
          break;
        }
      }
    }

    // name conflict / high-confidence contradiction (delete exempt)
    if (op.op !== "delete" && existingHit) {
      const existingBody = (existingHit as { body: string }).body;
      if (existingBody === body) {
        // idempotent rewrite
      } else if ((existingHit as { confidence: number }).confidence >= 0.7) {
        reasons.push(`conflict: overwrites a high-confidence (${(existingHit as { confidence: number }).confidence}) existing ${(existingHit as { kind?: string }).kind ?? "memory"}:${name} with a different body`);
      } else {
        reasons.push(`conflict: ${name} already exists with a different body`);
      }
    }

    // scope consistency
    if (op.scope === "global") {
      const projectDup = projectState.memories.concat(projectState.specs as unknown as Memory[]).find((m) => (m as { name: string }).name === name);
      if (projectDup && (projectDup as { body: string }).body !== body) {
        reasons.push(`global op would shadow a project ${(projectDup as { kind?: string }).kind ?? "memory"}:${name} with a different body`);
      }
    }

    // confidence range
    if (op.confidence !== undefined && (op.confidence < 0 || op.confidence > 1)) {
      warnings.push(`confidence ${op.confidence} outside 0..1`);
    }

    // delete: missing target is a warning
    if (op.op === "delete" && !existingHit) {
      warnings.push(`delete target ${name} does not exist in ${op.scope} scope`);
    }

    return { index, op, name, pass: reasons.length === 0, reasons, warnings };
  });
}
