# OpenCode Harness Self-Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Continual Harness self-maintaining: (A) auto-refine on session end when enough new evidence exists, and (B) auto-detect and atomically install newer plugin bundles from the configured GitHub repo.

**Architecture:** Two independent subsystems added to the existing single-file `HarnessPlugin` bundle. Subsystem A is triggered from the `session.idle` event and drives a throwaway `refiner` session via the plugin's SDK `client`. Subsystem B runs on a `setInterval` + once at startup, compares a GitHub commit SHA against a local version marker, and atomically replaces the running bundle via temp-file + rename. All gating/safety logic is isolated in pure functions in two new files so it is unit-testable offline.

**Tech Stack:** Bun (runtime + test runner), TypeScript, `@opencode-ai/plugin` (tool + Plugin types), `@opencode-ai/sdk` client (`session.create`, `session.promptAsync`), Node `fs`, global `fetch`.

## Global Constraints

- Plugin factory is `Plugin = async ({ directory, client }) => Promise<Hooks>`; `client` comes from `PluginInput`.
- Evidence entries have a monotonic ISO `ts` string; the refine watermark is the max `ts` seen at last refine. Compare as strings (ISO strings sort chronologically).
- Bundle is built with `bun build src/plugin.ts --outfile dist/harness.js --target node` (ESM).
- `import.meta.url` must resolve to the running bundle's file path at runtime (verify after build; bun preserves it for ESM/node).
- Writes are restricted to `~/.config/opencode/harness/` and the plugin's own bundle file. Never write to the project.
- Module constants (verbatim from spec): `AUTO_REFINE_ENABLED = true`, `AUTO_REFINE_MIN_EVIDENCE = 5`, `AUTO_REFINE_MAX_OPS = 3`, `AUTO_UPDATE_ENABLED = true`, `UPDATE_CHECK_HOURS = 6`, `UPDATE_REPO = "Skunk-Tech/opencode-super"`.
- All commands run from repo root `opencode-harness/` unless noted. Tests: `bun test` (uses `bun:test`).
- tsc gate: `bunx tsc --noEmit -p opencode-harness/tsconfig.json` (run from RemoteNG root).

### Task 1: Auto-refine logic (`src/autorefine.ts`)

**Files:**
- Create: `opencode-harness/src/autorefine.ts`
- Create: `opencode-harness/test/autorefine.test.ts`

**Interfaces:**
- Consumes: `readEvidence` and `type EvidenceEntry` from `./store`; `ensureDir` from `./paths`.
- Produces:
  - `type RefineState = { lastAutoRefineAt?: string; watermark?: string }`
  - `readRefineState(dir: string): RefineState`
  - `writeRefineState(dir: string, state: RefineState): void`
  - `newEvidenceSince(rows: EvidenceEntry[], watermark: string | undefined): EvidenceEntry[]`
  - `isRefineDue(rows: EvidenceEntry[], state: RefineState, minNew?: number): boolean`
  - `type AutoRefineClient = { session: { create(opts: { query?: { directory?: string } }): Promise<{ id: string }>; promptAsync(opts: unknown): Promise<unknown> } }`
  - `runAutoRefine(client: AutoRefineClient, directory: string, global: string, opts?: { enabled?: boolean; minEvidence?: number; maxOps?: number }): Promise<boolean>`

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import {
  readRefineState, writeRefineState, newEvidenceSince, isRefineDue, runAutoRefine,
} from "../src/autorefine";
import type { EvidenceEntry } from "../src/store";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "autorefine-test-"));
}

const row = (ts: string): EvidenceEntry => ({ ts, sessionID: "s1", kind: "tool_failure", tool: "bash" });

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

