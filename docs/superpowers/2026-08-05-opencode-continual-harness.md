# Continual Harness for OpenCode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a global opencode plugin that makes the agent self-improve over time — continuous evidence capture, durable versioned state, injection into sessions, and an evidence-backed `/refine` loop with snapshot/rollback — adapted from prime-agent's Continual Harness.

**Architecture:** A single bundled plugin file in `~/.config/opencode/plugins/` (opencode only loads top-level files there). The plugin wires hooks (`tool.execute.after`, `event`, `experimental.chat.system.transform`, `experimental.session.compacting`) and custom tools (`harness_refine`, `harness_apply`, `harness_status`, `harness_history`, `harness_rollback`). All persistence lives in a global `~/.config/opencode/harness/` plus per-project `.opencode/harness/`. Pure logic is developed as focused modules in `opencode-harness/src/`, tested with `bun test`, then bundled with `bun build` and installed into the config dir.

**Tech Stack:** TypeScript, Bun 1.3.9 (build + test), `@opencode-ai/plugin` (external at runtime, already installed in the config dir), Node builtins (`fs`, `path`, `os`).

## Global Constraints

- Plugin must be a single bundled JS file at `~/.config/opencode/plugins/harness.js` (opencode loads `{plugin,plugins}/*.{ts,js}`, top-level only, no recursion).
- Keep `@opencode-ai/plugin` external in the bundle; it resolves at runtime from `~/.config/opencode/node_modules`.
- Windows host (win32): all file I/O via Node `fs`/`path`; no shell dependence; always use `path.join`.
- Harness never rewrites the base system prompt — only appends supplemental state.
- All asset writes require user approval; the plugin itself never auto-writes memories/specs.
- Evidence entries are truncated (`args` ≤ 200 chars, `output` ≤ 500 chars) and capped (max 25 entries per session).
- Commits are required after each task. Use `rtk` prefix for all git commands.

**File map (target layout after install):**
```
~/.config/opencode/
├── plugins/harness.js                  # built single-file plugin (from opencode-harness/dist/)
├── skills/harness-refine/SKILL.md      # refine workflow skill
├── commands/refine.md                  # /refine command
├── commands/harness.md                 # /harness command (status|history|rollback)
├── agents/refiner.md                   # refiner subagent
└── harness/                            # GLOBAL state (created at runtime)
    ├── evidence.jsonl
    ├── state.json
    ├── memories/*.md
    ├── specs/*.md
    └── reflections/<ts>/               # snapshot per apply
```
Per-project state: `.opencode/harness/` in each repo (same layout).

**Source tree (developed in this repo):**
```
opencode-harness/
├── package.json
├── tsconfig.json
├── src/
│   ├── paths.ts        # harness dir resolution
│   ├── store.ts        # evidence/memory/spec/state/reflections persistence
│   ├── scoring.ts      # candidate scoring rubric (pure)
│   ├── inject.ts       # injection + compaction text builders (pure)
│   ├── refine.ts       # refine context gathering + apply ops (needs client + fs)
│   └── plugin.ts       # HarnessPlugin entry: hooks + tools
├── test/
│   ├── helpers.ts      # tmpDir helper
│   ├── store.test.ts
│   ├── scoring.test.ts
│   └── inject.test.ts
├── assets/
│   ├── skills/harness-refine/SKILL.md
│   ├── commands/refine.md
│   ├── commands/harness.md
│   └── agents/refiner.md
├── scripts/
│   ├── build.ts        # bun build -> dist/harness.js
│   └── install.ts      # copy dist + assets into ~/.config/opencode
└── dist/harness.js     # build output (gitignored)
```

---

### Task 1: Scaffold package + paths module

**Files:**
- Create: `opencode-harness/package.json`
- Create: `opencode-harness/tsconfig.json`
- Create: `opencode-harness/src/paths.ts`
- Create: `opencode-harness/test/helpers.ts`
- Test: `opencode-harness/test/paths.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `paths.ts` exports:
  - `globalHarnessDir(): string`
  - `projectHarnessDir(worktreeOrDir: string): string`
  - `ensureDir(dir: string): string`

- [ ] **Step 1: Write the failing test**

`opencode-harness/test/paths.test.ts`:
```ts
import { expect, test } from "bun:test";
import path from "path";
import os from "os";
import { globalHarnessDir, projectHarnessDir } from "../src/paths";

test("globalHarnessDir points under config dir", () => {
  const dir = globalHarnessDir();
  expect(dir.endsWith(path.join(".config", "opencode", "harness"))).toBe(true);
  expect(path.isAbsolute(dir)).toBe(true);
});

test("projectHarnessDir nests under worktree", () => {
  const dir = projectHarnessDir("C:\\proj\\myrepo");
  expect(dir.endsWith(path.join("myrepo", ".opencode", "harness"))).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test opencode-harness/test/paths.test.ts`
Expected: FAIL — module `../src/paths` not found.

- [ ] **Step 3: Create package scaffolding**

`opencode-harness/package.json`:
```json
{
  "name": "opencode-harness",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "test": "bun test",
    "build": "bun run scripts/build.ts",
    "install:harness": "bun run scripts/install.ts"
  },
  "devDependencies": {
    "@opencode-ai/plugin": "1.14.19",
    "@types/node": "^22.0.0",
    "bun-types": "^1.3.0",
    "typescript": "^5.6.0"
  }
}
```

`opencode-harness/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "types": ["bun-types"],
    "noEmit": true
  },
  "include": ["src", "test", "scripts"]
}
```

- [ ] **Step 4: Write minimal implementation**

`opencode-harness/src/paths.ts`:
```ts
import path from "path";
import os from "os";
import fs from "fs";

export function globalHarnessDir(): string {
  return path.join(os.homedir(), ".config", "opencode", "harness");
}

