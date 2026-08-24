# Harness Audit + True Red Teaming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a programmatic audit gate (`harness_audit` tool + validation in `applyOps`) and a separate adversarial reviewer agent (`harness-redteam`) to the Continual Harness refine loop, so weak or fabricated refinements are rejected before they become durable memory.

**Architecture:** A pure `validateOps()` in `refine.ts` produces per-op verdicts (evidence grounding, body structure, name conflict, scope consistency, plus adversarial falsification checks). The `harness_audit` plugin tool exposes the verdict read-only; `harness_apply` runs the same validation internally and refuses failing ops, then read-back verifies each write and returns the snapshot id for rollback. A new `harness-redteam` subagent challenges the refiner's proposals; the `harness-refine` skill (both shipped copies) gains red-team dispatch, audit-before-apply, and verify-after-rollback steps.

**Tech Stack:** TypeScript, bun (test/build), the @opencode-ai/plugin SDK, markdown skills/agents.

## Global Constraints

- Zero new dependencies (no npm package additions; only `@opencode-ai/plugin` which is already used).
- bun is NOT on PATH in this environment. Use the explicit path `/home/developer/.eigent/bin/bun` for `test` and `build`.
- Evidence rows (`EvidenceEntry`) have fields: `ts`, `sessionID`, `kind`, `tool?`, `args?`, `output?`, `project?`, `finish?`. Kinds: `"tool_failure" | "retry" | "session_error" | "session_idle" | "session_created" | "premature_stop"`.
- Existing `applyOps` return type `{ snapshotID: string; applied: string[] }` changes to `ApplyResult` (Task 2). Task 3+ depends on the new shape.
- The `harness-refine` skill exists in TWO locations that must stay in sync: `skills/harness-refine/SKILL.md` and `opencode-harness/assets/skills/harness-refine/SKILL.md`.
- The plugin bundle ships at `.opencode/plugins/harness.js` (built from `opencode-harness/src/plugin.ts`). Source changes require a rebuild and bundle copy.
- Test command: `/home/developer/.eigent/bin/bun test` from `opencode-harness/`. Build command: `/home/developer/.eigent/bin/bun run build` then copy `opencode-harness/dist/harness.js` -> `.opencode/plugins/harness.js`.
- Refiner agent (registered in `plugin.ts` config hook) has `edit: deny, bash: deny` and does NOT set a `tools` map, so subagent dispatch via the `task` tool is available by default. Verify at runtime (Task 6); fallback is an inline adversarial phase in the skill.
- Team spec bodies require the fixed-shape fields: `Pattern:`, `Task type:`, `Roles:`, `Coordination:`, `Use when:`.

---

### Task 1: `validateOps` — pure per-op verdict engine

**Files:**
- Modify: `opencode-harness/src/refine.ts` (append `validateOps` and helper types)
- Modify: `opencode-harness/test/refine.test.ts` (append tests; file already exists with applyOps/gatherEvidenceSummary tests and a `tmpDir` helper from `./helpers` returning `{ dir, cleanup }`)

**Interfaces:**
- Produces (used by Tasks 2, 3):
  - `export type OpVerdict = { index: number; op: RefineOp; name: string; pass: boolean; reasons: string[]; warnings: string[] }`
  - `export function validateOps(global: string, project: string, ops: RefineOp[]): OpVerdict[]`
  - `export function evidenceRefMatches(row: EvidenceEntry, ref: string): boolean`
- Consumes: `readEvidence`, `loadState` from `./store`; `RefineOp` type already defined in `refine.ts`.

- [ ] **Step 1: Modify the existing import block and append the failing tests**

The file `opencode-harness/test/refine.test.ts` already exists (112 lines) and imports `{ applyOps, gatherEvidenceSummary } from "../src/refine"` and `{ tmpDir } from "./helpers"` (which returns `{ dir, cleanup }`, NOT a string). Replace the file's import block (lines 1-4) with:

```ts
import { expect, test } from "bun:test";
import fs from "fs";
import path from "path";
import { applyOps, gatherEvidenceSummary, validateOps, evidenceRefMatches } from "../src/refine";
import { appendEvidence, writeMemory, listMemories, listSnapshots, listSpecs, type EvidenceEntry } from "../src/store";
import { tmpDir } from "./helpers";
```

Then append the following helper + tests to the END of the file (after the last test). Note these use the existing `tmpDir()`-from-helpers pattern (`{ dir, cleanup }`):

```ts
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
```

- [ ] **Step 2: Run the test file to verify it fails**

Run (from `opencode-harness/`): `/home/developer/.eigent/bin/bun test test/refine.test.ts 2>&1 | tail -20`