test("runAutoRefine creates a refiner session and prompts it when due", async () => {
  const dir = tmpDir();
  writeRefineState(dir, {});
  const rows = Array.from({ length: 5 }, (_, i) => row(`2026-01-0${i + 1}T00:00:00.000Z`));
  fs.writeFileSync(path.join(dir, "evidence.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
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
  const ok = await runAutoRefine(client as any, "/work", dir);
  expect(ok).toBe(true);
  expect(prompted).toBe(1);
  const state = readRefineState(dir);
  expect(state.watermark).toBe("2026-01-05T00:00:00.000Z");
  expect(state.lastAutoRefineAt).toBeDefined();
});

test("runAutoRefine does nothing when evidence gate not met", async () => {
  const dir = tmpDir();
  writeRefineState(dir, { watermark: "2999-12-31T00:00:00.000Z" });
  fs.writeFileSync(path.join(dir, "evidence.jsonl"), JSON.stringify(row("2026-01-01T00:00:00.000Z")) + "\n", "utf8");
  let prompted = 0;
  const client = { session: { async create() { return { id: "x" }; }, async promptAsync() { prompted++; return {}; } } };
  const ok = await runAutoRefine(client as any, "/work", dir);
  expect(ok).toBe(false);
  expect(prompted).toBe(0);
});

test("runAutoRefine returns false when disabled", async () => {
  const dir = tmpDir();
  writeRefineState(dir, {});
  const rows = Array.from({ length: 5 }, (_, i) => row(`2026-01-0${i + 1}T00:00:00.000Z`));
  fs.writeFileSync(path.join(dir, "evidence.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  const client = { session: { async create() { return { id: "x" }; }, async promptAsync() { return {}; } } };
  const ok = await runAutoRefine(client as any, "/work", dir, { enabled: false });
  expect(ok).toBe(false);
});

test("runAutoRefine swallows client failures and leaves watermark unchanged", async () => {
  const dir = tmpDir();
  writeRefineState(dir, { watermark: "2026-01-01T00:00:00.000Z" });
  const rows = Array.from({ length: 5 }, (_, i) => row(`2026-01-0${i + 2}T00:00:00.000Z`));
  fs.writeFileSync(path.join(dir, "evidence.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  const client = { session: { async create() { throw new Error("boom"); }, async promptAsync() { return {}; } } };
  const ok = await runAutoRefine(client as any, "/work", dir);
  expect(ok).toBe(false);
  expect(readRefineState(dir).watermark).toBe("2026-01-01T00:00:00.000Z");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test opencode-harness/test/autorefine.test.ts`
Expected: FAIL — module `../src/autorefine` not found / functions undefined.

- [ ] **Step 3: Write minimal implementation**

```ts
import fs from "fs";
import path from "path";
import { readEvidence, type EvidenceEntry } from "./store";
import { ensureDir } from "./paths";

export type RefineState = {
  lastAutoRefineAt?: string;
  watermark?: string;
};

export function refineStateFile(dir: string): string {
  return path.join(dir, "refine-state.json");
}

export function readRefineState(dir: string): RefineState {
  const file = refineStateFile(dir);
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as RefineState;
  } catch {
    return {};
  }
}

export function writeRefineState(dir: string, state: RefineState): void {
  ensureDir(dir);
  fs.writeFileSync(refineStateFile(dir), JSON.stringify(state, null, 2), "utf8");
}

export function newEvidenceSince(rows: EvidenceEntry[], watermark: string | undefined): EvidenceEntry[] {
  if (!watermark) return rows;
  return rows.filter((r) => r.ts > watermark);
}

export function isRefineDue(rows: EvidenceEntry[], state: RefineState, minNew = 5): boolean {
  return newEvidenceSince(rows, state.watermark).length >= minNew;
}

export type AutoRefineClient = {
  session: {
    create(opts: { query?: { directory?: string } }): Promise<{ id: string }>;
    promptAsync(opts: unknown): Promise<unknown>;
  };
};

const REFINE_PROMPT = `Run the harness refine workflow (load the \`harness-refine\` skill) and apply evidence-backed refinements. Be conservative: weak evidence means no change. Apply at most $MAX_OPS ops.`;

let refining = false;

export async function runAutoRefine(
  client: AutoRefineClient,
  directory: string,
  global: string,
  opts: { enabled?: boolean; minEvidence?: number; maxOps?: number } = {},
): Promise<boolean> {
  if (opts.enabled === false) return false;
  if (refining) return false;
  const state = readRefineState(global);
  const rows = readEvidence(global);
  if (!isRefineDue(rows, state, opts.minEvidence ?? 5)) return false;
  refining = true;
  try {
    const session = await client.session.create({ query: { directory } });
    await client.session.promptAsync({
      path: { id: session.id },
      body: {
        agent: "refiner",
        parts: [{ type: "text", text: REFINE_PROMPT.replace("$MAX_OPS", String(opts.maxOps ?? 3)) }],
      },
    });
    const watermark = rows.reduce((max, r) => (r.ts > max ? r.ts : max), "");
    writeRefineState(global, { lastAutoRefineAt: new Date().toISOString(), watermark });
    return true;
  } catch {
    return false;
  } finally {
    refining = false;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test opencode-harness/test/autorefine.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Typecheck**

Run: `bunx tsc --noEmit -p opencode-harness/tsconfig.json` (from RemoteNG root)
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add opencode-harness/src/autorefine.ts opencode-harness/test/autorefine.test.ts
git commit -m "autorefine: refine-state gate and runAutoRefine via refiner session"
```

### Task 2: Wire auto-refine into the plugin

**Files:**
- Modify: `opencode-harness/src/plugin.ts`
- Modify: `opencode-harness/test/plugin.test.ts`

**Interfaces:**
- Consumes: `runAutoRefine` from `./autorefine` (Task 1); existing `Plugin` type; `client` from `PluginInput`.
- Produces: `session.idle` now fires `runAutoRefine(client, directory, global, { enabled: AUTO_REFINE_ENABLED, minEvidence: AUTO_REFINE_MIN_EVIDENCE })` fire-and-forget. `harness_status` output includes `last auto-refine` line.

- [ ] **Step 1: Write the failing test**

Append to `opencode-harness/test/plugin.test.ts`:

```ts
import { AUTO_REFINE_ENABLED } from "../src/plugin";

test("AUTO_REFINE_ENABLED constant defaults true", () => {
  expect(AUTO_REFINE_ENABLED).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test opencode-harness/test/plugin.test.ts`
Expected: FAIL — `AUTO_REFINE_ENABLED` is not exported.

- [ ] **Step 3: Write minimal implementation**

Add the constant near the top of `opencode-harness/src/plugin.ts` (after `HARNESS_TEMPLATE`):

```ts
export const AUTO_REFINE_ENABLED = true;
export const AUTO_REFINE_MIN_EVIDENCE = 5;
export const AUTO_REFINE_MAX_OPS = 3;
```

Change the plugin factory signature to accept `client`:

```ts
export const HarnessPlugin: Plugin = async ({ directory, client }) => {
  const global = globalHarnessDir();
```

Add the auto-refine trigger in the `event` hook's `session.idle` branch, right after the `activity.delete(id);` line (inside the existing `else if (event.type === "session.idle")` block):

```ts
      } else if (event.type === "session.idle") {
        const cur = activity.get(id);
        if (isPrematureStop(cur?.lastFinish, cur?.sawToolCalls ?? false)) {
          appendEvidence(global, { ts: new Date().toISOString(), sessionID: id, kind: "premature_stop", finish: cur?.lastFinish, project: directory });
        }
        appendEvidence(global, { ts: new Date().toISOString(), sessionID: id, kind: "session_idle", project: directory });
        activity.delete(id);
        void runAutoRefine(client, directory, global, { enabled: AUTO_REFINE_ENABLED, minEvidence: AUTO_REFINE_MIN_EVIDENCE });
      } else if (event.type === "session.created") {
```

Add the import at the top of `plugin.ts` (after the `./refine` import):

```ts
import { runAutoRefine, readRefineState } from "./autorefine";
```

Update `harness_status` tool body to report auto-refine state. Replace its `execute`:

```ts
        async execute() {
          const state = loadState(global);
          const snapshots = listSnapshots(global);
          const refine = readRefineState(global);
          return `## Harness status\nglobal: ${global}\nmemories: ${state.memories.length}\nspecs: ${state.specs.length}\nevidence entries: ${readEvidence(global).length}\nsnapshots: ${snapshots.length}\nlast auto-refine: ${refine.lastAutoRefineAt ?? "never"}`;
        },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test opencode-harness/test/plugin.test.ts`
Expected: PASS (including the new `AUTO_REFINE_ENABLED` test).

- [ ] **Step 5: Run full suite + typecheck**

Run: `bun test opencode-harness/test/` then `bunx tsc --noEmit -p opencode-harness/tsconfig.json` (from RemoteNG root)
Expected: all tests PASS, no type errors. Note: `client` is a `PluginInput` field, so the factory still satisfies `Plugin`.

- [ ] **Step 6: Commit**

```bash
git add opencode-harness/src/plugin.ts opencode-harness/test/plugin.test.ts
git commit -m "autorefine: trigger runAutoRefine on session.idle and surface last run in status"
```

### Task 3: Update-checker logic (`src/updater.ts`)

**Files:**
- Create: `opencode-harness/src/updater.ts`
- Create: `opencode-harness/test/updater.test.ts`

**Interfaces:**
- Consumes: Node `fs`, `path`, `fileURLToPath` from `url`; global `fetch`.
- Produces:
  - `ownBundlePath(): string | undefined`
  - `isGitInstalledBundle(ownPath: string): boolean`
  - `versionMarkerFile(ownPath: string): string` (returns `<ownPath>.version`)
  - `readVersionMarker(ownPath: string): string | undefined`
  - `writeVersionMarker(ownPath: string, sha: string): void`
  - `atomicReplace(filePath: string, content: string): void`
  - `fetchLatestSha(repo: string, fetcher?: typeof fetch): Promise<string | undefined>`
  - `fetchBundle(repo: string, ref: string, fetcher?: typeof fetch): Promise<string | undefined>`
  - `checkForUpdates(ownPath: string, repo: string, opts?: { enabled?: boolean; fetcher?: typeof fetch }): Promise<"updated" | "current" | "skipped">`

- [ ] **Step 1: Write the failing test**

```ts
import { expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import {
  isGitInstalledBundle, versionMarkerFile, readVersionMarker, writeVersionMarker,
  atomicReplace, fetchLatestSha, fetchBundle, checkForUpdates,
} from "../src/updater";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "updater-test-"));
}

test("isGitInstalledBundle detects npm/git cache layout", () => {
  expect(isGitInstalledBundle("/cache/packages/opencode-super@git+https_/node_modules/opencode-super/.opencode/plugins/harness.js")).toBe(true);
  expect(isGitInstalledBundle("C:\\Users\\x\\.config\\opencode\\plugins\\harness.js")).toBe(false);
});

test("versionMarkerFile appends .version next to the bundle", () => {
  expect(versionMarkerFile("/a/b/harness.js")).toBe("/a/b/harness.js.version");
});

test("readVersionMarker returns undefined for missing marker", () => {
  const dir = tmpDir();
  expect(readVersionMarker(path.join(dir, "harness.js"))).toBeUndefined();
});

test("writeVersionMarker then readVersionMarker round-trips", () => {
  const dir = tmpDir();
  const own = path.join(dir, "harness.js");
  writeVersionMarker(own, "abc123");
  expect(readVersionMarker(own)).toBe("abc123");
});

test("atomicReplace writes content and leaves no temp file", () => {
  const dir = tmpDir();
  const own = path.join(dir, "harness.js");
  fs.writeFileSync(own, "old", "utf8");
  atomicReplace(own, "new content");
  expect(fs.readFileSync(own, "utf8")).toBe("new content");
  expect(fs.readdirSync(dir).filter((f) => f.includes("harness.tmp"))).toEqual([]);
});

test("fetchLatestSha parses the GitHub API response", async () => {
  const fetcher = async () => ({ ok: true, json: async () => ({ sha: "deadbeef" }) }) as any;
  expect(await fetchLatestSha("Skunk-Tech/opencode-super", fetcher)).toBe("deadbeef");
});

test("fetchLatestSha returns undefined on network error", async () => {
  const fetcher = async () => { throw new Error("offline"); };
  expect(await fetchLatestSha("Skunk-Tech/opencode-super", fetcher)).toBeUndefined();
});

test("fetchBundle downloads non-empty bundle text", async () => {
  const fetcher = async () => ({ ok: true, text: async () => "export const x = 1;" }) as any;
  expect(await fetchBundle("Skunk-Tech/opencode-super", "abc", fetcher)).toBe("export const x = 1;");
});

test("fetchBundle returns undefined for empty body", async () => {
  const fetcher = async () => ({ ok: true, text: async () => "" }) as any;
  expect(await fetchBundle("Skunk-Tech/opencode-super", "abc", fetcher)).toBeUndefined();
});

test("checkForUpdates replaces bundle when newer, writes marker", async () => {
  const dir = tmpDir();
  const own = path.join(dir, "node_modules", "opencode-super", ".opencode", "plugins", "harness.js");
  fs.mkdirSync(path.dirname(own), { recursive: true });
  fs.writeFileSync(own, "old bundle", "utf8");
  const urls: string[] = [];
  const fetcher = async (url: string) => {
    urls.push(url);
    if (url.includes("commits/main")) return { ok: true, json: async () => ({ sha: "newsha" }) } as any;
    return { ok: true, text: async () => "new bundle" } as any;
  };
  const result = await checkForUpdates(own, "Skunk-Tech/opencode-super", { fetcher: fetcher as any });
  expect(result).toBe("updated");
  expect(fs.readFileSync(own, "utf8")).toBe("new bundle");
  expect(readVersionMarker(own)).toBe("newsha");
});

test("checkForUpdates is a no-op when disabled", async () => {
  const dir = tmpDir();
  const own = path.join(dir, "harness.js");
  const result = await checkForUpdates(own, "Skunk-Tech/opencode-super", { enabled: false });
  expect(result).toBe("skipped");
});

test("checkForUpdates skips non-git installs", async () => {
  const dir = tmpDir();
  const own = path.join(dir, "harness.js");
  const result = await checkForUpdates(own, "Skunk-Tech/opencode-super", {});
  expect(result).toBe("skipped");
});

test("checkForUpdates does not replace on download failure", async () => {
  const dir = tmpDir();
  const own = path.join(dir, "node_modules", "opencode-super", ".opencode", "plugins", "harness.js");
  fs.mkdirSync(path.dirname(own), { recursive: true });
  fs.writeFileSync(own, "old bundle", "utf8");
  const fetcher = async () => ({ ok: false }) as any;
  const result = await checkForUpdates(own, "Skunk-Tech/opencode-super", { fetcher: fetcher as any });
  expect(result).toBe("skipped");
  expect(fs.readFileSync(own, "utf8")).toBe("old bundle");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test opencode-harness/test/updater.test.ts`
Expected: FAIL — module `../src/updater` not found / functions undefined.

- [ ] **Step 3: Write minimal implementation**

```ts
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

export const GITHUB_API = "https://api.github.com/repos";
export const RAW_GITHUB = "https://raw.githubusercontent.com";

export function ownBundlePath(): string | undefined {
  try {
    return fileURLToPath(import.meta.url);
  } catch {
    return undefined;
  }
}

export function isGitInstalledBundle(ownPath: string): boolean {
  const sep = path.sep;
  return ownPath.includes(sep + "node_modules" + sep);
}

export function versionMarkerFile(ownPath: string): string {
  return ownPath + ".version";
}

export function readVersionMarker(ownPath: string): string | undefined {
  const file = versionMarkerFile(ownPath);
  if (!fs.existsSync(file)) return undefined;
  const content = fs.readFileSync(file, "utf8").trim();
  return content.length > 0 ? content : undefined;
}

export function writeVersionMarker(ownPath: string, sha: string): void {
  fs.writeFileSync(versionMarkerFile(ownPath), sha, "utf8");
}

export function atomicReplace(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.harness.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, filePath);
}

export async function fetchLatestSha(repo: string, fetcher: typeof fetch = fetch): Promise<string | undefined> {
  try {
    const res = await fetcher(`${GITHUB_API}/${repo}/commits/main`, { headers: { "User-Agent": "opencode-harness" } });
    if (!res.ok) return undefined;
    const json = (await res.json()) as { sha?: string };
    return json.sha;
  } catch {
    return undefined;
  }
}

export async function fetchBundle(repo: string, ref: string, fetcher: typeof fetch = fetch): Promise<string | undefined> {
  try {
    const res = await fetcher(`${RAW_GITHUB}/${repo}/${ref}/.opencode/plugins/harness.js`);
    if (!res.ok) return undefined;
    const text = await res.text();
    return text.length > 0 ? text : undefined;
  } catch {
    return undefined;
  }
}

export async function checkForUpdates(
  ownPath: string,
  repo: string,
  opts: { enabled?: boolean; fetcher?: typeof fetch } = {},
): Promise<"updated" | "current" | "skipped"> {
  if (opts.enabled === false) return "skipped";
  if (!isGitInstalledBundle(ownPath)) return "skipped";
  const fetcher = opts.fetcher ?? fetch;
  const latest = await fetchLatestSha(repo, fetcher);
  if (!latest) return "skipped";
  const current = readVersionMarker(ownPath);
  if (current === latest) return "current";
  const bundle = await fetchBundle(repo, latest, fetcher);
  if (!bundle) return "skipped";
  try {
    atomicReplace(ownPath, bundle);
    writeVersionMarker(ownPath, latest);
    return "updated";
  } catch {
    return "skipped";
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test opencode-harness/test/updater.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Typecheck**

Run: `bunx tsc --noEmit -p opencode-harness/tsconfig.json` (from RemoteNG root)
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add opencode-harness/src/updater.ts opencode-harness/test/updater.test.ts
git commit -m "updater: SHA check and atomic self-replace of the plugin bundle"
```

### Task 4: Wire the updater into the plugin

**Files:**
- Modify: `opencode-harness/src/plugin.ts`
- Modify: `opencode-harness/test/plugin.test.ts`

**Interfaces:**
- Consumes: `checkForUpdates`, `ownBundlePath`, `readVersionMarker` from `./updater` (Task 3); `update-state.json` on disk.
- Produces: module constants `AUTO_UPDATE_ENABLED`, `UPDATE_CHECK_HOURS`, `UPDATE_REPO`; a startup check + `setInterval` that updates `~/.config/opencode/harness/update-state.json`; `harness_status` reports update status.

- [ ] **Step 1: Write the failing test**

Append to `opencode-harness/test/plugin.test.ts`:

```ts
import { AUTO_UPDATE_ENABLED, UPDATE_CHECK_HOURS, UPDATE_REPO } from "../src/plugin";

test("update constants have spec defaults", () => {
  expect(AUTO_UPDATE_ENABLED).toBe(true);
  expect(UPDATE_CHECK_HOURS).toBe(6);
  expect(UPDATE_REPO).toBe("Skunk-Tech/opencode-super");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test opencode-harness/test/plugin.test.ts`
Expected: FAIL — constants not exported.

- [ ] **Step 3: Write minimal implementation**

Add the imports to `opencode-harness/src/plugin.ts` (after the `./autorefine` import):

```ts
import { checkForUpdates, ownBundlePath, readVersionMarker } from "./updater";
```

Add the constants after `AUTO_REFINE_ENABLED`:

```ts
export const AUTO_UPDATE_ENABLED = true;
export const UPDATE_CHECK_HOURS = 6;
export const UPDATE_REPO = "Skunk-Tech/opencode-super";
```

Add a helper inside the factory (after `recordFinish`), and the timer wiring at the end of the factory before `return {`:

```ts
  const ownPath = ownBundlePath();
  const updateStateFile = path.join(global, "update-state.json");
  const recordUpdateState = (state: Record<string, unknown>): void => {
    try { fs.writeFileSync(updateStateFile, JSON.stringify({ ...state, checkedAt: new Date().toISOString() }, null, 2), "utf8"); } catch { /* best-effort */ }
  };
  const checkUpdate = (): void => {
    void checkForUpdates(ownPath ?? "", UPDATE_REPO, { enabled: AUTO_UPDATE_ENABLED }).then((result) => {
      if (result === "updated") recordUpdateState({ pendingRestart: true, latest: readVersionMarker(ownPath ?? "") ?? "unknown" });
      else if (result === "current") recordUpdateState({ pendingRestart: false });
    }).catch(() => { /* silent */ });
  };
  const initialTimer = setTimeout(checkUpdate, 30_000);
  const intervalTimer = setInterval(checkUpdate, UPDATE_CHECK_HOURS * 3_600_000);
```

Append `initialTimer` and `intervalTimer` are intentionally retained (module keeps process alive is fine; opencode server is long-lived). Add the following comment note to the plugin file near the timers:

```ts
  // Timers keep a reference so they are not garbage-collected. opencode's server process
  // is long-lived, and plugins only run while opencode is open, so a wall-clock interval
  // plus a startup check is the supported schedule.
```

Update `harness_status` to report update state. Replace its `execute` (from Task 2):

```ts
        async execute() {
          const state = loadState(global);
          const snapshots = listSnapshots(global);
          const refine = readRefineState(global);
          let update = "no check yet";
          try {
            if (fs.existsSync(updateStateFile)) {
              const u = JSON.parse(fs.readFileSync(updateStateFile, "utf8"));
              update = u.pendingRestart ? `update available (${u.latest}), restart opencode to load` : `up to date (checked ${u.checkedAt})`;
            }
          } catch { /* corrupt update-state.json */ }
          return `## Harness status\nglobal: ${global}\nmemories: ${state.memories.length}\nspecs: ${state.specs.length}\nevidence entries: ${readEvidence(global).length}\nsnapshots: ${snapshots.length}\nlast auto-refine: ${refine.lastAutoRefineAt ?? "never"}\nupdates: ${update}`;
        },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test opencode-harness/test/plugin.test.ts`
Expected: PASS.

- [ ] **Step 5: Run full suite + typecheck**

Run: `bun test opencode-harness/test/` then `bunx tsc --noEmit -p opencode-harness/tsconfig.json` (from RemoteNG root)
Expected: all tests PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add opencode-harness/src/plugin.ts opencode-harness/test/plugin.test.ts
git commit -m "updater: startup + interval update check, status reporting"
```

### Task 5: Build, verify, install, smoke test

**Files:**
- Modify: `opencode-harness/scripts/build.ts` (no logic change; verify output)
- No new source files.

**Interfaces:**
- Consumes: built `dist/harness.js`; installed config dir `~/.config/opencode/`.

- [ ] **Step 1: Build the bundle**

Run: `bun opencode-harness/scripts/build.ts`
Expected: `Bundled ... modules`, `Built dist/harness.js`.

- [ ] **Step 2: Verify `import.meta.url` survives bundling**

Run:
```bash
Select-String -Path "opencode-harness\dist\harness.js" -Pattern "import\.meta\.url" | Select-Object -First 3
```
Expected: at least one match (the updater's `ownBundlePath`). If there are zero matches, `bun build --target node` inlined it — switch the own-path resolution to use `import.meta.url` guarded by a check at runtime instead (see Global Constraints note), or emit the bundle as ESM by adding `--format esm` to `build.ts`. Do not proceed until this match exists.

- [ ] **Step 3: Run the full test suite + typecheck**

Run: `bun test opencode-harness/test/` then `bunx tsc --noEmit -p opencode-harness/tsconfig.json` (from RemoteNG root)
Expected: all tests PASS, no type errors.

- [ ] **Step 4: Install into the global config**

Run: `bun opencode-harness/scripts/install.ts`
Expected: `Installed C:\Users\<user>\.config\opencode\plugins\harness.js` plus the four asset copies.

- [ ] **Step 5: Smoke test plugin loading**

First create `opencode-harness/smoke-config.json` (git-ignored test artifact) referencing the freshly installed plugin bundle:

```json
{
  "plugin": ["file:///C:/Users/Garret/.config/opencode/plugins/harness.js"]
}
```

Then run (from RemoteNG root, a git repo — required for `opencode debug config` to work):

```powershell
$env:OPENCODE_CONFIG = "$PWD\opencode-harness\smoke-config.json"
opencode debug config 2>&1 | Select-String -Pattern "refiner|harness|ERROR" | Select-Object -First 15
```

Expected: `refiner` agent and `harness`/`refine` commands present, no `ERROR`-level plugin load failures. Delete `smoke-config.json` afterwards.

- [ ] **Step 6: Sync bundle into the fork repo and push**

Run:
```powershell
Copy-Item -Path "opencode-harness\dist\harness.js" -Destination "C:\Users\Garret\OneDrive\Documents\Claud\opencode-super\.opencode\plugins\harness.js" -Force
```
Then run these with workdir `C:\Users\Garret\OneDrive\Documents\Claud\opencode-super`:
```powershell
git add .opencode/plugins/harness.js
git commit -m "chore: sync harness bundle (auto-refine + auto-update)"
git push
```

- [ ] **Step 7: Commit any final source changes in RemoteNG**

```bash
git add -A
git commit -m "harness: build and install self-update bundle"
```
(If nothing changed, skip.)

---
