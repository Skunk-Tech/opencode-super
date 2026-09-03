import fs from "fs";
import path from "path";
import { ensureDir } from "./paths";

export const TRUNCATE_ARGS = 200;
export const TRUNCATE_OUTPUT = 500;
export const MAX_PER_SESSION = 25;

/** Kinds still written to evidence. Lifecycle kinds (premature_stop, session_created,
 *  session_idle) were removed as auto-refine fuel — see the token-burn fix. */
export const WRITABLE_KINDS = new Set(["tool_failure", "retry", "session_error"]);

export type EvidenceEntry = {
  ts: string;
  sessionID: string;
  kind: "tool_failure" | "retry" | "session_error" | "session_idle" | "session_created" | "premature_stop";
  tool?: string;
  args?: string;
  output?: string;
  project?: string;
  finish?: string;
};

function truncate(s: string | undefined, max: number): string | undefined {
  if (s === undefined) return undefined;
  return s.length <= max ? s : s.slice(0, max);
}

export function evidenceFile(dir: string): string {
  return path.join(dir, "evidence.jsonl");
}

export function appendEvidence(dir: string, entry: EvidenceEntry): void {
  // Defensive guard: lifecycle rows were the auto-refine feedback fuel (token-burn fix).
  // Only real signal may ever be persisted. Legacy rows already on disk still parse.
  if (!WRITABLE_KINDS.has(entry.kind)) return;
  ensureDir(dir);
  const file = evidenceFile(dir);
  const normalized: EvidenceEntry = {
    ...entry,
    args: truncate(entry.args, TRUNCATE_ARGS),
    output: truncate(entry.output, TRUNCATE_OUTPUT),
  };
  const rows = readEvidence(dir);
  const last = rows[rows.length - 1];
  if (last && last.sessionID === entry.sessionID && last.tool === entry.tool && last.args === normalized.args && last.output === normalized.output) {
    return;
  }
  const sessionRows = rows.filter((r) => r.sessionID === entry.sessionID);
  const rowsToKeep = sessionRows.length >= MAX_PER_SESSION ? rows.filter((r) => r.sessionID !== entry.sessionID).concat(sessionRows.slice(sessionRows.length - (MAX_PER_SESSION - 1))) : rows;
  const content = rowsToKeep.map((r) => JSON.stringify(r)).concat([JSON.stringify(normalized)]).join("\n") + "\n";
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, file);
}

export function readEvidence(dir: string): EvidenceEntry[] {
  const file = evidenceFile(dir);
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim().length > 0);
  const rows: EvidenceEntry[] = [];
  for (const line of lines) {
    try {
      rows.push(JSON.parse(line) as EvidenceEntry);
    } catch {
      // skip corrupt lines
    }
  }
  return rows;
}

export function evidenceCountForSession(dir: string, sessionID: string): number {
  return readEvidence(dir).filter((r) => r.sessionID === sessionID).length;
}

export type Memory = {
  name: string;
  scope: "global" | "project";
  confidence: number;
  created: string;
  updated: string;
  evidence: string[];
  body: string;
};

export type Spec = {
  name: string;
  kind: "skill" | "subagent" | "team";
  scope: "global" | "project";
  confidence: number;
  updated: string;
  evidence: string[];
  body: string;
};

export type HarnessState = {
  version: number;
  updated: string;
  memories: Memory[];
  specs: Spec[];
};

function writeFrontmatter(fields: Record<string, string>, body: string): string {
  const fm = Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join("\n");
  return `---\n${fm}\n---\n${body}`;
}

function parseFrontmatter(content: string): { fields: Record<string, string>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { fields: {}, body: content };
  const fields: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) fields[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return { fields, body: match[2] };
}

function entryPath(dir: string, kind: "memory" | "spec", name: string): string {
  return path.join(dir, kind === "memory" ? "memories" : "specs", `${name}.md`);
}

function listFiles(dir: string, sub: string): string[] {
  const full = path.join(dir, sub);
  if (!fs.existsSync(full)) return [];
  return fs.readdirSync(full).filter((f) => f.endsWith(".md")).map((f) => path.join(full, f));
}

export function writeMemory(dir: string, memory: Memory): void {
  ensureDir(dir);
  ensureDir(path.join(dir, "memories"));
  fs.writeFileSync(entryPath(dir, "memory", memory.name), writeFrontmatter(
    { name: memory.name, scope: memory.scope, confidence: String(memory.confidence), created: memory.created, updated: memory.updated, evidence: JSON.stringify(memory.evidence) },
    memory.body
  ), "utf8");
}