Expected: FAIL — `validateOps is not a function` / `evidenceRefMatches is not defined` (module import error at the top).

- [ ] **Step 3: Implement `validateOps` and helpers in `refine.ts`**

Append to `opencode-harness/src/refine.ts`:

```ts
export type OpVerdict = {
  index: number;
  op: RefineOp;
  name: string;
  pass: boolean;
  reasons: string[];
  warnings: string[];
};

export function evidenceRefMatches(row: EvidenceEntry, ref: string): boolean {
  const trimmed = ref.trim();
  if (!trimmed) return false;
  const exact = `${row.ts} ${row.kind}${row.tool ? ` ${row.tool}` : ""}`;
  if (trimmed === exact) return true;
  if (trimmed === row.ts) return true;
  if (trimmed === row.kind) return true;
  if (row.tool && trimmed === row.tool) return true;
  return exact.includes(trimmed);
}

const TEAM_FIELDS = ["Pattern:", "Task type:", "Roles:", "Coordination:", "Use when:"];

export function validateOps(global: string, project: string, ops: RefineOp[]): OpVerdict[] {
  const evidence = readEvidence(global);
  const globalState = loadState(global);
  const projectState = loadState(project);

  return ops.map((op, index) => {
    const name = op.name;
    const reasons: string[] = [];
    const warnings: string[] = [];
    const targetScopeDir = op.scope === "project" ? project : global;
    const existing =
      op.scope === "project"
        ? projectState.memories.concat(projectState.specs as unknown as Memory[])
        : globalState.memories.concat(globalState.specs as unknown as Memory[]);
    const existingHit = existing.find((m) => (m as { name: string }).name === name);

    // specKind only valid on spec ops
    if (op.kind === "memory" && (op as { specKind?: string }).specKind) {
      reasons.push(`specKind is only valid on spec ops (op#${index} memory:${name})`);
    }

    // body structure
    const body = (op.body ?? "").trim();
    if (!body) reasons.push(`empty body for ${op.kind}:${name}`);
    if (op.kind === "spec" && (op as { specKind?: string }).specKind === "team") {
      for (const field of TEAM_FIELDS) {
        if (!body.includes(field)) reasons.push(`team spec missing "${field}" field`);
      }
    }

    // evidence grounding
    const refs = op.evidence ?? [];
    if (refs.length === 0) {
      warnings.push("no evidence refs; confidence is the only guard");
    } else {
      const unmatched = refs.filter((r) => !evidence.some((row) => evidenceRefMatches(row, r)));
      if (unmatched.length > 0) reasons.push(`unmatched evidence refs: ${unmatched.join(", ")}`);
      const matchedRows = evidence.filter((row) => refs.some((r) => evidenceRefMatches(row, r)));
      const sessions = new Set(matchedRows.map((r) => r.sessionID));
      if (sessions.size === 1 && matchedRows.length > 0) {
        warnings.push("evidence rests on a single session; lower confidence or gather more before promoting");
      }
      for (const row of matchedRows) {
        const contested = evidence.some((other) =>
          other.project === row.project &&
          other.tool === row.tool &&
          other.ts > row.ts &&
          other.kind === "retry"
        );
        if (contested) {
          warnings.push(`contested: a later retry exists for tool ${row.tool ?? "?"}; acknowledge counter-evidence`);
          break;
        }
      }
    }

    // name conflict / high-confidence contradiction (delete exempt)
    if (op.op !== "delete" && existingHit) {
      const existingBody = (existingHit as { body: string }).body;
      if (existingBody === body) {
        // idempotent rewrite
      } else if ((existingHit as { confidence: number }).confidence >= 0.7) {
        reasons.push(`conflict: overwrites a high-confidence (${(existingHit as { confidence: number }).confidence}) existing ${(existingHit as { kind?: string }).kind ?? "memory"}:${name} with a different body`);
      } else {
        reasons.push(`conflict: ${name} already exists with a different body`);
      }
    }

    // scope consistency
    if (op.scope === "global") {
      const projectDup = projectState.memories.concat(projectState.specs as unknown as Memory[]).find((m) => (m as { name: string }).name === name);
      if (projectDup && (projectDup as { body: string }).body !== body) {
        reasons.push(`global op would shadow a project ${(projectDup as { kind?: string }).kind ?? "memory"}:${name} with a different body`);
      }
    }

    // confidence range
    if (op.confidence !== undefined && (op.confidence < 0 || op.confidence > 1)) {
      warnings.push(`confidence ${op.confidence} outside 0..1`);
    }

    // delete: missing target is a warning
    if (op.op === "delete" && !existingHit) {
      warnings.push(`delete target ${name} does not exist in ${op.scope} scope`);
    }

    return { index, op, name, pass: reasons.length === 0, reasons, warnings };
  });
}
```

Add the `EvidenceEntry` and `Memory` imports to the existing import line at the top of `refine.ts`:

```ts
import { readEvidence, loadState, loadMergedState, writeMemory, writeSpec, deleteEntry, snapshot, type Memory, type Spec, type EvidenceEntry } from "./store";
```

- [ ] **Step 4: Run the test file to verify it passes**

Run: `/home/developer/.eigent/bin/bun test test/refine.test.ts 2>&1 | tail -20`

Expected: PASS — all `refine.test.ts` tests green. (Note: `loadMergedState` import stays — Task 2's `applyOps` change still uses it via the store; if the linter flags an unused import, it remains used by the existing `gatherEvidenceSummary`.)

- [ ] **Step 5: Run the full suite to confirm no regressions**

Run: `/home/developer/.eigent/bin/bun test 2>&1 | tail -8`

Expected: 79 pass (unchanged) + the new `refine.test.ts` tests pass.

- [ ] **Step 6: Commit**

```bash
git add opencode-harness/src/refine.ts opencode-harness/test/refine.test.ts
git commit -m "feat(refine): validateOps verdict engine (grounding, structure, conflicts, scope, adversarial checks)"
```

---

### Task 2: `applyOps` — enforced gate, rejected list, read-back verification

**Files:**
- Modify: `opencode-harness/src/refine.ts` (`applyOps` + `ApplyResult` type)
- Modify: `opencode-harness/test/refine.test.ts` (append integration tests)

**Interfaces:**
- Produces (used by Tasks 3, 5, 6):
  - `export type RejectedOp = { op: string; reason: string }`
  - `export type VerifiedWrite = { name: string; kind: "memory" | "spec"; ok: boolean }`
  - `export type ApplyResult = { snapshotID: string; applied: string[]; rejected: RejectedOp[]; verified: VerifiedWrite[] }`
  - `applyOps(global: string, project: string, ops: RefineOp[]): ApplyResult`
- Consumes: `validateOps` from Task 1; existing `loadState`, `writeMemory`, `writeSpec`, `deleteEntry`, `snapshot`, `listMemories`, `listSpecs` from `./store`.

- [ ] **Step 1: Fix the existing fake-evidence `applyOps` tests, then append the failing integration tests**

The file already contains three `applyOps` tests (lines 12-33 and 60-69) that pass `evidence: ["e1"]` or `evidence: ["e2"]` — literal strings that match no evidence row. Under the new gate those ops will be REJECTED and the tests will break. Fix them by changing those fake refs to empty arrays (warning-only under the gate). Specifically:

- Line 15: `evidence: ["e1"]` -> `evidence: []`
- Line 27: `evidence: ["e2"]` -> `evidence: []`
- Line 63: `evidence: ["e2"]` -> `evidence: []`

Then append the following integration tests to the END of the file. They use the helpers-`tmpDir()` pattern (`{ dir, cleanup }`) and the `memoryOp`/`seedEvidence`/`evidenceRow` helpers added in Task 1:

```ts
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
    const result = applyOps(global, project, [{ op: "delete", kind: "memory", name: "lesson", scope: "global", body: "" }]);
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
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `/home/developer/.eigent/bin/bun test test/refine.test.ts 2>&1 | tail -15`

