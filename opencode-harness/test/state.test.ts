import { expect, test } from "bun:test";
import { writeMemory, writeSpec, listMemories, listSpecs, deleteEntry, loadState, loadMergedState, snapshot, listSnapshots, rollback } from "../src/store";
import { tmpDir } from "./helpers";

test("loadMergedState combines global-scope from global dir and all project entries", () => {
  const g = tmpDir();
  const p = tmpDir();
  try {
    writeMemory(g.dir, { name: "g1", scope: "global", confidence: 0.9, created: "t", updated: "t", evidence: [], body: "global mem" });
    writeMemory(p.dir, { name: "p1", scope: "project", confidence: 0.8, created: "t", updated: "t", evidence: [], body: "project mem" });
    const state = loadMergedState(g.dir, p.dir);
    expect(state.memories.map((m) => m.name)).toContain("g1");
    expect(state.memories.map((m) => m.name)).toContain("p1");
  } finally { g.cleanup(); p.cleanup(); }
});

test("loadMergedState without a project dir returns global state only", () => {
  const { dir, cleanup } = tmpDir();
  try {
    writeMemory(dir, { name: "g1", scope: "global", confidence: 0.9, created: "t", updated: "t", evidence: [], body: "global mem" });
    const state = loadMergedState(dir);
    expect(state.memories.length).toBe(1);
  } finally { cleanup(); }
});

test("snapshot with explicit id uses that id", () => {
  const { dir, cleanup } = tmpDir();
  try {
    writeMemory(dir, { name: "m1", scope: "global", confidence: 0.7, created: "t", updated: "t", evidence: [], body: "v1" });
    const id = snapshot(dir, "shared-1");
    expect(id).toBe("shared-1");
    expect(listSnapshots(dir)).toContain("shared-1");
  } finally { cleanup(); }
});

test("writeMemory and listMemories round-trip", () => {
  const { dir, cleanup } = tmpDir();
  try {
    writeMemory(dir, { name: "build-first", scope: "project", confidence: 0.8, created: "t1", updated: "t1", evidence: ["e1"], body: "Run the build before editing." });
    const mems = listMemories(dir);
    expect(mems.length).toBe(1);
    expect(mems[0].name).toBe("build-first");
    expect(mems[0].body).toContain("Run the build");
  } finally { cleanup(); }
});

test("evidence with commas survives write then list round-trip", () => {
  const { dir, cleanup } = tmpDir();
  try {
    const evidence = ["fixed in a1b2, see #123", "plain ref"];
    writeMemory(dir, { name: "comma-ev", scope: "global", confidence: 0.7, created: "t", updated: "t", evidence, body: "body" });
    const mems = listMemories(dir);
    expect(mems.length).toBe(1);
    expect(mems[0].evidence).toEqual(["fixed in a1b2, see #123", "plain ref"]);
  } finally { cleanup(); }
});

test("loadState compiles memories and specs", () => {
  const { dir, cleanup } = tmpDir();
  try {
    writeMemory(dir, { name: "m1", scope: "global", confidence: 0.7, created: "t", updated: "t", evidence: ["ref with, comma inside"], body: "body m1" });
    writeSpec(dir, { name: "s1", kind: "skill", scope: "global", confidence: 0.6, updated: "t", evidence: ["spec ref a, spec ref b"], body: "body s1" });
    const state = loadState(dir);
    expect(state.memories.length).toBe(1);
    expect(state.specs.length).toBe(1);
    expect(state.specs[0].kind).toBe("skill");
    expect(state.memories[0].evidence).toEqual(["ref with, comma inside"]);
    expect(state.specs[0].evidence).toEqual(["spec ref a, spec ref b"]);
  } finally { cleanup(); }
});

test("deleteEntry removes a memory file", () => {
  const { dir, cleanup } = tmpDir();
  try {
    writeMemory(dir, { name: "m1", scope: "global", confidence: 0.7, created: "t", updated: "t", evidence: [], body: "x" });
    deleteEntry(dir, "memory", "m1");
    expect(listMemories(dir).length).toBe(0);
  } finally { cleanup(); }
});

test("snapshot then rollback restores previous state", () => {
  const { dir, cleanup } = tmpDir();
  try {
    writeMemory(dir, { name: "m1", scope: "global", confidence: 0.7, created: "t", updated: "t", evidence: [], body: "v1" });
    const id = snapshot(dir);
    expect(listSnapshots(dir).length).toBe(1);
    writeMemory(dir, { name: "m1", scope: "global", confidence: 0.7, created: "t", updated: "t", evidence: [], body: "v2" });
    rollback(dir, id);
    expect(listMemories(dir)[0].body).toBe("v1");
  } finally { cleanup(); }
});

test("rollback to an empty snapshot removes entries added afterward", () => {
  const { dir, cleanup } = tmpDir();
  try {
    const id = snapshot(dir);
    writeMemory(dir, { name: "ghost", scope: "global", confidence: 0.7, created: "t", updated: "t", evidence: [], body: "added after snapshot" });
    expect(listMemories(dir).length).toBe(1);
    rollback(dir, id);
    expect(listMemories(dir).length).toBe(0);
  } finally { cleanup(); }
});
