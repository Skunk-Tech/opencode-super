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

test("buildCompactionContext excludes team-kind specs", () => {
  const withTeam: HarnessState = {
    version: 1,
    updated: "t",
    memories: [],
    specs: [
      { name: "s1", kind: "skill", scope: "global", confidence: 0.6, updated: "t", evidence: [], body: "Skill body." },
      { name: "team1", kind: "team", scope: "global", confidence: 0.7, updated: "t", evidence: [], body: "Pattern: supervisor" },
    ],
  };
  const ctx = buildCompactionContext(withTeam, "global");
  const all = ctx.join("\n");
  expect(all).toContain("Skill body.");
  expect(all).not.toContain("Pattern: supervisor");
  expect(all).not.toContain("team1");
});

import { buildStateSummary, MAX_BODY_CHARS, COMPACTION_TOTAL_MAX } from "../src/inject";

const longBody = "x".repeat(MAX_BODY_CHARS * 2);

function mkMemory(name: string, body: string, confidence = 0.5): any {
  return { name, scope: "global", confidence, created: "t", updated: "t", evidence: [], body };
}

test("buildInjection truncates oversized memory bodies to MAX_BODY_CHARS", () => {
  const s: HarnessState = {
    version: 1, updated: "t",
    memories: [mkMemory("big", longBody, 0.95)],
    specs: [],
  };
  const inj = buildInjection(s, "project");
  // body appears truncated, not in full
  expect(inj.length).toBeLessThan(MAX_BODY_CHARS + 1000);
  expect(inj).not.toContain(longBody);
});

test("buildCompactionContext total is bounded even with a huge store", () => {
  const many = Array.from({ length: 60 }, (_, i) => mkMemory(`mem-${i}`, longBody, 0.9));
  const s: HarnessState = { version: 1, updated: "t", memories: many, specs: [] };
  const ctx = buildCompactionContext(s, "project");
  const total = ctx.join("\n").length;
  expect(total).toBeLessThan(COMPACTION_TOTAL_MAX);
});

test("buildStateSummary reports counts and omits overflow beyond budget", () => {
  const many = Array.from({ length: 60 }, (_, i) => mkMemory(`mem-${i}`, longBody, 0.9));
  const s: HarnessState = { version: 1, updated: "t", memories: many, specs: [] };
  const summary = buildStateSummary(s, "project");
  expect(summary).toContain("memories: 60");
  expect(summary.length).toBeLessThan(COMPACTION_TOTAL_MAX);
});