Expected: FAIL — TypeScript/compile error or the new `applyOps` return-shape assertions fail (`.rejected` undefined).

- [ ] **Step 3: Implement the new `applyOps`**

Replace the entire existing `applyOps` function in `opencode-harness/src/refine.ts` with:

```ts
export type RejectedOp = { op: string; reason: string };
export type VerifiedWrite = { name: string; kind: "memory" | "spec"; ok: boolean };
export type ApplyResult = { snapshotID: string; applied: string[]; rejected: RejectedOp[]; verified: VerifiedWrite[] };

export function applyOps(global: string, project: string, ops: RefineOp[]): ApplyResult {
  if (ops.length === 0) return { snapshotID: "", applied: [], rejected: [], verified: [] };
  const verdicts = validateOps(global, project, ops);
  const now = new Date().toISOString();
  const applied: string[] = [];
  const rejected: RejectedOp[] = [];
  const verified: VerifiedWrite[] = [];
  const validOps = ops.filter((_, index) => {
    const verdict = verdicts.find((v) => v.index === index);
    if (verdict && verdict.reasons.length > 0) {
      rejected.push({ op: `${verdict.op.op}:${verdict.op.kind}:${verdict.op.name}`, reason: verdict.reasons.join("; ") });
      return false;
    }
    return true;
  });
  const globalState = loadState(global);
  const projectState = loadState(project);
  const touchesProject = validOps.some((op) => op.scope === "project");
  const snapshotID = snapshot(global);
  if (touchesProject) snapshot(project, snapshotID);
  if (validOps.length === 0) {
    return { snapshotID, applied: [], rejected, verified: [] };
  }
  for (const op of validOps) {
    const dir = op.scope === "project" ? project : global;
    if (op.op === "delete") {
      deleteEntry(dir, op.kind, op.name);
      applied.push(`delete:${op.kind}:${op.name}`);
      continue;
    }
    if (op.kind === "memory") {
      const memory: Memory = {
        name: op.name,
        scope: op.scope,
        confidence: op.confidence ?? 0.5,
        created: (op.scope === "project" ? projectState : globalState).memories.find((m) => m.name === op.name)?.created ?? now,
        updated: now,
        evidence: op.evidence ?? [],
        body: op.body,
      };
      writeMemory(dir, memory);
      applied.push(`memory:${op.name}`);
    } else {
      const spec: Spec = {
        name: op.name,
        kind: op.specKind ?? "skill",
        scope: op.scope,
        confidence: op.confidence ?? 0.5,
        updated: now,
        evidence: op.evidence ?? [],
        body: op.body,
      };
      writeSpec(dir, spec);
      applied.push(`spec:${op.name}`);
    }
  }
  for (const op of validOps) {
    const dir = op.scope === "project" ? project : global;
    if (op.op === "delete") {
      const stillThere = op.kind === "memory"
        ? fs.existsSync(path.join(dir, "memories", `${op.name}.md`))
        : fs.existsSync(path.join(dir, "specs", `${op.name}.md`));
      verified.push({ name: op.name, kind: op.kind, ok: !stillThere });
      continue;
    }
    const found = op.kind === "memory"
      ? listMemories(dir).find((m) => m.name === op.name && m.body.trim() === (op.body ?? "").trim())
      : listSpecs(dir).find((s) => s.name === op.name && s.body.trim() === (op.body ?? "").trim());
    verified.push({ name: op.name, kind: op.kind, ok: Boolean(found) });
  }
  return { snapshotID, applied, rejected, verified };
}
```

