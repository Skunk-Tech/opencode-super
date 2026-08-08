import { expect, test } from "bun:test";
import { buildInjection, buildCompactionContext, filterByScope, buildContinuationNudge } from "../src/inject";
import type { HarnessState } from "../src/store";

const state: HarnessState = {
  version: 1,
  updated: "t",
  memories: [
    { name: "m1", scope: "global", confidence: 0.9, created: "t", updated: "t", evidence: [], body: "Run build before edit." },
    { name: "m2", scope: "project", confidence: 0.8, created: "t", updated: "t", evidence: [], body: "Project quirk." },
  ],
  specs: [],
};

test("buildInjection filters to scope and sorts by confidence", () => {
  const inj = buildInjection(state, "global");
  expect(inj).toContain("<harness-memories");
  expect(inj).toContain('scope="global"');
  expect(inj).toContain("Run build before edit.");
  expect(inj).not.toContain("Project quirk.");
});

test("buildInjection orders global memories by confidence descending", () => {
  const s: HarnessState = {
    version: 1,
    updated: "t",
    memories: [
      { name: "low", scope: "global", confidence: 0.5, created: "t", updated: "t", evidence: [], body: "AAAA lower-confidence memory body" },
      { name: "high", scope: "global", confidence: 0.95, created: "t", updated: "t", evidence: [], body: "ZZZZ higher-confidence memory body" },
    ],
    specs: [],
  };
  const inj = buildInjection(s, "global");
  const highIdx = inj.indexOf("ZZZZ higher-confidence memory body");
  const lowIdx = inj.indexOf("AAAA lower-confidence memory body");
  expect(highIdx).toBeGreaterThan(-1);
  expect(lowIdx).toBeGreaterThan(-1);
  // higher confidence appears first even though its body sorts after lexicographically
  expect(highIdx).toBeLessThan(lowIdx);
});

test("buildInjection caps entries", () => {
  const inj = buildInjection(state, "global", 0);
  expect(inj).toBe("");
});

test("buildCompactionContext returns one string per entry group", () => {
  const ctx = buildCompactionContext(state, "global");
  expect(Array.isArray(ctx)).toBe(true);
  expect(ctx.join("\n")).toContain("Run build before edit.");
});

test("filterByScope keeps global memories for any scope, project memories only for project", () => {
  const project = filterByScope(state, "project");
  expect(project.memories.length).toBe(2);
  expect(project.memories.map((m) => m.name)).toContain("m1");
  expect(project.memories.map((m) => m.name)).toContain("m2");

  const global = filterByScope(state, "global");
  expect(global.memories.length).toBe(1);
  expect(global.memories[0].name).toBe("m1");
});

test("buildContinuationNudge returns a concise completion-preference block", () => {
  const nudge = buildContinuationNudge();
  expect(nudge).toContain("<harness-continuation>");
  expect(nudge).toContain("</harness-continuation>");
  expect(nudge.length).toBeLessThan(600);
  expect(nudge).toMatch(/continue|complete|finish/i);
});