export function projectHarnessDir(worktreeOrDir: string): string {
  return path.join(worktreeOrDir, ".opencode", "harness");
}

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test opencode-harness/test/paths.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
rtk git add opencode-harness
rtk git commit -m "feat(harness): scaffold package with paths module"
```

---

### Task 2: Evidence store

**Files:**
- Create: `opencode-harness/src/store.ts`
- Create: `opencode-harness/test/helpers.ts`
- Test: `opencode-harness/test/evidence.test.ts`

**Interfaces:**
- Consumes: `paths.ts` → `ensureDir`.
- Produces (from `store.ts`, used by later tasks):
  - `type EvidenceEntry = { ts: string; sessionID: string; kind: "tool_failure" | "retry" | "session_error" | "session_idle" | "session_created"; tool?: string; args?: string; output?: string; project?: string; }`
  - `appendEvidence(dir: string, entry: EvidenceEntry): void`
  - `readEvidence(dir: string): EvidenceEntry[]`
  - `evidenceCountForSession(dir: string, sessionID: string): number`
  - `const TRUNCATE_ARGS = 200`, `const TRUNCATE_OUTPUT = 500`, `const MAX_PER_SESSION = 25`

- [ ] **Step 1: Write the failing test**

`opencode-harness/test/helpers.ts`:
```ts
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

export function tmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "harness-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
```

`opencode-harness/test/evidence.test.ts`:
```ts
import { expect, test } from "bun:test";
import { appendEvidence, readEvidence, evidenceCountForSession } from "../src/store";
import { tmpDir } from "./helpers";

test("appendEvidence writes a JSONL entry and is readable", () => {
  const { dir, cleanup } = tmpDir();
  try {
    appendEvidence(dir, { ts: "2026-08-05T00:00:00.000Z", sessionID: "s1", kind: "tool_failure", tool: "bash", args: "npm run build", output: "Error: failed" });
    const rows = readEvidence(dir);
    expect(rows.length).toBe(1);
    expect(rows[0].tool).toBe("bash");
    expect(rows[0].output).toContain("Error");
  } finally { cleanup(); }
});

test("consecutive duplicate evidence entries are deduped", () => {
  const { dir, cleanup } = tmpDir();
  try {
    const entry = { ts: "2026-08-05T00:00:00.000Z", sessionID: "s1", kind: "tool_failure" as const, tool: "bash", args: "x", output: "boom" };
    appendEvidence(dir, entry);
    appendEvidence(dir, entry);
    expect(readEvidence(dir).length).toBe(1);
  } finally { cleanup(); }
});

test("evidence is capped at MAX_PER_SESSION per session", () => {
  const { dir, cleanup } = tmpDir();
  try {
    for (let i = 0; i < 30; i++) {
      appendEvidence(dir, { ts: `2026-08-05T00:00:00.00${i}Z`, sessionID: "s1", kind: "tool_failure", tool: "bash", args: `cmd ${i}` });
    }
    expect(evidenceCountForSession(dir, "s1")).toBe(25);
  } finally { cleanup(); }
});