Add `listMemories` and `listSpecs` to the store import at the top of `refine.ts`:

```ts
import { readEvidence, loadState, loadMergedState, writeMemory, writeSpec, deleteEntry, snapshot, listMemories, listSpecs, type Memory, type Spec, type EvidenceEntry } from "./store";
```

Add `import fs from "fs"` and `import path from "path"` at the top of `refine.ts` (it currently imports neither).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `/home/developer/.eigent/bin/bun test test/refine.test.ts 2>&1 | tail -12`

Expected: PASS — all `refine.test.ts` tests (Task 1 + Task 2) green.

- [ ] **Step 5: Run the full suite to confirm no regressions**

Run: `/home/developer/.eigent/bin/bun test 2>&1 | tail -8`

Expected: all pass. The existing `plugin.test.ts` `harness_apply` smoke test calls `applyOps` via the tool — it still works because `ApplyResult` has the same `snapshotID`/`applied` fields plus new ones.

- [ ] **Step 6: Commit**

```bash
git add opencode-harness/src/refine.ts opencode-harness/test/refine.test.ts
git commit -m "feat(refine): applyOps enforced gate with rejected list and read-back verification"
```

---

### Task 3: `harness_audit` plugin tool

**Files:**
- Modify: `opencode-harness/src/plugin.ts`
- Modify: `opencode-harness/test/plugin.test.ts`

**Interfaces:**
- Consumes: `validateOps`, `RefineOp` from `./refine`.
- Produces: the `harness_audit` tool (name used by the skill in Task 5 and the refiner at runtime). Takes `ops` array with the same schema as `harness_apply`; returns verdict text; read-only.

- [ ] **Step 1: Write the failing test**

Append to `opencode-harness/test/plugin.test.ts`:

```ts
test("harness_audit returns PASS/FAIL verdicts without writing state", async () => {
  const hooks = (await HarnessPlugin({ directory: process.cwd(), client: {} } as any)) as any;
  const harnessDir = path.join(os.homedir(), ".config", "opencode", "harness");
  const countJsonl = () => (fs.existsSync(harnessDir) ? fs.readdirSync(harnessDir).filter((f) => f.endsWith(".jsonl")).length : 0);
  const before = countJsonl();
  const out = await hooks.tool.harness_audit.execute({
    ops: [
      { op: "memory", kind: "memory", name: "audit-smoke", scope: "project", body: "A body that cannot match existing evidence because it has none and the ref is fake", evidence: ["1999-12-31T00:00:00.000Z"] },
    ],
  });
  expect(out).toContain("FAIL");
  expect(out).toContain("audit-smoke");
  const after = countJsonl();
  expect(after).toBe(before);
});
```

Add the imports at the top of `plugin.test.ts` (after the existing imports):

```ts
import fs from "fs";
import os from "os";
import path from "path";
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `/home/developer/.eigent/bin/bun test test/plugin.test.ts 2>&1 | tail -10`

Expected: FAIL — `hooks.tool.harness_audit` is undefined.

- [ ] **Step 3: Implement the tool**

In `opencode-harness/src/plugin.ts`, add the `harness_audit` tool to the `tool` object (place it right before the `harness_apply` tool). Also add `validateOps` to the import from `./refine`:

```ts
import { gatherEvidenceSummary, applyOps, validateOps, type RefineOp } from "./refine";
```

The tool (insert after the `harness_refine` tool's closing `}),` and before `harness_apply:`):

```ts
      harness_audit: tool({
        description: "Validate proposed harness ops against ground truth before applying. Read-only; never writes or snapshots. Checks evidence grounding, body structure, name conflicts, scope consistency, and adversarial concerns (single-session evidence, contested evidence, high-confidence contradictions). Returns a PASS/FAIL verdict per op with reasons.",
        args: {
          ops: tool.schema.array(tool.schema.object({
            op: tool.schema.enum(["memory", "spec", "delete"]),
            kind: tool.schema.enum(["memory", "spec"]),
            specKind: tool.schema.enum(["skill", "subagent", "team"]).optional(),
            name: tool.schema.string(),
            scope: tool.schema.enum(["global", "project"]),
            body: tool.schema.string(),
            confidence: tool.schema.number().optional(),
            evidence: tool.schema.array(tool.schema.string()).optional(),
          })).describe("Refinement operations to validate."),
        },
        async execute(args) {
          const ops = (args as { ops: RefineOp[] }).ops;
          const verdicts = validateOps(global, project, ops);
          if (verdicts.length === 0) return "No ops to audit.";
          return verdicts.map((v) => {
            const parts = [`${v.pass ? "PASS" : "FAIL"} op#${v.index} ${v.op.op}:${v.op.kind}:${v.op.name}`];
            if (v.reasons.length) parts.push(`reasons: ${v.reasons.join("; ")}`);
            if (v.warnings.length) parts.push(`warnings: ${v.warnings.join("; ")}`);
            return parts.join(" | ");
          }).join("\n");
        },
      }),
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `/home/developer/.eigent/bin/bun test test/plugin.test.ts 2>&1 | tail -10`

