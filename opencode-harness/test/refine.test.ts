import { expect, test } from "bun:test";
import { applyOps, gatherEvidenceSummary } from "../src/refine";
import { appendEvidence, writeMemory, listMemories, listSnapshots, listSpecs } from "../src/store";
import { tmpDir } from "./helpers";

test("applyOps snapshots then writes memories", () => {
  const { dir, cleanup } = tmpDir();
  try {
    const result = applyOps(dir, [{ op: "memory", kind: "memory", name: "m1", scope: "project", body: "Use --no-verify.", confidence: 0.7, evidence: ["e1"] }]);
    expect(result.applied).toEqual(["memory:m1"]);
    expect(listSnapshots(dir).length).toBe(1);
    expect(listMemories(dir).length).toBe(1);
    expect(listMemories(dir)[0].body).toContain("--no-verify");
  } finally { cleanup(); }
});

test("applyOps delete op removes entry", () => {
  const { dir, cleanup } = tmpDir();
  try {
    writeMemory(dir, { name: "m1", scope: "global", confidence: 0.7, created: "t", updated: "t", evidence: [], body: "x" });
    const result = applyOps(dir, [{ op: "delete", kind: "memory", name: "m1", scope: "global", body: "" }]);
    expect(result.applied).toEqual(["delete:memory:m1"]);
    expect(listMemories(dir).length).toBe(0);
  } finally { cleanup(); }
});

test("applyOps writes a subagent spec when specKind is subagent", () => {
  const { dir, cleanup } = tmpDir();
  try {
    const result = applyOps(dir, [{ op: "spec", kind: "spec", specKind: "subagent", name: "code-rev", scope: "global", body: "Review pass spec.", confidence: 0.6, evidence: ["e2"] }]);
    expect(result.applied).toEqual(["spec:code-rev"]);
    const specs = listSpecs(dir);
    expect(specs.length).toBe(1);
    expect(specs[0].kind).toBe("subagent");
  } finally { cleanup(); }
});

test("applyOps with empty ops creates no snapshot", () => {
  const { dir, cleanup } = tmpDir();
  try {
    const result = applyOps(dir, []);
    expect(result.snapshotID).toBe("");
    expect(result.applied).toEqual([]);
    expect(listSnapshots(dir).length).toBe(0);
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