test("truncation of args and output", () => {
  const { dir, cleanup } = tmpDir();
  try {
    appendEvidence(dir, { ts: "2026-08-05T00:00:00.000Z", sessionID: "s1", kind: "tool_failure", tool: "bash", args: "a".repeat(500), output: "o".repeat(1000) });
    const [row] = readEvidence(dir);
    expect(row.args!.length).toBeLessThanOrEqual(200);
    expect(row.output!.length).toBeLessThanOrEqual(500);
  } finally { cleanup(); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test opencode-harness/test/evidence.test.ts`
Expected: FAIL — module `../src/store` not found.

- [ ] **Step 3: Implement evidence store in store.ts**

`opencode-harness/src/store.ts`:
```ts
import fs from "fs";
import path from "path";
import { ensureDir } from "./paths";

export const TRUNCATE_ARGS = 200;
export const TRUNCATE_OUTPUT = 500;
export const MAX_PER_SESSION = 25;

export type EvidenceEntry = {
  ts: string;
  sessionID: string;
  kind: "tool_failure" | "retry" | "session_error" | "session_idle" | "session_created";
  tool?: string;
  args?: string;
  output?: string;
  project?: string;
};

function truncate(s: string | undefined, max: number): string | undefined {
  if (s === undefined) return undefined;
  return s.length <= max ? s : s.slice(0, max);
}

export function evidenceFile(dir: string): string {
  return path.join(dir, "evidence.jsonl");
}

export function appendEvidence(dir: string, entry: EvidenceEntry): void {
  ensureDir(dir);
  const file = evidenceFile(dir);
  const normalized: EvidenceEntry = {
    ...entry,
    args: truncate(entry.args, TRUNCATE_ARGS),
    output: truncate(entry.output, TRUNCATE_OUTPUT),
  };
  const rows = readEvidence(dir);
  const last = rows[rows.length - 1];
  if (last && last.sessionID === entry.sessionID && last.tool === entry.tool && last.args === normalized.args && last.output === normalized.output) {
    return;
  }
  const sessionRows = rows.filter((r) => r.sessionID === entry.sessionID);
  const rowsToKeep = sessionRows.length >= MAX_PER_SESSION ? rows.filter((r) => r.sessionID !== entry.sessionID).concat(sessionRows.slice(sessionRows.length - (MAX_PER_SESSION - 1))) : rows;
  fs.writeFileSync(file, rowsToKeep.map((r) => JSON.stringify(r)).concat([JSON.stringify(normalized)]).join("\n") + "\n", "utf8");
}

export function readEvidence(dir: string): EvidenceEntry[] {
  const file = evidenceFile(dir);
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim().length > 0);
  const rows: EvidenceEntry[] = [];
  for (const line of lines) {
    try {
      rows.push(JSON.parse(line) as EvidenceEntry);
    } catch {
      // skip corrupt lines
    }
  }
  return rows;
}

export function evidenceCountForSession(dir: string, sessionID: string): number {
  return readEvidence(dir).filter((r) => r.sessionID === sessionID).length;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test opencode-harness/test/evidence.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
rtk git add opencode-harness
rtk git commit -m "feat(harness): evidence store with dedup, truncation, and per-session cap"
```

---

### Task 3: Memory/spec store, state compile, snapshot/rollback

**Files:**
- Modify: `opencode-harness/src/store.ts` (append below existing content)
- Test: `opencode-harness/test/state.test.ts`

**Interfaces:**
- Consumes: `store.ts` evidence functions from Task 2.
- Produces (from `store.ts`):
  - `type Memory = { name: string; scope: "global" | "project"; confidence: number; created: string; updated: string; evidence: string[]; body: string; }`
  - `type Spec = { name: string; kind: "skill" | "subagent"; scope: "global" | "project"; confidence: number; updated: string; evidence: string[]; body: string; }`
  - `type HarnessState = { version: number; updated: string; memories: Memory[]; specs: Spec[]; }`
  - `writeMemory(dir: string, memory: Memory): void`
  - `writeSpec(dir: string, spec: Spec): void`
  - `listMemories(dir: string): Memory[]`
  - `listSpecs(dir: string): Spec[]`
  - `deleteEntry(dir: string, kind: "memory" | "spec", name: string): void`
  - `loadState(dir: string): HarnessState` (recompiles from memory/spec files each call)
  - `snapshot(dir: string): string` (returns id like `2026-08-05T00-00-00-000Z`)
  - `listSnapshots(dir: string): string[]`
  - `rollback(dir: string, id: string): void`

- [ ] **Step 1: Write the failing test**

`opencode-harness/test/state.test.ts`:
```ts
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

test("loadState compiles memories and specs", () => {
  const { dir, cleanup } = tmpDir();
  try {
    writeMemory(dir, { name: "m1", scope: "global", confidence: 0.7, created: "t", updated: "t", evidence: [], body: "body m1" });
    writeSpec(dir, { name: "s1", kind: "skill", scope: "global", confidence: 0.6, updated: "t", evidence: [], body: "body s1" });
    const state = loadState(dir);
    expect(state.memories.length).toBe(1);
    expect(state.specs.length).toBe(1);
    expect(state.specs[0].kind).toBe("skill");
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test opencode-harness/test/state.test.ts`
Expected: FAIL — `writeMemory` not exported.

- [ ] **Step 3: Implement memory/spec/state/reflections in store.ts**

Append to `opencode-harness/src/store.ts`:
```ts
export type Memory = {
  name: string;
  scope: "global" | "project";
  confidence: number;
  created: string;
  updated: string;
  evidence: string[];
  body: string;
};

export type Spec = {
  name: string;
  kind: "skill" | "subagent";
  scope: "global" | "project";
  confidence: number;
  updated: string;
  evidence: string[];
  body: string;
};

export type HarnessState = {
  version: number;
  updated: string;
  memories: Memory[];
  specs: Spec[];
};

function writeFrontmatter(fields: Record<string, string>, body: string): string {
  const fm = Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join("\n");
  return `---\n${fm}\n---\n${body}`;
}

function parseFrontmatter(content: string): { fields: Record<string, string>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { fields: {}, body: content };
  const fields: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) fields[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return { fields, body: match[2] };
}

function entryPath(dir: string, kind: "memory" | "spec", name: string): string {
  return path.join(dir, kind === "memory" ? "memories" : "specs", `${name}.md`);
}

function listFiles(dir: string, sub: string): string[] {
  const full = path.join(dir, sub);
  if (!fs.existsSync(full)) return [];
  return fs.readdirSync(full).filter((f) => f.endsWith(".md")).map((f) => path.join(full, f));
}

export function writeMemory(dir: string, memory: Memory): void {
  ensureDir(dir);
  ensureDir(path.join(dir, "memories"));
  fs.writeFileSync(entryPath(dir, "memory", memory.name), writeFrontmatter(
    { name: memory.name, scope: memory.scope, confidence: String(memory.confidence), created: memory.created, updated: memory.updated, evidence: memory.evidence.join(",") },
    memory.body
  ), "utf8");
}

export function writeSpec(dir: string, spec: Spec): void {
  ensureDir(dir);
  ensureDir(path.join(dir, "specs"));
  fs.writeFileSync(entryPath(dir, "spec", spec.name), writeFrontmatter(
    { name: spec.name, kind: spec.kind, scope: spec.scope, confidence: String(spec.confidence), updated: spec.updated, evidence: spec.evidence.join(",") },
    spec.body
  ), "utf8");
}

export function listMemories(dir: string): Memory[] {
  return listFiles(dir, "memories").map((f) => {
    const { fields, body } = parseFrontmatter(fs.readFileSync(f, "utf8"));
    return {
      name: fields.name ?? path.basename(f, ".md"),
      scope: (fields.scope === "project" ? "project" : "global") as "global" | "project",
      confidence: Number(fields.confidence ?? 0.5),
      created: fields.created ?? "",
      updated: fields.updated ?? "",
      evidence: (fields.evidence ?? "").split(",").filter(Boolean),
      body: body.trim(),
    };
  });
}

export function listSpecs(dir: string): Spec[] {
  return listFiles(dir, "specs").map((f) => {
    const { fields, body } = parseFrontmatter(fs.readFileSync(f, "utf8"));
    return {
      name: fields.name ?? path.basename(f, ".md"),
      kind: (fields.kind === "subagent" ? "subagent" : "skill") as "skill" | "subagent",
      scope: (fields.scope === "project" ? "project" : "global") as "global" | "project",
      confidence: Number(fields.confidence ?? 0.5),
      updated: fields.updated ?? "",
      evidence: (fields.evidence ?? "").split(",").filter(Boolean),
      body: body.trim(),
    };
  });
}

export function deleteEntry(dir: string, kind: "memory" | "spec", name: string): void {
  const file = entryPath(dir, kind, name);
  if (fs.existsSync(file)) fs.rmSync(file);
}

export function loadState(dir: string): HarnessState {
  return {
    version: 1,
    updated: new Date().toISOString(),
    memories: listMemories(dir),
    specs: listSpecs(dir),
  };
}

function reflectionsDir(dir: string): string {
  return path.join(dir, "reflections");
}

export function snapshot(dir: string): string {
  const id = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = path.join(reflectionsDir(dir), id);
  ensureDir(dest);
  for (const [sub, kind] of [["memories", "memory"], ["specs", "spec"]] as const) {
    for (const f of listFiles(dir, sub)) {
      ensureDir(path.join(dest, sub));
      fs.copyFileSync(f, path.join(dest, sub, path.basename(f)));
    }
  }
  return id;
}

export function listSnapshots(dir: string): string[] {
  const full = reflectionsDir(dir);
  if (!fs.existsSync(full)) return [];
  return fs.readdirSync(full).sort();
}

export function rollback(dir: string, id: string): void {
  const src = path.join(reflectionsDir(dir), id);
  if (!fs.existsSync(src)) throw new Error(`Snapshot not found: ${id}`);
  for (const [sub] of [["memories"], ["specs"]] as const) {
    const srcSub = path.join(src, sub);
    const destSub = path.join(dir, sub);
    ensureDir(destSub);
    for (const f of fs.readdirSync(destSub)) {
      fs.rmSync(path.join(destSub, f));
    }
    if (!fs.existsSync(srcSub)) continue;
    for (const f of fs.readdirSync(srcSub)) {
      fs.copyFileSync(path.join(srcSub, f), path.join(destSub, f));
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test opencode-harness/test/state.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
rtk git add opencode-harness
rtk git commit -m "feat(harness): memory/spec store with state compile and snapshot rollback"
```

---

### Task 4: Scoring rubric

**Files:**
- Create: `opencode-harness/src/scoring.ts`
- Test: `opencode-harness/test/scoring.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type CandidateScore = { frequency: number; cost: number; risk: number; stability: number; covered: number; }`
  - `scoreCandidate(c: CandidateScore): number` (weighted, 0..1)
  - `shouldRecommend(score: number): boolean` (threshold ≥ 0.6)
  - `scoreLabel(score: number): "strong" | "moderate" | "weak"`

- [ ] **Step 1: Write the failing test**

`opencode-harness/test/scoring.test.ts`:
```ts
import { expect, test } from "bun:test";
import { scoreCandidate, shouldRecommend, scoreLabel } from "../src/scoring";

test("high-frequency, costly, uncovered candidate scores strong", () => {
  const s = scoreCandidate({ frequency: 0.9, cost: 0.8, risk: 0.6, stability: 0.9, covered: 0 });
  expect(s).toBeGreaterThanOrEqual(0.6);
  expect(shouldRecommend(s)).toBe(true);
  expect(scoreLabel(s)).toBe("strong");
});

test("isolated one-off candidate scores weak", () => {
  const s = scoreCandidate({ frequency: 0.1, cost: 0.2, risk: 0.1, stability: 0.3, covered: 0.5 });
  expect(s).toBeLessThan(0.6);
  expect(shouldRecommend(s)).toBe(false);
  expect(scoreLabel(s)).toBe("weak");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test opencode-harness/test/scoring.test.ts`
Expected: FAIL — module `../src/scoring` not found.

- [ ] **Step 3: Implement scoring module**

`opencode-harness/src/scoring.ts`:
```ts
export type CandidateScore = {
  frequency: number;
  cost: number;
  risk: number;
  stability: number;
  covered: number;
};

const WEIGHTS = { frequency: 0.3, cost: 0.2, risk: 0.15, stability: 0.2, uncovered: 0.15 };
const THRESHOLD = 0.6;

export function scoreCandidate(c: CandidateScore): number {
  const raw = c.frequency * WEIGHTS.frequency + c.cost * WEIGHTS.cost + c.risk * WEIGHTS.risk + c.stability * WEIGHTS.stability + (1 - c.covered) * WEIGHTS.uncovered;
  return Math.min(1, Math.max(0, raw));
}

export function shouldRecommend(score: number): boolean {
  return score >= THRESHOLD;
}

export function scoreLabel(score: number): "strong" | "moderate" | "weak" {
  if (score >= 0.8) return "strong";
  if (score >= THRESHOLD) return "moderate";
  return "weak";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test opencode-harness/test/scoring.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
rtk git add opencode-harness
rtk git commit -m "feat(harness): candidate scoring rubric"
```

---

### Task 5: Injection builders

**Files:**
- Create: `opencode-harness/src/inject.ts`
- Test: `opencode-harness/test/inject.test.ts`

**Interfaces:**
- Consumes: `store.ts` → `HarnessState`.
- Produces:
  - `buildInjection(state: HarnessState, scope: "global" | "project", maxEntries?: number): string`
  - `buildCompactionContext(state: HarnessState, scope: "global" | "project"): string[]`
  - `filterByScope(state: HarnessState, scope: "global" | "project"): HarnessState`

- [ ] **Step 1: Write the failing test**

`opencode-harness/test/inject.test.ts`:
```ts
import { expect, test } from "bun:test";
import { buildInjection, buildCompactionContext, filterByScope } from "../src/inject";
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
  expect(inj).toContain("Run build before edit.");
  expect(inj).not.toContain("Project quirk.");
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test opencode-harness/test/inject.test.ts`
Expected: FAIL — module `../src/inject` not found.

- [ ] **Step 3: Implement injection module**

`opencode-harness/src/inject.ts`:
```ts
import type { HarnessState } from "./store";

export function filterByScope(state: HarnessState, scope: "global" | "project"): HarnessState {
  return {
    ...state,
    memories: state.memories.filter((m) => m.scope === scope || m.scope === "global"),
    specs: state.specs.filter((s) => s.scope === scope || s.scope === "global"),
  };
}

export function buildInjection(state: HarnessState, scope: "global" | "project", maxEntries = 8): string {
  const filtered = filterByScope(state, scope);
  const memories = [...filtered.memories].sort((a, b) => b.confidence - a.confidence).slice(0, maxEntries);
  if (memories.length === 0) return "";
  const lines = memories.map((m) => `- ${m.body}`).join("\n");
  return `<harness-memories scope="${scope}">\n${lines}\n</harness-memories>`;
}

export function buildCompactionContext(state: HarnessState, scope: "global" | "project"): string[] {
  const filtered = filterByScope(state, scope);
  const parts: string[] = [];
  if (filtered.memories.length > 0) {
    parts.push(`## Harness memories\n${filtered.memories.map((m) => `- ${m.body}`).join("\n")}`);
  }
  if (filtered.specs.length > 0) {
    parts.push(`## Harness specs\n${filtered.specs.map((s) => `- ${s.name}: ${s.body}`).join("\n")}`);
  }
  return parts;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test opencode-harness/test/inject.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
rtk git add opencode-harness
rtk git commit -m "feat(harness): injection and compaction context builders"
```

---

### Task 6: Refine engine (context gathering + apply ops)

**Files:**
- Create: `opencode-harness/src/refine.ts`
- Test: `opencode-harness/test/refine.test.ts`

**Interfaces:**
- Consumes: `store.ts` (`readEvidence`, `loadState`, `writeMemory`, `writeSpec`, `deleteEntry`, `snapshot`, `rollback`), `scoring.ts` (`scoreCandidate`, `shouldRecommend`, `scoreLabel`).
- Produces:
  - `type RefineOp = { op: "memory" | "spec" | "delete"; kind: "memory" | "spec"; specKind?: "skill" | "subagent"; name: string; scope: "global" | "project"; body: string; confidence?: number; evidence?: string[]; }`
  - `gatherEvidenceSummary(dir: string, focus?: string): string` (markdown summary of recent evidence)
  - `applyOps(dir: string, ops: RefineOp[]): { snapshotID: string; applied: string[] }` (snapshots once, applies all ops). `op.kind === "spec"` writes a `Spec` whose `kind` is `op.specKind ?? "skill"`.

- [ ] **Step 1: Write the failing test**

`opencode-harness/test/refine.test.ts`:
```ts
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

test("gatherEvidenceSummary renders recent evidence", () => {
  const { dir, cleanup } = tmpDir();
  try {
    appendEvidence(dir, { ts: "2026-08-05T00:00:00.000Z", sessionID: "s1", kind: "tool_failure", tool: "bash", args: "npm run build", output: "Error" });
    const summary = gatherEvidenceSummary(dir);
    expect(summary).toContain("tool_failure");
    expect(summary).toContain("npm run build");
  } finally { cleanup(); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test opencode-harness/test/refine.test.ts`
Expected: FAIL — module `../src/refine` not found.

- [ ] **Step 3: Implement refine engine**

`opencode-harness/src/refine.ts`:
```ts
import { readEvidence, loadState, writeMemory, writeSpec, deleteEntry, snapshot, type Memory, type Spec } from "./store";

export type RefineOp = {
  op: "memory" | "spec" | "delete";
  kind: "memory" | "spec";
  specKind?: "skill" | "subagent";
  name: string;
  scope: "global" | "project";
  body: string;
  confidence?: number;
  evidence?: string[];
};

export function gatherEvidenceSummary(dir: string, focus?: string): string {
  const rows = readEvidence(dir).slice(-20);
  if (rows.length === 0) return "No harness evidence recorded yet.";
  const filtered = focus ? rows.filter((r) => (r.args ?? "").includes(focus) || (r.output ?? "").includes(focus)) : rows;
  const lines = (filtered.length ? filtered : rows).map((r) => {
    const target = r.tool ? `${r.tool}${r.args ? ` "${r.args}"` : ""}` : r.sessionID;
    return `- [${r.kind}] ${r.ts} ${target}${r.output ? ` :: ${r.output}` : ""}`;
  });
  return lines.join("\n");
}

export function applyOps(dir: string, ops: RefineOp[]): { snapshotID: string; applied: string[] } {
  const snapshotID = snapshot(dir);
  const now = new Date().toISOString();
  const applied: string[] = [];
  const state = loadState(dir);
  for (const op of ops) {
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
        created: state.memories.find((m) => m.name === op.name)?.created ?? now,
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
  return { snapshotID, applied };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test opencode-harness/test/refine.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
rtk git add opencode-harness
rtk git commit -m "feat(harness): refine engine with evidence summary and snapshot-first apply"
```

---

### Task 7: Plugin entry (hooks + custom tools)

**Files:**
- Create: `opencode-harness/src/plugin.ts`
- Create: `opencode-harness/test/plugin.test.ts` (tests the pure hook adapter function)

**Interfaces:**
- Consumes: `paths.ts`, `store.ts`, `scoring.ts`, `inject.ts`, `refine.ts`, and `@opencode-ai/plugin` (`tool`, `type Plugin`, `type ToolContext`).
- Produces: `export const HarnessPlugin: Plugin` — hooks:
  - `tool.execute.after` — record `tool_failure` evidence when output looks like an error; record `retry` when the same tool failed twice in a session.
  - `event` — on `session.error` write `session_error`; on `session.idle` write `session_idle`; on `session.created` write `session_created`.
  - `experimental.chat.system.transform` — append `buildInjection(loadState(global), "global")`.
  - `experimental.session.compacting` — push `buildCompactionContext(loadState(global), "global")`.
  - `tool` — five custom tools: `harness_refine`, `harness_apply`, `harness_status`, `harness_history`, `harness_rollback`.

- [ ] **Step 1: Write the failing test**

`opencode-harness/test/plugin.test.ts` — tests a pure helper extracted for testability:
```ts
import { expect, test } from "bun:test";
import { looksLikeError } from "../src/plugin";

test("looksLikeError uses the bash exit code when available", () => {
  expect(looksLikeError("npm error code ENOENT", { exit: 1 }, "bash")).toBe(true);
  expect(looksLikeError("tests passed, 0 failed", { exit: 0 }, "bash")).toBe(false);
});

test("looksLikeError treats null/absent exit code as not-a-failure for bash", () => {
  expect(looksLikeError("timeout", { exit: null }, "bash")).toBe(false);
  expect(looksLikeError("unknown", {}, "bash")).toBe(false);
  expect(looksLikeError(undefined, {}, "bash")).toBe(false);
});

test("looksLikeError never flags non-bash tool output as failure (output is content, not status)", () => {
  expect(looksLikeError("Error: Cannot find module", {}, "read")).toBe(false);
  expect(looksLikeError("session_error type definition", {}, "read")).toBe(false);
  expect(looksLikeError("tests passed, 0 failed", {}, "grep")).toBe(false);
  expect(looksLikeError("build failed", { exit: 1 }, "bash")).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test opencode-harness/test/plugin.test.ts`
Expected: FAIL — `looksLikeError` not exported.

- [ ] **Step 3: Implement the plugin**

`opencode-harness/src/plugin.ts`:
```ts
import { tool, type Plugin } from "@opencode-ai/plugin";
import fs from "fs";
import path from "path";
import { globalHarnessDir, ensureDir } from "./paths";
import { appendEvidence, loadState, readEvidence, listSnapshots, rollback } from "./store";
import { buildInjection, buildCompactionContext } from "./inject";
import { gatherEvidenceSummary, applyOps, type RefineOp } from "./refine";

export function looksLikeError(output: string | undefined, metadata?: Record<string, unknown> | null, tool?: string): boolean {
  if (tool === "bash") {
    const exit = metadata?.exit;
    return typeof exit === "number" && exit !== 0;
  }
  return false;
}

function recordSessionProject(sessionID: string, project: string): void {
  if (!project) return;
  ensureDir(globalHarnessDir());
  const file = path.join(globalHarnessDir(), "sessions.json");
  const map: Record<string, string> = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  map[sessionID] = project;
  fs.writeFileSync(file, JSON.stringify(map, null, 2), "utf8");
}

export const HarnessPlugin: Plugin = async ({ directory }) => {
  const global = globalHarnessDir();

  return {
    "tool.execute.after": async (input, output) => {
      if (input.tool === "harness_refine" || input.tool === "harness_apply") return;
      recordSessionProject(input.sessionID, directory);
      const failure = looksLikeError(output.output, output.metadata, input.tool);
      if (!failure) return;
      const rows = readEvidence(global);
      const lastSameTool = rows.filter((r) => r.sessionID === input.sessionID && r.tool === input.tool).slice(-1)[0];
      const isRetry = lastSameTool && lastSameTool.kind === "tool_failure";
      appendEvidence(global, {
        ts: new Date().toISOString(),
        sessionID: input.sessionID,
        kind: isRetry ? "retry" : "tool_failure",
        tool: input.tool,
        args: JSON.stringify(input.args ?? {}).slice(0, 200),
        output: output.output,
        project: directory,
      });
    },

    event: async ({ event }) => {
      const props = (event as { properties?: Record<string, any> }).properties ?? {};
      const id = typeof props.sessionID === "string" ? props.sessionID : (props.info as { id?: string } | undefined)?.id;
      if (!id) return;
      if (event.type === "session.error") {
        appendEvidence(global, { ts: new Date().toISOString(), sessionID: id, kind: "session_error", project: directory });
      } else if (event.type === "session.idle") {
        appendEvidence(global, { ts: new Date().toISOString(), sessionID: id, kind: "session_idle", project: directory });
      } else if (event.type === "session.created") {
        appendEvidence(global, { ts: new Date().toISOString(), sessionID: id, kind: "session_created", project: directory });
      }
    },

    "experimental.chat.system.transform": async (_input, output) => {
      const injection = buildInjection(loadState(global), "global");
      if (injection) output.system.push(injection);
    },

    "experimental.session.compacting": async (_input, output) => {
      output.context.push(...buildCompactionContext(loadState(global), "global"));
    },

    tool: {
      harness_refine: tool({
        description: "Review recent harness evidence and the current session trajectory, then recommend evidence-backed refinements (memories, spec updates, or new skills/agents). Conservative: weak evidence means no change.",
        args: {
          focus: tool.schema.string().optional().describe("Optional focus area to filter evidence."),
        },
        async execute(args) {
          const focus = (args as { focus?: string }).focus;
          return `## Harness evidence (recent)\n${gatherEvidenceSummary(global, focus)}\n\n## Current state\n${JSON.stringify(loadState(global), null, 2)}\n\nAssess candidates on frequency, cost, risk, stability, and existing coverage. If a candidate scores strong (>=0.6), propose it via harness_apply with kind=memory|spec|delete (use specKind=skill|subagent for spec writes) and the exact body. For new skills/agents, only if repeated friction justifies it. Otherwise report 'No change recommended'.`;
        },
      }),

      harness_apply: tool({
        description: "Apply concrete harness refinements. Snapshots state first; every write is rollback-able via harness_rollback.",
        args: {
          ops: tool.schema.array(tool.schema.object({
            op: tool.schema.enum(["memory", "spec", "delete"]),
            kind: tool.schema.enum(["memory", "spec"]),
            specKind: tool.schema.enum(["skill", "subagent"]).optional(),
            name: tool.schema.string(),
            scope: tool.schema.enum(["global", "project"]),
            body: tool.schema.string(),
            confidence: tool.schema.number().optional(),
            evidence: tool.schema.array(tool.schema.string()).optional(),
          })).describe("Refinement operations to apply."),
        },
        async execute(args) {
          const ops = (args as { ops: RefineOp[] }).ops;
          const { snapshotID, applied } = applyOps(global, ops);
          return `Applied ${applied.length} op(s). Snapshot: ${snapshotID}\nOps: ${applied.join(", ")}`;
        },
      }),

      harness_status: tool({
        description: "Show the current harness state: memory/spec counts, evidence totals, and snapshots.",
        args: {},
        async execute() {
          const state = loadState(global);
          const snapshots = listSnapshots(global);
          return `## Harness status\nglobal: ${global}\nmemories: ${state.memories.length}\nspecs: ${state.specs.length}\nevidence entries: ${readEvidence(global).length}\nsnapshots: ${snapshots.length}`;
        },
      }),

      harness_history: tool({
        description: "List harness snapshot ids for rollback.",
        args: {},
        async execute() {
          const snapshots = listSnapshots(global);
          return snapshots.length ? snapshots.join("\n") : "No snapshots yet.";
        },
      }),

      harness_rollback: tool({
        description: "Roll back the harness state to a previous snapshot id.",
        args: {
          id: tool.schema.string().describe("Snapshot id from harness_history."),
        },
        async execute(args) {
          const id = (args as { id: string }).id;
          try {
            rollback(global, id);
            return `Rolled back to snapshot ${id}`;
          } catch (e) {
            const avail = listSnapshots(global);
            return `Rollback failed: ${(e as Error).message}. Available: ${avail.join(", ") || "none"}`;
          }
        },
      }),
    },
  };
};
```

- [ ] **Step 4: Run tests**

Run: `bun test opencode-harness/test`
Expected: PASS — all module tests including `plugin.test.ts` (1 test).

- [ ] **Step 5: Typecheck**

Run: `bunx tsc --noEmit -p opencode-harness/tsconfig.json`
Expected: No type errors. If `ToolContext`/`tool` types mismatch the installed `@opencode-ai/plugin` version, adjust the schema calls to match `tool.schema` (zod) signatures — the `tool` helper namespace exposes zod directly.

- [ ] **Step 6: Commit**

```bash
rtk git add opencode-harness
rtk git commit -m "feat(harness): plugin entry with hooks and custom tools"
```

---

### Task 8: Assets (skill, commands, agent) + build + install scripts

**Files:**
- Create: `opencode-harness/assets/skills/harness-refine/SKILL.md`
- Create: `opencode-harness/assets/commands/refine.md`
- Create: `opencode-harness/assets/commands/harness.md`
- Create: `opencode-harness/assets/agents/refiner.md`
- Create: `opencode-harness/scripts/build.ts`
- Create: `opencode-harness/scripts/install.ts`
- Create: `opencode-harness/.gitignore`

**Interfaces:**
- Consumes: `src/plugin.ts` (build entry).
- Produces: `dist/harness.js` (bundled single file) and an install step that copies it plus assets into `~/.config/opencode/`.

- [ ] **Step 1: Write the skill asset**

`opencode-harness/assets/skills/harness-refine/SKILL.md`:
```markdown
---
name: harness-refine
description: Review harness evidence and refine durable memories, specs, or new skills/agents. Use when the user runs /refine, asks to improve the harness, or wants to learn from recent sessions.
---

# Harness Refine

You are running the opencode Continual Harness refine loop. Be conservative and evidence-driven.

## Workflow

1. Call `harness_status` to see current state.
2. Call `harness_refine` with an optional `focus` to gather recent evidence and recommendations.
3. Score candidate improvements on: frequency, cost, risk, stability, existing coverage (use the rubric from the session trajectory).
4. For each strong candidate (score >= 0.6), call `harness_apply` with a concrete op:
   - `memory` — durable lesson with exact body and evidence reference.
   - `spec` — updated skill/subagent description.
   - `delete` — a memory/spec that proved wrong or is superseded.
5. For brand-new skills or agents: only create them if repeated friction clearly justifies it. Prefer updating existing memories/specs first.
6. If no candidate is strong, report "No change recommended" and stop.

## Rules

- Never rewrite the base system prompt.
- Every `harness_apply` snapshots automatically; verify the returned snapshot id.
- Prefer small, focused edits over sweeping changes.
- Ask the user before creating new skills or agents (unless they already approved the refine run).
- Do not manufacture improvements; weak evidence means no change.
```

- [ ] **Step 2: Write the command assets**

`opencode-harness/assets/commands/refine.md`:
```markdown
---
description: Run the Continual Harness refine loop over recent evidence
agent: refiner
---

Run the harness refine workflow (load the `harness-refine` skill) and apply evidence-backed refinements. Focus: $ARGUMENTS (optional).
```

`opencode-harness/assets/commands/harness.md`:
```markdown
---
description: Inspect or manage the Continual Harness (status, history, rollback)
agent: refiner
---

Handle a harness management request using the appropriate harness tools:
- status -> `harness_status`
- history -> `harness_history`
- rollback <id> -> `harness_rollback` with id $1

Request: $ARGUMENTS
```

- [ ] **Step 3: Write the agent asset**

`opencode-harness/assets/agents/refiner.md`:
```markdown
---
description: Runs the Continual Harness refine loop and harness management tools
mode: subagent
permission:
  edit: deny
  bash: deny
  skill:
    "harness-refine": allow
---

You are the refiner for the opencode Continual Harness. You analyze evidence, apply conservative refinements via the harness_* tools, and report results. You never edit files directly.
```

- [ ] **Step 4: Write the build script**

`opencode-harness/scripts/build.ts`:
```ts
import { $ } from "bun";

await $`bun build ${import.meta.dir}/../src/plugin.ts --outfile ${import.meta.dir}/../dist/harness.js --external @opencode-ai/plugin --target node`;
console.log("Built dist/harness.js");
```

- [ ] **Step 5: Write the install script**

`opencode-harness/scripts/install.ts`:
```ts
import fs from "fs";
import path from "path";
import os from "os";
import { $ } from "bun";

const root = path.resolve(import.meta.dir, "..");
const configDir = path.join(os.homedir(), ".config", "opencode");
const dist = path.join(root, "dist", "harness.js");

if (!fs.existsSync(dist)) {
  console.error("dist/harness.js missing. Run `bun run build` first.");
  process.exit(1);
}

const copies: Array<[string, string]> = [
  [dist, path.join(configDir, "plugins", "harness.js")],
  [path.join(root, "assets", "skills", "harness-refine", "SKILL.md"), path.join(configDir, "skills", "harness-refine", "SKILL.md")],
  [path.join(root, "assets", "commands", "refine.md"), path.join(configDir, "commands", "refine.md")],
  [path.join(root, "assets", "commands", "harness.md"), path.join(configDir, "commands", "harness.md")],
  [path.join(root, "assets", "agents", "refiner.md"), path.join(configDir, "agents", "refiner.md")],
];

for (const [src, dest] of copies) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  console.log(`Installed ${dest}`);
}
console.log("Harness installed. Restart opencode to load the plugin.");
```

- [ ] **Step 6: Add .gitignore for build output**

`opencode-harness/.gitignore`:
```
dist/
node_modules/
```

- [ ] **Step 7: Build, run all tests, install**

Run: `bun install` in `opencode-harness/` (creates `bun.lock`), then:
```
rtk bun run test        # from opencode-harness/
rtk bun run build
bun run scripts/install.ts
```
Expected: all module tests PASS; `dist/harness.js` created; files copied under `~/.config/opencode/{plugins,skills,commands,agents}`.

- [ ] **Step 8: Commit**

```bash
rtk git add opencode-harness
rtk git commit -m "feat(harness): assets, build, and install scripts"
```

---

### Task 9: End-to-end verification in opencode

**Files:**
- Modify: none (verification only).

**Interfaces:**
- Consumes: the installed plugin + assets from Tasks 7–8.

- [ ] **Step 1: Restart opencode and verify plugin loads**

Run `opencode` in any repo. Expected: no plugin load errors in output/log. Verify the plugin file is picked up (opencode scans `plugins/*.js`).

- [ ] **Step 2: Verify evidence capture**

In a session, trigger a failing command (e.g., `npm run definitely-not-a-script`). Then run `/harness` → `status`. Expected: `evidence entries: >= 1` and a `tool_failure` row referencing the command appears in `~/.config/opencode/harness/evidence.jsonl`.

- [ ] **Step 3: Verify injection**

Inspect the current session's system prompt (or a fresh session) for the `<harness-memories>` block. Expected: present when memories exist, absent when none.

- [ ] **Step 4: Verify /refine + rollback**

Run `/refine`. Ask the agent to add one memory. Run `/harness` → `history`, note the snapshot id. Then run `/harness` → `rollback <id>` to a prior snapshot. Expected: memory disappears after rollback.

- [ ] **Step 5: Verify compaction context (optional, if long session)**

Confirm the `experimental.session.compacting` hook pushes harness context during a compaction (observable in the compaction prompt).

- [ ] **Step 6: Commit verification notes (if any fixes were needed)**

If verification surfaced bugs, fix them as a new task (follow TDD) and commit:
```bash
rtk git add -A
rtk git commit -m "fix(harness): resolve issues found in e2e verification"
```

---

## Self-Review

**1. Spec coverage:**
- Evidence collection (hooks) → Task 2 (store) + Task 7 (`tool.execute.after`, `event`). ✓
- Injection (system.transform + compaction) → Task 5 (builders) + Task 7 (hooks). ✓
- `/refine` loop with memories/specs/new assets → Task 6 (engine) + Task 8 (skill/command) + Task 7 (tools). ✓
- Snapshot/rollback → Task 3 (store) + Task 7 (`harness_history`/`harness_rollback`). ✓
- Global + per-project state → `paths.ts` (both dirs) + `store.ts` scope field; plugin currently injects global scope, per-project dir used for project-scoped writes. ✓
- Idle-suggest: the `event` hook records `session_idle`; the TUI toast suggestion is deferred (recorded evidence is the trigger surface) — noted as accepted simplification vs the spec's toast. ✓
- Conservative scoring / no auto-writes → Task 4 + skill rules in Task 8. ✓
- Windows-safe I/O → all Node `fs`/`path`, no shell. ✓

**2. Placeholder scan:** No TBD/TODO/"implement later". Every code step contains full code. ✓

**3. Type consistency:**
- `store.ts` types (`Memory`, `Spec`, `HarnessState`, `EvidenceEntry`, `appendEvidence`, `readEvidence`, `evidenceCountForSession`, `writeMemory`, `writeSpec`, `listMemories`, `listSpecs`, `deleteEntry`, `loadState`, `snapshot`, `listSnapshots`, `rollback`) are used identically in Tasks 3/5/6/7. ✓
- `rollback` uses clear-then-copy (true restore): it clears `memories/` and `specs/` in the target dir before copying snapshot files, so entries added after the snapshot are removed on rollback (fix applied in Task 9 verification — the original overlay-only code left ghost entries, breaking the Task 9 "memory disappears after rollback" check). ✓
- `inject.ts` exports (`buildInjection`, `buildCompactionContext`, `filterByScope`) match Task 5 definitions and Task 7 usage. ✓
- `refine.ts` exports (`gatherEvidenceSummary`, `applyOps`, `RefineOp`) match Task 6 definitions and Task 7 `harness_refine`/`harness_apply` usage. ✓
- `RefineOp` carries `specKind?: "skill" | "subagent"` for spec writes; `applyOps` uses `op.specKind ?? "skill"` so subagent specs are expressible (pre-flight fix to the original `op.scope === "subagent"` bug, which could never be true). The `harness_apply` schema exposes `specKind` with the same enum. ✓
- `looksLikeError(output, metadata, tool)` uses the authoritative bash exit code (`metadata.exit !== 0`) when `tool === "bash"`; it never text-scans non-bash tool output because that is content, not status (text heuristics produced false `tool_failure` evidence for `read`/`grep` — found by a `/refine` run and fixed). ✓
- The `event` hook extracts sessionID from `properties.sessionID` or `properties.info.id` — the latter covers `session.created`/`session.updated` events whose `Session` object lives under `properties.info` (verified against the SDK's `EventSessionCreated` type). ✓
- `scoring.ts` exports (`scoreCandidate`, `shouldRecommend`, `scoreLabel`) are defined in Task 4 and used in the skill narrative (Task 8); they are not imported by plugin.ts, so no cross-task signature drift. ✓
- `RefineOp.scope` is `"global" | "project"` everywhere; the `harness_apply` tool schema restricts `scope` to the same enum. ✓
- `harness_apply` result message uses `snapshotID` which matches `applyOps` return. ✓

Note for the implementer: `@opencode-ai/plugin` is external in the bundle and resolves at runtime from `~/.config/opencode/node_modules` (version 1.14.19 is installed there). If `tool.schema` signature differs at that version, adapt the schema definitions to the actual zod namespace exposed by `tool`.