export function writeSpec(dir: string, spec: Spec): void {
  ensureDir(dir);
  ensureDir(path.join(dir, "specs"));
  fs.writeFileSync(entryPath(dir, "spec", spec.name), writeFrontmatter(
    { name: spec.name, kind: spec.kind, scope: spec.scope, confidence: String(spec.confidence), updated: spec.updated, evidence: JSON.stringify(spec.evidence) },
    spec.body
  ), "utf8");
}

function parseEvidence(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((e): e is string => typeof e === "string") : [];
  } catch {
    return [];
  }
}

export function listMemories(dir: string): Memory[] {
  return listFiles(dir, "memories").map((f) => {
    const { fields, body } = parseFrontmatter(fs.readFileSync(f, "utf8"));
    return {
      name: fields.name ?? path.basename(f, ".md"),
      scope: (fields.scope === "project" ? "project" : "global") as "global" | "project",
      confidence: Number(fields.confidence ?? 0.5),
      created: fields.created ?? "",
      updated: fields.updated ?? "",
      evidence: parseEvidence(fields.evidence),
      body: body.trim(),
    };
  });
}

export function listSpecs(dir: string): Spec[] {
  return listFiles(dir, "specs").map((f) => {
    const { fields, body } = parseFrontmatter(fs.readFileSync(f, "utf8"));
    return {
      name: fields.name ?? path.basename(f, ".md"),
      kind: (fields.kind === "subagent" ? "subagent" : fields.kind === "team" ? "team" : "skill") as "skill" | "subagent" | "team",
      scope: (fields.scope === "project" ? "project" : "global") as "global" | "project",
      confidence: Number(fields.confidence ?? 0.5),
      updated: fields.updated ?? "",
      evidence: parseEvidence(fields.evidence),
      body: body.trim(),
    };
  });
}

export function deleteEntry(dir: string, kind: "memory" | "spec", name: string): void {
  const file = entryPath(dir, kind, name);
  if (fs.existsSync(file)) fs.rmSync(file);
}

export function loadState(dir: string): HarnessState {
  return {
    version: 1,
    updated: new Date().toISOString(),
    memories: listMemories(dir),
    specs: listSpecs(dir),
  };
}

export function loadMergedState(global: string, project?: string): HarnessState {
  const globalState = loadState(global);
  if (!project) return globalState;
  const projectState = loadState(project);
  return {
    version: 1,
    updated: new Date().toISOString(),
    memories: [...globalState.memories.filter((m) => m.scope === "global"), ...projectState.memories],
    specs: [...globalState.specs.filter((s) => s.scope === "global"), ...projectState.specs],
  };
}

function reflectionsDir(dir: string): string {
  return path.join(dir, "reflections");
}

export function snapshot(dir: string, id?: string): string {
  const snapshotID = id ?? new Date().toISOString().replace(/[:.]/g, "-");
  const dest = path.join(reflectionsDir(dir), snapshotID);
  ensureDir(dest);
  for (const [sub, kind] of [["memories", "memory"], ["specs", "spec"]] as const) {
    for (const f of listFiles(dir, sub)) {
      ensureDir(path.join(dest, sub));
      fs.copyFileSync(f, path.join(dest, sub, path.basename(f)));
    }
  }
  return snapshotID;
}

export function listSnapshots(dir: string): string[] {
  const full = reflectionsDir(dir);
  if (!fs.existsSync(full)) return [];
  return fs.readdirSync(full).sort();
}

export function rollback(dir: string, id: string): void {
  const src = path.join(reflectionsDir(dir), id);
  if (!fs.existsSync(src)) throw new Error(`Snapshot not found: ${id}`);
  for (const [sub] of [["memories"], ["specs"]] as const) {
    const srcSub = path.join(src, sub);
    const destSub = path.join(dir, sub);
    ensureDir(destSub);
    for (const f of fs.readdirSync(destSub)) {
      fs.rmSync(path.join(destSub, f));
    }
    if (!fs.existsSync(srcSub)) continue;
    for (const f of fs.readdirSync(srcSub)) {
      fs.copyFileSync(path.join(srcSub, f), path.join(destSub, f));
    }
  }
}
