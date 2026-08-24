import { expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import { applyOps, gatherEvidenceSummary, validateOps, evidenceRefMatches } from "../src/refine";
import { appendEvidence, writeMemory, listMemories, listSnapshots, listSpecs, type EvidenceEntry } from "../src/store";
import { tmpDir } from "./helpers";

function twoDirs(): { global: string; project: string; cleanup: () => void } {
  const a = tmpDir();
  const b = tmpDir();
  return { global: a.dir, project: b.dir, cleanup: () => { a.cleanup(); b.cleanup(); } };
}

test("applyOps snapshots then writes global-scope memories to global dir", () => {
  const { global, project, cleanup } = twoDirs();
  try {
    const result = applyOps(global, project, [{ op: "memory", kind: "memory", name: "m1", scope: "global", body: "Use --no-verify.", confidence: 0.7, evidence: [] }]);
    expect(result.applied).toEqual(["memory:m1"]);
    expect(listSnapshots(global).length).toBe(1);
    expect(listMemories(global).length).toBe(1);
    expect(listMemories(project).length).toBe(0);
    expect(listMemories(global)[0].body).toContain("--no-verify");
  } finally { cleanup(); }
});

test("applyOps routes project-scope memories to the project dir", () => {
  const { global, project, cleanup } = twoDirs();
  try {
    const result = applyOps(global, project, [{ op: "memory", kind: "memory", name: "p1", scope: "project", body: "This repo uses bun test.", confidence: 0.8, evidence: [] }]);
    expect(result.applied).toEqual(["memory:p1"]);
    expect(listMemories(global).length).toBe(0);
    expect(listMemories(project).length).toBe(1);
    expect(listMemories(project)[0].body).toContain("bun test");
  } finally { cleanup(); }
});

test("applyOps mixed-scope ops snapshot both dirs under one id", () => {
  const { global, project, cleanup } = twoDirs();
  try {
    const result = applyOps(global, project, [
      { op: "memory", kind: "memory", name: "g1", scope: "global", body: "global mem", confidence: 0.6, evidence: [] },
      { op: "memory", kind: "memory", name: "p1", scope: "project", body: "project mem", confidence: 0.6, evidence: [] },
    ]);
    expect(result.applied.length).toBe(2);
    expect(listSnapshots(global)).toContain(result.snapshotID);
    expect(listSnapshots(project)).toContain(result.snapshotID);
  } finally { cleanup(); }
});

test("applyOps delete op removes entry from the right dir", () => {
  const { global, project, cleanup } = twoDirs();
  try {
    writeMemory(global, { name: "g1", scope: "global", confidence: 0.7, created: "t", updated: "t", evidence: [], body: "x" });
    writeMemory(project, { name: "p1", scope: "project", confidence: 0.7, created: "t", updated: "t", evidence: [], body: "y" });
    const result = applyOps(global, project, [{ op: "delete", kind: "memory", name: "p1", scope: "project", body: "" }]);
    expect(result.applied).toEqual(["delete:memory:p1"]);
    expect(listMemories(project).length).toBe(0);
    expect(listMemories(global).length).toBe(1);
  } finally { cleanup(); }
});

test("applyOps writes a subagent spec when specKind is subagent", () => {
  const { global, project, cleanup } = twoDirs();
  try {
    const result = applyOps(global, project, [{ op: "spec", kind: "spec", specKind: "subagent", name: "code-rev", scope: "global", body: "Review pass spec.", confidence: 0.6, evidence: [] }]);
    expect(result.applied).toEqual(["spec:code-rev"]);
    const specs = listSpecs(global);
    expect(specs.length).toBe(1);
    expect(specs[0].kind).toBe("subagent");
  } finally { cleanup(); }
});

test("applyOps with empty ops creates no snapshot", () => {
  const { global, project, cleanup } = twoDirs();
  try {
    const result = applyOps(global, project, []);
    expect(result.snapshotID).toBe("");
    expect(result.applied).toEqual([]);
    expect(listSnapshots(global).length).toBe(0);
  } finally { cleanup(); }
});

test("gatherEvidenceSummary renders recent evidence", () => {
  const { dir, cleanup } = tmpDir();
  try {
    appendEvidence(dir, { ts: "2026-08-05T00:00:00.000Z", sessionID: "s1", kind: "tool_failure", tool: "bash", args: "npm run build", output: "Error" });
    const summary = gatherEvidenceSummary(dir);
    expect(summary).toContain("tool_failure");
    expect(summary).toContain("npm run build");
  } finally { cleanup(); }
});

test("gatherEvidenceSummary with focus finds older matching evidence beyond the last 20", () => {
  const { dir, cleanup } = tmpDir();
  try {
    for (let i = 0; i < 25; i++) {
      const output = i === 2 ? "err 2 old-marker-match" : `err ${i}`;
      appendEvidence(dir, { ts: `2026-08-05T00:00:00.00${i}Z`, sessionID: "s1", kind: "tool_failure", tool: "bash", args: `cmd ${i}`, output });
    }
    const summary = gatherEvidenceSummary(dir, "old-marker-match");
    expect(summary).toContain("old-marker-match");
  } finally { cleanup(); }
});

test("gatherEvidenceSummary with project filter excludes other projects", () => {
  const { dir, cleanup } = tmpDir();
  try {
    appendEvidence(dir, { ts: "2026-08-05T00:00:00.000Z", sessionID: "s1", kind: "tool_failure", tool: "bash", args: "a", output: "mine", project: "/work/a" });
    appendEvidence(dir, { ts: "2026-08-05T00:00:01.000Z", sessionID: "s2", kind: "tool_failure", tool: "bash", args: "b", output: "other", project: "/work/b" });
    const mine = gatherEvidenceSummary(dir, undefined, "/work/a");
    expect(mine).toContain("mine");
    expect(mine).not.toContain("other");
  } finally { cleanup(); }
});

function seedEvidence(dir: string, rows: EvidenceEntry[]): void {
  fs.writeFileSync(path.join(dir, "evidence.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}

const evidenceRow = (ts: string, project = "/work"): EvidenceEntry => ({
  ts, sessionID: "s1", kind: "tool_failure", tool: "bash", project,
});

function memoryOp(over: Partial<{ name: string; scope: "global" | "project"; body: string; evidence: string[]; confidence: number }> = {}) {
  return {
    op: "memory" as const,
    kind: "memory" as const,
    name: over.name ?? "lesson",
    scope: (over.scope ?? "project") as "global" | "project",
    body: over.body ?? "Use the documented pattern.",
    evidence: over.evidence ?? ["2026-01-01T00:00:00.000Z"],
    confidence: over.confidence ?? 0.7,
  };
}

function teamSpecOp(over: Partial<{ body: string; scope: "global" | "project" }> = {}) {
  return {
    op: "spec" as const,
    kind: "spec" as const,
    specKind: "team" as const,
    name: "doc-team",
    scope: (over.scope ?? "project") as "global" | "project",
    body: over.body ?? "Pattern: pipeline\nTask type: docs\nRoles: writer, reviewer\nCoordination: writer then reviewer\nUse when: repeated doc rewrites",
  };
}

test("validateOps passes a well-grounded project memory", () => {
  const { dir: global, cleanup } = tmpDir();
  try {
    seedEvidence(global, [evidenceRow("2026-01-01T00:00:00.000Z")]);
    const project = global;
    const verdicts = validateOps(global, project, [memoryOp()]);
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0].pass).toBe(true);
  } finally { cleanup(); }
});

test("validateOps rejects unmatched evidence refs", () => {
  const { dir: global, cleanup } = tmpDir();
  try {
    seedEvidence(global, [evidenceRow("2026-01-01T00:00:00.000Z")]);
    const project = global;
    const verdicts = validateOps(global, project, [memoryOp({ evidence: ["1999-12-31T00:00:00.000Z"] })]);
    expect(verdicts[0].pass).toBe(false);
    expect(verdicts[0].reasons.join(" ")).toContain("1999-12-31T00:00:00.000Z");
  } finally { cleanup(); }
});

test("validateOps warns (not fails) on empty evidence", () => {
  const { dir: global, cleanup } = tmpDir();
  try {
    const verdicts = validateOps(global, global, [memoryOp({ evidence: [] })]);
    expect(verdicts[0].pass).toBe(true);
    expect(verdicts[0].warnings.length).toBeGreaterThan(0);
  } finally { cleanup(); }
});

test("validateOps rejects a team spec missing a fixed-shape field", () => {
  const { dir: global, cleanup } = tmpDir();
  try {
    seedEvidence(global, [evidenceRow("2026-01-01T00:00:00.000Z")]);
    const verdicts = validateOps(global, global, [teamSpecOp({ body: "Pattern: pipeline\nTask type: docs\nRoles: writer\nCoordination: writer then reviewer" })]);
    expect(verdicts[0].pass).toBe(false);
    expect(verdicts[0].reasons.join(" ")).toContain("Use when");
  } finally { cleanup(); }
});

test("validateOps rejects an empty memory body", () => {
  const { dir: global, cleanup } = tmpDir();
  try {
    seedEvidence(global, [evidenceRow("2026-01-01T00:00:00.000Z")]);
    const verdicts = validateOps(global, global, [memoryOp({ body: "  " })]);
    expect(verdicts[0].pass).toBe(false);
  } finally { cleanup(); }
});

test("validateOps flags a name conflict with a different body", () => {
  const { dir: global, cleanup } = tmpDir();
  try {
    seedEvidence(global, [evidenceRow("2026-01-01T00:00:00.000Z")]);
    writeMemory(global, { name: "lesson", scope: "global", confidence: 0.5, created: "2026-01-01", updated: "2026-01-01", evidence: [], body: "The ORIGINAL trusted body." });
    const verdicts = validateOps(global, global, [memoryOp({ body: "A DIFFERENT body." })]);
    expect(verdicts[0].pass).toBe(false);
    expect(verdicts[0].reasons.join(" ")).toContain("conflict");
  } finally { cleanup(); }
});

test("validateOps treats an identical-body rewrite as idempotent pass", () => {
  const { dir: global, cleanup } = tmpDir();
  try {
    seedEvidence(global, [evidenceRow("2026-01-01T00:00:00.000Z")]);
    writeMemory(global, { name: "lesson", scope: "global", confidence: 0.5, created: "2026-01-01", updated: "2026-01-01", evidence: [], body: "Use the documented pattern." });
    const verdicts = validateOps(global, global, [memoryOp()]);
    expect(verdicts[0].pass).toBe(true);
  } finally { cleanup(); }
});

test("validateOps rejects a global op that duplicates a project memory with different body", () => {
  const { global, project, cleanup } = twoDirs();
  try {
    seedEvidence(global, [evidenceRow("2026-01-01T00:00:00.000Z")]);
    writeMemory(project, { name: "lesson", scope: "project", confidence: 0.5, created: "2026-01-01", updated: "2026-01-01", evidence: [], body: "Project-specific truth." });
    const verdicts = validateOps(global, project, [memoryOp({ scope: "global", body: "Global version." })]);
    expect(verdicts[0].pass).toBe(false);
  } finally { cleanup(); }
});

test("validateOps rejects specKind on a memory op", () => {
  const { dir: global, cleanup } = tmpDir();
  try {
    seedEvidence(global, [evidenceRow("2026-01-01T00:00:00.000Z")]);
    const verdicts = validateOps(global, global, [{ op: "memory", kind: "memory", specKind: "team", name: "lesson", scope: "global", body: "Body", evidence: ["2026-01-01T00:00:00.000Z"] }]);
    expect(verdicts[0].pass).toBe(false);
  } finally { cleanup(); }
});

test("validateOps warns on out-of-range confidence", () => {
  const { dir: global, cleanup } = tmpDir();
  try {
    seedEvidence(global, [evidenceRow("2026-01-01T00:00:00.000Z")]);
    const verdicts = validateOps(global, global, [memoryOp({ confidence: 1.5 })]);
    expect(verdicts[0].warnings.length).toBeGreaterThan(0);
  } finally { cleanup(); }
});

test("validateOps flags single-session evidence as over-generalization", () => {
  const { dir: global, cleanup } = tmpDir();
  try {
    seedEvidence(global, [
      { ts: "2026-01-01T00:00:00.000Z", sessionID: "s1", kind: "tool_failure", tool: "bash", project: "/work" },
      { ts: "2026-01-02T00:00:00.000Z", sessionID: "s1", kind: "tool_failure", tool: "grep", project: "/work" },
    ]);
    const verdicts = validateOps(global, global, [memoryOp({ evidence: ["2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z"] })]);
    expect(verdicts[0].warnings.join(" ")).toContain("single session");
  } finally { cleanup(); }
});

test("validateOps flags contested evidence (later retry for the same tool)", () => {
  const { dir: global, cleanup } = tmpDir();
  try {
    seedEvidence(global, [
      { ts: "2026-01-01T00:00:00.000Z", sessionID: "s1", kind: "tool_failure", tool: "bash", project: "/work" },
      { ts: "2026-01-03T00:00:00.000Z", sessionID: "s1", kind: "retry", tool: "bash", project: "/work" },
    ]);
    const verdicts = validateOps(global, global, [memoryOp({ evidence: ["2026-01-01T00:00:00.000Z"] })]);
    expect(verdicts[0].warnings.join(" ")).toContain("contested");
  } finally { cleanup(); }
});

test("validateOps rejects overwriting a high-confidence memory with a different body", () => {
  const { dir: global, cleanup } = tmpDir();
  try {
    seedEvidence(global, [evidenceRow("2026-01-01T00:00:00.000Z")]);
    writeMemory(global, { name: "lesson", scope: "global", confidence: 0.85, created: "2026-01-01", updated: "2026-01-01", evidence: [], body: "Trusted global truth." });
    const verdicts = validateOps(global, global, [memoryOp({ scope: "global", body: "New untrusted claim." })]);
    expect(verdicts[0].pass).toBe(false);
  } finally { cleanup(); }
});

test("validateOps validates delete ops (missing target is a warning, not failure)", () => {
  const { dir: global, cleanup } = tmpDir();
  try {
    seedEvidence(global, [evidenceRow("2026-01-01T00:00:00.000Z")]);
    const verdicts = validateOps(global, global, [{ op: "delete", kind: "memory", name: "does-not-exist", scope: "global", body: "" }]);
    expect(verdicts[0].pass).toBe(true);
    expect(verdicts[0].warnings.length).toBeGreaterThan(0);
  } finally { cleanup(); }
});

test("validateOps returns empty array for empty ops", () => {
  const { dir: global, cleanup } = tmpDir();
  try {
    expect(validateOps(global, global, [])).toEqual([]);
  } finally { cleanup(); }
});

test("evidenceRefMatches: exact triple, bare ts, bare kind/tool, and substring", () => {
  const row = evidenceRow("2026-01-01T00:00:00.000Z");
  expect(evidenceRefMatches(row, "2026-01-01T00:00:00.000Z tool_failure bash")).toBe(true);
  expect(evidenceRefMatches(row, "2026-01-01T00:00:00.000Z")).toBe(true);
  expect(evidenceRefMatches(row, "tool_failure")).toBe(true);
  expect(evidenceRefMatches(row, "bash")).toBe(true);
  expect(evidenceRefMatches(row, "nope")).toBe(false);
});

test("applyOps rejects failing ops and applies the valid subset", () => {
  const { dir: global, cleanup } = tmpDir();
  try {
    seedEvidence(global, [evidenceRow("2026-01-01T00:00:00.000Z")]);
    const project = global;
    const result = applyOps(global, project, [
      memoryOp(),
      memoryOp({ name: "bad", evidence: ["1999-12-31T00:00:00.000Z"] }),
    ]);
    expect(result.applied).toContain("memory:lesson");
    expect(result.applied.some((a) => a.includes("bad"))).toBe(false);
    expect(result.rejected.length).toBe(1);
    expect(result.rejected[0].op).toContain("bad");
    expect(result.snapshotID.length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(global, "memories", "lesson.md"))).toBe(true);
    expect(fs.existsSync(path.join(global, "memories", "bad.md"))).toBe(false);
  } finally { cleanup(); }
});

test("applyOps read-back verifies applied writes", () => {
  const { dir: global, cleanup } = tmpDir();
  try {
    seedEvidence(global, [evidenceRow("2026-01-01T00:00:00.000Z")]);
    const project = global;
    const result = applyOps(global, project, [memoryOp()]);
    expect(result.verified.length).toBe(1);
    expect(result.verified[0].ok).toBe(true);
    expect(result.verified[0].name).toBe("lesson");
  } finally { cleanup(); }
});

test("applyOps returns snapshot id even when all ops are rejected", () => {
  const { dir: global, cleanup } = tmpDir();
  try {
    seedEvidence(global, [evidenceRow("2026-01-01T00:00:00.000Z")]);
    const project = global;
    const result = applyOps(global, project, [memoryOp({ evidence: ["1999-12-31T00:00:00.000Z"] })]);
    expect(result.applied).toEqual([]);
    expect(result.rejected.length).toBe(1);
    expect(result.snapshotID.length).toBeGreaterThan(0);
  } finally { cleanup(); }
});

test("applyOps delete op verified (file gone after apply)", () => {
  const { dir: global, cleanup } = tmpDir();
  try {
    seedEvidence(global, [evidenceRow("2026-01-01T00:00:00.000Z")]);
    const project = global;
    writeMemory(project, { name: "lesson", scope: "global", confidence: 0.7, created: "2026-01-01", updated: "2026-01-01", evidence: [], body: "Doomed." });
    const result = applyOps(global, project, [{ op: "delete", kind: "memory", name: "lesson", scope: "project", body: "" }]);
    expect(result.applied).toContain("delete:memory:lesson");
    expect(fs.existsSync(path.join(project, "memories", "lesson.md"))).toBe(false);
  } finally { cleanup(); }
});

test("applyOps empty ops array returns empty result with empty snapshotID", () => {
  const { dir: global, cleanup } = tmpDir();
  try {
    const project = global;
    const result = applyOps(global, project, []);
    expect(result.applied).toEqual([]);
    expect(result.rejected).toEqual([]);
    expect(result.verified).toEqual([]);
  } finally { cleanup(); }
});
