import { test, expect } from "bun:test";
import { makeNote, parseBuildOutput, ensureBuild } from "../.opencode/plugins/context-map.js";

test("makeNote points at the real map paths and documents the reference query accurately", () => {
  const note = makeNote("graft/");
  expect(note).toContain("Context Map ready");
  expect(note).toContain("graft/");
  expect(note).toContain("wiring.json");
  // accurate guidance, not the old false "edges.to matches symbol" claim
  expect(note).toMatch(/symbols/);
});

test("parseBuildOutput extracts the stats line from the builder stdout", () => {
  const line = "context-map: 3 files, 5 nodes, 4 edges -> graft/";
  expect(parseBuildOutput(line).fileCount).toBe(3);
  expect(parseBuildOutput(line).edgeCount).toBe(4);
  expect(parseBuildOutput("garbage without the prefix")).toBeNull();
});

test("ensureBuild runs once per root even when called twice (dedupes double-loading)", async () => {
  let runs = 0;
  const fakeBuild = async () => { runs += 1; return { ok: true }; };
  const root = "/tmp/root-" + Date.now();
  const a = ensureBuild(root, { runBuild: fakeBuild });
  const b = ensureBuild(root, { runBuild: fakeBuild });
  await Promise.all([a, b]);
  expect(runs).toBe(1);
});

test("ensureBuild reports failure when the builder exits non-zero", async () => {
  const res = await ensureBuild("/tmp/fail-" + Date.now(), {
    runBuild: async () => ({ ok: false }),
  });
  expect(res.ok).toBe(false);
});
