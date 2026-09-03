import { expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import {
  readRefineState, writeRefineState, newEvidenceSince, isRefineDue, runAutoRefine, parseModelRef, signalEvidence, SIGNAL_KINDS,
} from "../src/autorefine";
import type { EvidenceEntry } from "../src/store";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "autorefine-test-"));
}

const row = (ts: string, project = "/work"): EvidenceEntry => ({ ts, sessionID: "s1", kind: "tool_failure", tool: "bash", project });
const rowKind = (ts: string, kind: EvidenceEntry["kind"], project = "/work"): EvidenceEntry => ({ ts, sessionID: "s1", kind, project });

test("newEvidenceSince with no watermark returns all rows", () => {
  const rows = [row("2026-01-01T00:00:00.000Z"), row("2026-01-02T00:00:00.000Z")];
  expect(newEvidenceSince(rows, undefined).length).toBe(2);
});

test("newEvidenceSince filters strictly after the watermark (ISO strings compare chronologically)", () => {
  const rows = [row("2026-01-01T00:00:00.000Z"), row("2026-01-02T00:00:00.000Z"), row("2026-01-03T00:00:00.000Z")];
  const fresh = newEvidenceSince(rows, "2026-01-02T00:00:00.000Z");
  expect(fresh.length).toBe(1);
  expect(fresh[0].ts).toBe("2026-01-03T00:00:00.000Z");
});

test("isRefineDue requires at least minNew fresh entries", () => {
  const rows = [row("2026-01-01T00:00:00.000Z")];
  expect(isRefineDue(rows, { watermark: "2026-01-01T00:00:00.000Z" }, 5)).toBe(false);
  const fresh = rows.concat([row("2026-01-02T00:00:00.000Z"), row("2026-01-03T00:00:00.000Z"), row("2026-01-04T00:00:00.000Z"), row("2026-01-05T00:00:00.000Z"), row("2026-01-06T00:00:00.000Z")]);
  expect(isRefineDue(fresh, { watermark: "2026-01-01T00:00:00.000Z" }, 5)).toBe(true);
});

test("isRefineDue with no state (fresh install) and >= min entries is due", () => {
  const rows = [row("2026-01-01T00:00:00.000Z"), row("2026-01-02T00:00:00.000Z"), row("2026-01-03T00:00:00.000Z"), row("2026-01-04T00:00:00.000Z"), row("2026-01-05T00:00:00.000Z")];
  expect(isRefineDue(rows, {}, 5)).toBe(true);
});

test("readRefineState returns {} for missing/corrupt file", () => {
  const dir = tmpDir();
  expect(readRefineState(dir)).toEqual({});
  fs.writeFileSync(path.join(dir, "refine-state.json"), "not json", "utf8");
  expect(readRefineState(dir)).toEqual({});
});

test("writeRefineState persists and readRefineState round-trips", () => {
  const dir = tmpDir();
  writeRefineState(dir, { lastAutoRefineAt: "2026-01-01T00:00:00.000Z", watermark: "2026-01-01T00:00:00.000Z" });
  expect(readRefineState(dir)).toEqual({ lastAutoRefineAt: "2026-01-01T00:00:00.000Z", watermark: "2026-01-01T00:00:00.000Z" });
});

test("parseModelRef splits provider from model id, handling slashes in the model id", () => {
  expect(parseModelRef("omni-deepseek/ds/deepseek-v4-flash")).toEqual({ providerID: "omni-deepseek", modelID: "ds/deepseek-v4-flash" });
  expect(parseModelRef("anthropic/claude-sonnet-4-5")).toEqual({ providerID: "anthropic", modelID: "claude-sonnet-4-5" });
});

test("parseModelRef treats a bare model id (no slash) as provider-less", () => {
  expect(parseModelRef("deepseek-v4-flash")).toEqual({ providerID: "", modelID: "deepseek-v4-flash" });
  expect(parseModelRef(undefined)).toBeUndefined();
  expect(parseModelRef("")).toBeUndefined();
});

