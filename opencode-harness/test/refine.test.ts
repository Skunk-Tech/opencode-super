import { expect, test } from "bun:test";
import { applyOps, gatherEvidenceSummary } from "../src/refine";
import { appendEvidence, writeMemory, listMemories, listSnapshots, listSpecs } from "../src/store";
import { tmpDir } from "./helpers";

function twoDirs(): { global: string; project: string; cleanup: () => void } {
  const a = tmpDir();
  const b = tmpDir();
  return { global: a.dir, project: b.dir, cleanup: () => { a.cleanup(); b.cleanup(); } };
}

test("applyOps snapshots then writes global-scope memories to global dir", () => {
  const { global, project, cleanup } = twoDirs();
  try {
    const result = applyOps(global, project, [{ op: "memory", kind: "memory", name: "m1", scope: "global", body: "Use --no-verify.", confidence: 0.7, evidence: ["e1"] }]);
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
    const result = applyOps(global, project, [{ op: "memory", kind: "memory", name: "p1", scope: "project", body: "This repo uses bun test.", confidence: 0.8, evidence: ["e2"] }]);
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
    const result = applyOps(global, project, [{ op: "spec", kind: "spec", specKind: "subagent", name: "code-rev", scope: "global", body: "Review pass spec.", confidence: 0.6, evidence: ["e2"] }]);
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
