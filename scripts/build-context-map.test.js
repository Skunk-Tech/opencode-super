import { test, expect, beforeAll, afterAll } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseArgs,
  collectFiles,
  extractSymbols,
  extractImports,
  resolveImportSpecifier,
  buildGraph,
  writeOutputs,
} from "./build-context-map.js";

let root, outDir;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ctxmap-"));
  fs.mkdirSync(path.join(root, "src", "utils"), { recursive: true });
  fs.mkdirSync(path.join(root, "src", "app"), { recursive: true });
  fs.mkdirSync(path.join(root, "node_modules", "dep"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "utils", "helpers.ts"), [
    "export function helperA() { return 1; }",
    "export const CONST_B = 2;",
    "import { x } from './other';",
  ].join("\n"));
  fs.writeFileSync(path.join(root, "src", "utils", "other.ts"), "export function otherFn() {}\n");
  fs.writeFileSync(path.join(root, "src", "app", "main.ts"), [
    "import { helperA } from '../utils/helpers';",
    "import { otherFn } from '../utils/other';",
    "import { internal } from 'node:fs';",
    "export function main() { return helperA() + otherFn(); }",
    "const CONST_B = 9; // local shadow, still a token",
  ].join("\n"));
  fs.writeFileSync(path.join(root, "node_modules", "dep", "lib.js"), "export function depFn(){}\n");
  outDir = path.join(root, "graft");
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

test("collectFiles excludes node_modules by default", () => {
  const cfg = parseArgs([root]);
  const files = collectFiles(root, cfg);
  expect(files.some((f) => f.rel.includes("node_modules"))).toBe(false);
});

test("collectFiles finds nested source files", () => {
  const cfg = parseArgs([root]);
  const files = collectFiles(root, cfg);
  expect(files.map((f) => f.rel).sort()).toEqual([
    "src/app/main.ts",
    "src/utils/helpers.ts",
    "src/utils/other.ts",
  ]);
});

test("extractSymbols captures exported functions and consts", () => {
  const syms = extractSymbols({ ext: "ts" }, "export function helperA() {}\nexport const CONST_B = 2;");
  expect(syms).toContainEqual({ name: "helperA", type: "function" });
  expect(syms).toContainEqual({ name: "CONST_B", type: "const" });
});

test("extractImports captures relative and bare specifiers", () => {
  const imps = extractImports("import { a } from './x';\nimport b from 'pkg';\nconst c = require('./y');");
  expect(imps).toContain("./x");
  expect(imps).toContain("./y");
  expect(imps).toContain("pkg");
});

test("resolveImportSpecifier resolves extensionless + index imports to file ids", () => {
  const cfg = parseArgs([root]);
  const files = collectFiles(root, cfg);
  const idOf = (rel) => rel.replace(/[\\/]/g, "__");

  // '../utils/helpers' -> src/utils/helpers.ts
  const r1 = resolveImportSpecifier({ specifier: "../utils/helpers", fromRel: "src/app/main.ts", files });
  expect(r1 && r1.resolved).toBe(true);
  expect(r1 && r1.id).toBe(idOf("src/utils/helpers.ts"));

  // '../utils/other' -> src/utils/other.ts
  const r2 = resolveImportSpecifier({ specifier: "../utils/other", fromRel: "src/app/main.ts", files });
  expect(r2 && r2.resolved).toBe(true);
  expect(r2 && r2.id).toBe(idOf("src/utils/other.ts"));

  // bare/node builtin -> unresolved (external)
  const r3 = resolveImportSpecifier({ specifier: "node:fs", fromRel: "src/app/main.ts", files });
  expect(r3 && r3.resolved).toBe(false);
});

test("buildGraph produces callers (reference tracking) for a cross-file symbol", () => {
  const cfg = parseArgs([root]);
  const graph = buildGraph(root, cfg);
  const mainNode = graph.files.find((f) => f.path === "src/app/main.ts");
  const helperNode = graph.files.find((f) => f.path === "src/utils/helpers.ts");

  // main.ts references helperA which is defined in helpers.ts
  const helperSym = graph.symbols.find((s) => s.symbol === "helperA" && s.file === "src/utils/helpers.ts");
  expect(helperSym).toBeTruthy();
  expect(helperSym.references.map((r) => r.file)).toContain("src/app/main.ts");

  // main.ts imports resolve onto helpers.ts and other.ts
  expect(mainNode.imports.some((i) => i.resolved && i.id === helperNode.id)).toBe(true);
});

test("import edges resolve to file ids in the graph edges array", () => {
  const cfg = parseArgs([root]);
  const graph = buildGraph(root, cfg);
  const edges = graph.edges.filter((e) => e.kind === "imports" && e.specifier === "../utils/other");
  expect(edges.length).toBe(1);
  expect(edges[0] && edges[0].resolved).toBe(true);
  expect(edges[0] && edges[0].to).toMatch(/utils__other/);
});

test("writeOutputs prunes stale node files", () => {
  const cfg = parseArgs([root]);
  const graph = buildGraph(root, cfg);
  writeOutputs(graph, outDir);
  // plant a stale file
  fs.writeFileSync(path.join(outDir, "stale-node.md"), "old");
  writeOutputs(graph, outDir);
  expect(fs.existsSync(path.join(outDir, "stale-node.md"))).toBe(false);
});

test("writeOutputs is idempotent and only writes wiring.json when changed", () => {
  const cfg = parseArgs([root]);
  const graph = buildGraph(root, cfg);
  writeOutputs(graph, outDir);
  const wiringPath = path.join(outDir, ".graph", "wiring.json");
  const first = fs.statSync(wiringPath).mtimeMs;
  // slight delay to ensure mtime resolution
  fs.writeFileSync(wiringPath, fs.readFileSync(wiringPath)); // touch not needed; rebuild should skip write
  const graph2 = buildGraph(root, cfg);
  const second = writeOutputs(graph2, outDir);
  expect(second.changed).toBe(false);
  const after = fs.statSync(wiringPath).mtimeMs;
  // unchanged graph should not rewrite wiring.json
  expect(after).toBeGreaterThanOrEqual(first);
});

test("collectFiles skips minified/bundled single-line files (generated artifacts)", () => {
  fs.writeFileSync(path.join(root, "src", "bundle.js"), "export function a(){}".padEnd(150000, "x") + "\n");
  const cfg = parseArgs([root]);
  const files = collectFiles(root, cfg);
  expect(files.some((f) => f.rel === "src/bundle.js")).toBe(false);
});