test("runAutoRefine creates a refiner session and prompts it when due", async () => {
  const global = tmpDir();
  const project = tmpDir();
  writeRefineState(project, {});
  const rows = Array.from({ length: 5 }, (_, i) => row(`2026-01-0${i + 1}T00:00:00.000Z`));
  fs.writeFileSync(path.join(global, "evidence.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  let prompted = 0;
  const client = {
    session: {
      async create(opts: any) { expect(opts.query?.directory).toBe("/work"); return { id: "auto-session" }; },
      async promptAsync(opts: any) {
        prompted++;
        expect(opts.path.id).toBe("auto-session");
        expect(opts.body.agent).toBe("refiner");
        expect(opts.body.parts[0].type).toBe("text");
        return {};
      },
    },
  };
  const ok = await runAutoRefine(client as any, "/work", global, project);
  expect(ok).toBe(true);
  expect(prompted).toBe(1);
  const state = readRefineState(project);
  expect(state.watermark).toBe("2026-01-05T00:00:00.000Z");
  expect(state.lastAutoRefineAt).toBeDefined();
});

test("runAutoRefine passes parentID to session.create and model to promptAsync", async () => {
  const global = tmpDir();
  const project = tmpDir();
  writeRefineState(project, {});
  const rows = Array.from({ length: 5 }, (_, i) => row(`2026-01-0${i + 1}T00:00:00.000Z`));
  fs.writeFileSync(path.join(global, "evidence.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  const client = {
    session: {
      async create(opts: any) {
        expect(opts.body).toEqual({ parentID: "parent-session" });
        return { id: "auto-session" };
      },
      async promptAsync(opts: any) {
        expect(opts.body.model).toEqual({ providerID: "omni-deepseek", modelID: "ds/deepseek-v4-flash" });
        return {};
      },
    },
  };
  const ok = await runAutoRefine(client as any, "/work", global, project, { parentID: "parent-session", model: "omni-deepseek/ds/deepseek-v4-flash" });
  expect(ok).toBe(true);
});

test("runAutoRefine omits parentID and model when absent", async () => {
  const global = tmpDir();
  const project = tmpDir();
  writeRefineState(project, {});
  const rows = Array.from({ length: 5 }, (_, i) => row(`2026-01-0${i + 1}T00:00:00.000Z`));
  fs.writeFileSync(path.join(global, "evidence.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  const client = {
    session: {
      async create(opts: any) { expect(opts.body).toBeUndefined(); return { id: "auto-session" }; },
      async promptAsync(opts: any) { expect(opts.body.model).toBeUndefined(); return {}; },
    },
  };
  const ok = await runAutoRefine(client as any, "/work", global, project);
  expect(ok).toBe(true);
});

test("runAutoRefine does not attach a model ref without a provider prefix", async () => {
  const global = tmpDir();
  const project = tmpDir();
  writeRefineState(project, {});
  const rows = Array.from({ length: 5 }, (_, i) => row(`2026-01-0${i + 1}T00:00:00.000Z`));
  fs.writeFileSync(path.join(global, "evidence.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  const client = {
    session: {
      async create(opts: any) { expect(opts.body).toBeUndefined(); return { id: "auto-session" }; },
      async promptAsync(opts: any) { expect(opts.body.model).toBeUndefined(); return {}; },
    },
  };
  const ok = await runAutoRefine(client as any, "/work", global, project, { model: "deepseek-v4-flash" });
  expect(ok).toBe(true);
});

test("runAutoRefine ignores evidence from other projects", async () => {
  const global = tmpDir();
  const project = tmpDir();
  writeRefineState(project, {});
  // 5 rows belong to another project; only 1 belongs to /work
  const other = Array.from({ length: 5 }, (_, i) => row(`2026-01-0${i + 1}T00:00:00.000Z`, "/other"));
  const mine = [row("2026-01-06T00:00:00.000Z")];
  fs.writeFileSync(path.join(global, "evidence.jsonl"), [...other, ...mine].map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  let prompted = 0;
  const client = { session: { async create() { return { id: "x" }; }, async promptAsync() { prompted++; return {}; } } };
  const ok = await runAutoRefine(client as any, "/work", global, project);
  expect(ok).toBe(false);
  expect(prompted).toBe(0);
});

test("runAutoRefine does nothing when evidence gate not met", async () => {
  const global = tmpDir();
  const project = tmpDir();
  writeRefineState(project, { watermark: "2999-12-31T00:00:00.000Z" });
  fs.writeFileSync(path.join(global, "evidence.jsonl"), JSON.stringify(row("2026-01-01T00:00:00.000Z")) + "\n", "utf8");
  let prompted = 0;
  const client = { session: { async create() { return { id: "x" }; }, async promptAsync() { prompted++; return {}; } } };
  const ok = await runAutoRefine(client as any, "/work", global, project);
  expect(ok).toBe(false);
  expect(prompted).toBe(0);
});

test("runAutoRefine returns false when disabled", async () => {
  const global = tmpDir();
  const project = tmpDir();
  writeRefineState(project, {});
  const rows = Array.from({ length: 5 }, (_, i) => row(`2026-01-0${i + 1}T00:00:00.000Z`));
  fs.writeFileSync(path.join(global, "evidence.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  const client = { session: { async create() { return { id: "x" }; }, async promptAsync() { return {}; } } };
  const ok = await runAutoRefine(client as any, "/work", global, project, { enabled: false });
  expect(ok).toBe(false);
});

test("runAutoRefine swallows client failures and leaves watermark unchanged", async () => {
  const global = tmpDir();
  const project = tmpDir();
  writeRefineState(project, { watermark: "2026-01-01T00:00:00.000Z" });
  const rows = Array.from({ length: 5 }, (_, i) => row(`2026-01-0${i + 2}T00:00:00.000Z`));
  fs.writeFileSync(path.join(global, "evidence.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  const client = { session: { async create() { throw new Error("boom"); }, async promptAsync() { return {}; } } };
  const ok = await runAutoRefine(client as any, "/work", global, project);
  expect(ok).toBe(false);
  expect(readRefineState(project).watermark).toBe("2026-01-01T00:00:00.000Z");
});

test("isRefineDue does not fire on harness lifecycle noise alone", () => {
  const state = { watermark: "2026-01-01T00:00:00.000Z" };
  const noise = ["session_created", "session_idle", "session_error", "premature_stop"].map((kind, i) =>
    rowKind(`2026-01-0${i + 2}T00:00:00.000Z`, kind as EvidenceEntry["kind"])
  );
  expect(isRefineDue(noise, state, 4)).toBe(false);
});

test("isRefineDue fires on tool_failure rows only", () => {
  const state = { watermark: "2026-01-01T00:00:00.000Z" };
  const signal = Array.from({ length: 5 }, (_, i) => row(`2026-01-0${i + 2}T00:00:00.000Z`));
  expect(isRefineDue(signal, state, 5)).toBe(true);
});

test("signalEvidence filters to tool_failure and retry", () => {
  const mixed = [
    row("2026-01-01T00:00:00.000Z"),
    rowKind("2026-01-02T00:00:00.000Z", "retry"),
    rowKind("2026-01-03T00:00:00.000Z", "session_created"),
    rowKind("2026-01-04T00:00:00.000Z", "session_idle"),
    rowKind("2026-01-05T00:00:00.000Z", "session_error"),
    rowKind("2026-01-06T00:00:00.000Z", "premature_stop"),
  ];
  const sig = signalEvidence(mixed);
  expect(sig.length).toBe(2);
  expect(sig.every((r) => SIGNAL_KINDS.has(r.kind))).toBe(true);
});

test("isRefineDue respects the cooldown window", () => {
  const rows = Array.from({ length: 5 }, (_, i) => row(`2026-01-0${i + 2}T00:00:00.000Z`));
  const freshState = { watermark: "2026-01-01T00:00:00.000Z", lastAutoRefineAt: new Date().toISOString() };
  expect(isRefineDue(rows, freshState, 5)).toBe(false);
});

test("isRefineDue allows refine after the cooldown window elapses", () => {
  const rows = Array.from({ length: 5 }, (_, i) => row(`2026-01-0${i + 2}T00:00:00.000Z`));
  const oldState = { watermark: "2026-01-01T00:00:00.000Z", lastAutoRefineAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() };
  expect(isRefineDue(rows, oldState, 5)).toBe(true);
});

test("runAutoRefine does not spawn from lifecycle noise (no self-trigger)", async () => {
  const global = tmpDir();
  const project = tmpDir();
  writeRefineState(project, {});
  const noise = ["session_created", "session_idle", "premature_stop", "session_error", "session_created"].map((kind, i) =>
    rowKind(`2026-01-0${i + 1}T00:00:00.000Z`, kind as EvidenceEntry["kind"], "/work")
  );
  fs.writeFileSync(path.join(global, "evidence.jsonl"), noise.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  let prompted = 0;
  const client = { session: { async create() { return { id: "x" }; }, async promptAsync() { prompted++; return {}; } } };
  const ok = await runAutoRefine(client as any, "/work", global, project);
  expect(ok).toBe(false);
  expect(prompted).toBe(0);
});

test("runAutoRefine obeys an explicit cooldown after a prior refine", async () => {
  const global = tmpDir();
  const project = tmpDir();
  writeRefineState(project, { lastAutoRefineAt: new Date().toISOString() });
  const rows = Array.from({ length: 5 }, (_, i) => row(`2026-01-0${i + 1}T00:00:00.000Z`));
  fs.writeFileSync(path.join(global, "evidence.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  let prompted = 0;
  const client = { session: { async create() { return { id: "x" }; }, async promptAsync() { prompted++; return {}; } } };
  const ok = await runAutoRefine(client as any, "/work", global, project);
  expect(ok).toBe(false);
  expect(prompted).toBe(0);
});
