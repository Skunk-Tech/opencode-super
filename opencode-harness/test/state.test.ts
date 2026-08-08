import { expect, test } from "bun:test";
import { writeMemory, writeSpec, listMemories, listSpecs, deleteEntry, loadState, snapshot, listSnapshots, rollback } from "../src/store";
import { tmpDir } from "./helpers";

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