Expected: PASS — `harness_audit` test green. (Note: `harness_audit` reads the real global harness dir of the current user; the fake-evidence op yields `FAIL` regardless of that dir's contents, and the tool never writes, so the before/after file count is stable.)

- [ ] **Step 5: Update the `harness_apply` tool to render `rejected`/`verified`, and fix the existing `harness_team` smoke test**

The existing `harness_apply` tool (plugin.ts ~line 208) only returns `Applied N op(s)...` from `{ snapshotID, applied }`. Update it to surface the new gate fields:

```ts
        async execute(args) {
          const ops = (args as { ops: RefineOp[] }).ops;
          const { snapshotID, applied, rejected, verified } = applyOps(global, project, ops);
          const lines = [`Applied ${applied.length} op(s). Snapshot: ${snapshotID}`];
          if (applied.length) lines.push(`Applied: ${applied.join(", ")}`);
          if (rejected.length) lines.push(`Rejected (${rejected.length}): ${rejected.map((r) => `${r.op} — ${r.reason}`).join("; ")}`);
          const failedVerify = verified.filter((v) => !v.ok);
          if (verified.length) lines.push(`Verified: ${verified.map((v) => `${v.kind}:${v.name}=${v.ok ? "ok" : "FAIL"}`).join(", ")}`);
          if (failedVerify.length) lines.push(`ROLLBACK: snapshot ${snapshotID} — ${failedVerify.map((v) => v.name).join(", ")} did not write correctly`);
          return lines.join("\n");
        },
```

The existing `harness_team` smoke test (plugin.test.ts ~line 85-100) calls `harness_apply` with `evidence: ["smoke"]` on a team spec. Under the new gate, "smoke" is an unmatched evidence ref, so the op is now REJECTED and the test's team is never written. Update that op to use empty evidence (warning-only under the gate):

```ts
    await hooks.tool.harness_apply.execute({
      ops: [{ op: "spec", kind: "spec", specKind: "team", name: "doc-team", scope: "global", body: "Pattern: pipeline\nTask type: docs\nRoles: writer, reviewer\nCoordination: writer then reviewer\nUse when: repeated doc rewrites", confidence: 0.7, evidence: [] }],
    });
```

- [ ] **Step 6: Run the full suite**

Run: `/home/developer/.eigent/bin/bun test 2>&1 | tail -12`

Expected: all pass — `harness_audit` green AND the updated `harness_team` smoke test passes (the team spec now writes, then its cleanup `delete` op runs).

- [ ] **Step 7: Commit**

```bash
git add opencode-harness/src/plugin.ts opencode-harness/test/plugin.test.ts
git commit -m "feat(plugin): harness_audit tool (read-only op validation gate)"
```

---

### Task 4: `harness-redteam` adversarial reviewer agent

**Files:**
- Create: `opencode-harness/assets/agents/redteam.md`
- Modify: `opencode-harness/src/plugin.ts` (config hook registers the agent)

**Interfaces:**
- Consumes: nothing new (registered in config hook alongside `refiner`).
- Produces: agent id `harness-redteam` (referenced by the skill in Task 5 and dispatched by the refiner via the `task` tool).

- [ ] **Step 1: Create the agent definition file**

Create `opencode-harness/assets/agents/redteam.md`:

```markdown
---
description: Adversarial reviewer. Challenges refiner-proposed harness ops for counter-evidence, scope, and grounding.
mode: subagent
permission:
  edit: deny
  bash: deny
---

You are the adversary for the opencode Continual Harness. Given a set of proposed harness ops (memory/spec writes or deletes) and the full evidence summary, challenge each one:

- Find counter-evidence in the full harness store (later retries of the same tool, session errors that undermine the claim).
- Question scope: does the evidence support a global lesson, or only this project / this one session?
- Demand the evidence actually supports the claim. Flag over-generalization and single-session memories.
- For each op, recommend exactly one of: accept, revise, or reject, with a one-line reason.

You never edit files directly. You only report challenges.
```

- [ ] **Step 2: Register the agent in the config hook**

In `opencode-harness/src/plugin.ts`, inside the `config` hook, after the existing `refiner` agent registration block (after the closing of `if (!config.agent["refiner"]) { ... }`), add:

```ts
      if (!config.agent["harness-redteam"]) {
        config.agent["harness-redteam"] = {
          description: "Adversarial reviewer. Challenges refiner-proposed harness ops for counter-evidence, scope, and grounding.",
          mode: "subagent",
          model: pluginOptions.model || undefined,
          permission: { edit: "deny", bash: "deny" } as unknown as Record<string, unknown>,
          prompt: "You are the adversary for the opencode Continual Harness. Given a set of proposed harness ops (memory/spec writes or deletes) and the full evidence summary, challenge each one: find counter-evidence in the full harness store, question scope, demand the evidence supports the claim, flag over-generalization and single-session memories, and recommend accept/revise/reject per op. You never edit files directly; you only report challenges.",
        };
      }
```

- [ ] **Step 3: Write a unit test for the agent registration**

Append to `opencode-harness/test/plugin.test.ts`:

```ts
test("HarnessPlugin registers the harness-redteam adversarial reviewer", async () => {
  const hooks = await HarnessPlugin({ directory: process.cwd() } as any);
  const config: any = { command: {}, agent: {} };
  await hooks.config?.(config);
  expect(config.agent["harness-redteam"]).toBeDefined();
  expect(config.agent["harness-redteam"].mode).toBe("subagent");
  expect(config.agent["harness-redteam"].permission.edit).toBe("deny");
  expect(config.agent["harness-redteam"].permission.bash).toBe("deny");
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `/home/developer/.eigent/bin/bun test test/plugin.test.ts 2>&1 | tail -8`

Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `/home/developer/.eigent/bin/bun test 2>&1 | tail -8`

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add opencode-harness/assets/agents/redteam.md opencode-harness/src/plugin.ts opencode-harness/test/plugin.test.ts
git commit -m "feat(plugin): harness-redteam adversarial reviewer agent"
```

---

### Task 5: Update the `harness-refine` skill (both copies)

**Files:**
- Modify: `skills/harness-refine/SKILL.md`
- Modify: `opencode-harness/assets/skills/harness-refine/SKILL.md`

**Interfaces:**
- Consumes: the `harness_audit` tool (Task 3) and `harness-redteam` agent (Task 4).
- Produces: the workflow the refiner follows at runtime. Both files must be byte-identical.

- [ ] **Step 1: Rewrite the workflow section of `skills/harness-refine/SKILL.md`**

Replace the `## Workflow` list and `## Rules` in `skills/harness-refine/SKILL.md` with:

```markdown
## Workflow

1. Call `harness_status` to see current state.
2. Call `harness_refine` with an optional `focus` to gather recent evidence and recommendations.
3. Score candidate improvements on: frequency, cost, risk, stability, existing coverage (use the rubric from the session trajectory).
4. For each strong candidate (score >= 0.6), draft the concrete op you would apply.
5. **Red-team your proposals**: dispatch the `harness-redteam` subagent via the task tool with your drafted ops and the full evidence summary. Incorporate its accept/revise/reject feedback — revise or drop ops it challenges. (If subagent dispatch is unavailable in this session, load the red-team prompt yourself and challenge each op adversarially before continuing.)
6. **Audit before apply**: call `harness_audit` with your (possibly revised) ops. Only proceed to apply ops that PASS. Treat warnings as guidance — address them by adjusting confidence or evidence refs where possible.
7. Apply the passing ops with `harness_apply`:
   - `memory` — durable lesson with exact body and evidence reference.
   - `spec` — updated skill/subagent/team description.
   - `delete` — a memory/spec that proved wrong or is superseded.
8. **Verify after apply**: read the returned `verified` list. A `verified: false` entry means the write did not land or did not parse — roll back to the returned snapshot id with `harness_rollback <snapshotID>` and report the failure.
9. For brand-new skills or agents: only create them if repeated friction clearly justifies it. Prefer updating existing memories/specs first.
10. If no candidate is strong, report "No change recommended" and stop.

## Rules

- Never rewrite the base system prompt.
- Every `harness_apply` snapshots automatically; verify the returned snapshot id.
- Never apply an op that `harness_audit` marked FAIL — the gate is enforced in code, so a FAIL op will be rejected by `harness_apply` anyway; treat the audit result as authoritative.
- If `harness_apply` returns `rejected` entries, do not retry them unchanged; revise them to address the reasons.
- Prefer small, focused edits over sweeping changes.
- Ask the user before creating new skills or agents (unless they already approved the refine run).
- Do not manufacture improvements; weak evidence means no change.
```

- [ ] **Step 2: Mirror the change to the shipped copy**

Copy the file over:

```bash
cp skills/harness-refine/SKILL.md opencode-harness/assets/skills/harness-refine/SKILL.md
```

- [ ] **Step 3: Verify both copies are identical**

Run: `diff skills/harness-refine/SKILL.md opencode-harness/assets/skills/harness-refine/SKILL.md`

Expected: no output (identical).

- [ ] **Step 4: Commit**

```bash
git add skills/harness-refine/SKILL.md opencode-harness/assets/skills/harness-refine/SKILL.md
git commit -m "feat(skill): harness-refine workflow gains red-team, audit-before-apply, verify-after-rollback"
```

---

### Task 6: Update the `harness_refine` tool prompt

**Files:**
- Modify: `opencode-harness/src/plugin.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: updated guidance text in the `harness_refine` tool's `execute` return string, instructing the refiner to run the audit before applying.

- [ ] **Step 1: Update the tool prompt**

In `opencode-harness/src/plugin.ts`, find the `harness_refine` tool's `execute` return string (currently ends with "...Otherwise report 'No change recommended'."). Replace the final sentence `Otherwise report 'No change recommended'.` with:

```ts
          return `## Harness evidence (recent)\n${gatherEvidenceSummary(global, focus, directory)}\n\n## Current state\n${JSON.stringify(loadMergedState(global, project), null, 2)}\n\nAssess candidates on frequency, cost, risk, stability, and existing coverage. If a candidate scores strong (>=0.6), propose it via harness_apply with kind=memory|spec|delete (use specKind=skill|subagent|team for spec writes), scope=global for cross-project or scope=project for this repo, and the exact body. For team specs, use the fixed body shape (Pattern/Task type/Roles/Coordination/Use when) and consult the harness-refine skill's pattern reference. For new skills/agents/teams, only if repeated friction justifies it. IMPORTANT: before applying, run the full harness-refine workflow — dispatch the harness-redteam subagent to challenge your ops, then call harness_audit on the draft ops and fix any FAIL or addressed warnings. Otherwise report 'No change recommended'.`;
```

- [ ] **Step 2: Run the full suite to confirm nothing broke**

Run: `/home/developer/.eigent/bin/bun test 2>&1 | tail -8`

Expected: all pass.

- [ ] **Step 3: Commit**

```bash
git add opencode-harness/src/plugin.ts
git commit -m "feat(plugin): harness_refine prompt directs refiner to red-team and audit before apply"
```

---

### Task 7: Rebuild the bundle, update README, final verification

**Files:**
- Modify: `.opencode/plugins/harness.js` (rebuilt from source)
- Modify: `README.md`

**Interfaces:**
- Consumes: all source changes (Tasks 1-6).
- Produces: the shippable bundle artifact and documentation.

- [ ] **Step 1: Rebuild the bundle**

Run (from `opencode-harness/`):

```bash
/home/developer/.eigent/bin/bun run build
```

Expected output: `Built dist/harness.js`.

- [ ] **Step 2: Copy the built bundle into the shipped plugins dir**

Run:

```bash
cp opencode-harness/dist/harness.js .opencode/plugins/harness.js
```

Verify with: `ls -la .opencode/plugins/harness.js opencode-harness/dist/harness.js` — same size.

- [ ] **Step 3: Update README.md**

Append to the "Choose the model the plugin's work uses" section (or add a new `### Audit and red teaming` section before `---` at line 149) in `README.md`:

```markdown
### Audit and red teaming

Every refine run now verifies before it trusts:

- **`harness_audit`** — validates proposed memory/spec ops against ground truth
  before they are applied: evidence grounding, body structure, name-conflict and
  scope consistency, plus adversarial checks (single-session over-generalization,
  contested evidence, high-confidence contradictions). Read-only.
- **Enforced gate** — `harness_apply` refuses ops the audit rejects, applies the
  valid subset, read-back verifies each write, and returns the snapshot id so a
  failed write can be rolled back with `harness_rollback`.
- **`harness-redteam`** — an adversarial reviewer subagent that challenges the
  refiner's proposals (counter-evidence, scope, grounding) before the audit gate.

The `harness-refine` skill workflow is: propose ops -> red-team -> `harness_audit`
-> apply passing ops -> verify after apply (roll back on read-back failure).
```

- [ ] **Step 4: Full test suite + build verification**

Run: `/home/developer/.eigent/bin/bun test 2>&1 | tail -8`

Expected: all pass (79 existing + 16 `validateOps` + 5 `applyOps` integration + 2 new plugin tests ≈ 102 total; exact count depends on test totals).

Run: `/home/developer/.eigent/bin/bun run build` — succeeds.

- [ ] **Step 5: Manual smoke (negative test)**

Run the audit tool directly through a scratch script to confirm the gate catches a fabricated op:

```bash
node --input-type=module -e "
import fs from 'fs';
const bundle = fs.readFileSync('.opencode/plugins/harness.js', 'utf8');
console.log('bundle contains harness_audit:', bundle.includes('harness_audit'));
console.log('bundle contains harness-redteam:', bundle.includes('harness-redteam'));
console.log('bundle contains validateOps:', bundle.includes('validateOps'));
"
```

Expected: all three print `true`.

- [ ] **Step 6: Commit**

```bash
git add .opencode/plugins/harness.js README.md
git commit -m "build: rebuild harness bundle with audit + red-team; document audit and red teaming"
```

- [ ] **Step 7: Push**

```bash
git push origin main
```

---

## Self-Review Notes

- **Spec coverage**: gate-before (Task 2/3) + verify-after (Task 2 read-back + rollback via snapshot) ✓; evidence grounding, body structure, name conflict, scope consistency, read-back (Task 1 checks 1-5) ✓; red teaming programmatic (Task 1 single-session/counter-evidence/high-confidence) ✓; separate adversarial reviewer (Task 4) ✓; skill workflow both copies (Task 5) ✓; harness_refine prompt (Task 6) ✓; build/ship/README (Task 7) ✓.
- **Open item resolved**: refiner dispatch of `harness-redteam` via `task` — the refiner sets no `tools` map, so subagent dispatch is permitted by default in opencode; the skill includes an inline fallback (Task 5) and Task 6's prompt directs the refiner through the full workflow. Runtime verification step is the manual smoke in Task 7.
- **Type consistency**: `OpVerdict`/`validateOps`/`evidenceRefMatches` defined Task 1, used Tasks 2-3; `ApplyResult`/`RejectedOp`/`VerifiedWrite` defined Task 2, used Task 5 (verify-after) and Task 3/6 wording; agent id `harness-redteam` consistent across Tasks 4-6.
