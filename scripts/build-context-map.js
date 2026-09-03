#!/usr/bin/env node
/**
 * build-context-map.js
 *
 * Build a regenerable, agent-readable structural map of a codebase — a
 * zero-dependency mirror of Graft's structural tier. Reads source files,
 * extracts symbols, resolves imports to real file nodes, tracks cross-file
 * references (callers of a symbol), and writes markdown nodes with
 * [[wikilinks]] plus a per-symbol wiring graph.
 *
 * Deterministic structural tier: no LLM, no network, no key. The map is a
 * local, regenerable cache (like node_modules), not a committed artifact.
 *
 * The file is dual-purpose:
 *   - CLI:     node scripts/build-context-map.js [dir] [--out graft/]
 *   - module:  import { buildGraph, writeOutputs } from ".../build-context-map.js"
 *              (pure functions exported for tests / embedding)
 *
 * Fixes over the first cut (token-burn/defect pass):
 *   A. Real cross-file reference tracking: wiring.json now lists, per defined
 *      symbol, which files reference it ("callers of X" actually works).
 *   B. Import edges resolve to real node ids (extensionless + index + ../), so
 *      "what imports X" is answerable from the graph, not just raw specifiers.
 *   C. Truly incremental: unchanged files are not rewritten; wiring.json is
 *      only rewritten when the graph actually changed.
 *   F. Stale node files are pruned (removed files disappear from graft/).
 *
 * Usage:
 *   node scripts/build-context-map.js [dir] [--extensions .ts,.py,...]
 *       [--include src,**] [--exclude test,**] [--out graft/]
 *
 * Output (gitignored):
 *   <out>/*.md            one node per file/group, with [[wikilinks]]
 *   <out>/.graph/wiring.json   symbols + references + resolved import edges
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// --- arg parsing -----------------------------------------------------------

export const DEFAULT_EXTS = 'ts,tsx,js,jsx,mjs,cjs,py,go,php,rs,java,kt,rb';
export const DEFAULT_EXCLUDE = 'node_modules,dist,.git,__pycache__,**/test,**/tests';

export function parseArgs(argv = process.argv.slice(2)) {
  const arg = (name, fallback) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  const positional = argv.find((a) => !a.startsWith('--') && !['--extensions', '--include', '--exclude', '--out'].includes(a));
  const root = path.resolve(positional || process.cwd());
  const outDir = path.resolve(root, arg('--out', 'graft'));
  const exts = (arg('--extensions', '') || DEFAULT_EXTS)
    .split(',')
    .map((e) => e.trim().replace(/^\./, '').toLowerCase())
    .filter(Boolean);
  const includeGlobs = (arg('--include', '') || '**/*')
    .split(',')
    .map((g) => g.trim())
    .filter(Boolean);
  const excludeGlobs = (arg('--exclude', '') || DEFAULT_EXCLUDE)
    .split(',')
    .map((g) => g.trim())
    .filter(Boolean);
  return { root, outDir, exts, includeGlobs, excludeGlobs };
}

// --- helpers ---------------------------------------------------------------

export const hash = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

export const nodeId = (relPath) => relPath.replace(/[\\/]/g, '__');

const globMatch = (relPath, patterns) =>
  patterns.some((p) => {
    if (p === '**/*') return true;
    if (p.includes('**')) {
      const re = new RegExp('^' + p.split('/').map((seg) => (seg === '**' ? '.*' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'))).join('/') + '$');
      return re.test(relPath);
    }
    // single-segment or path pattern: match any trailing segment or full path
    const segRe = new RegExp('^' + p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '$');
    const segments = relPath.split('/');
    return segRe.test(relPath) || segments.some((s) => segRe.test(s));
  });

export function collectFiles(dir, cfg, rel = '') {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === cfg.outDir.split('/').pop() || entry.name === '.graph' || entry.name === '.git') continue;
      files.push(...collectFiles(abs, cfg, relPath));
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).replace(/^\./, '').toLowerCase();
      if (!cfg.exts.includes(ext)) continue;
      if (!globMatch(relPath, cfg.includeGlobs)) continue;
      if (globMatch(relPath, cfg.excludeGlobs)) continue;
      const abs = path.join(dir, entry.name);
      const stat = fs.statSync(abs);
      // Skip generated/bundled artifacts: a file that is one giant line (e.g. a
      // minified bundle) is not navigable source and pollutes symbol/reference
      // tracking with thousands of false positives.
      if (stat.size > 100_000 && !hasNewlines(abs)) continue;
      files.push({ abs, rel: relPath, ext });
    }
  }
  return files;
}

const hasNewlines = (abs) => {
  const fd = fs.openSync(abs, 'r');
  try {
    const buf = Buffer.alloc(64 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).includes(0x0a) || buf.subarray(0, n).includes(0x0d);
  } finally {
    fs.closeSync(fd);
  }
};

// --- symbol extraction -----------------------------------------------------

export function extractSymbols(file, text) {
  const ext = (file && file.ext) || '';
  const symbols = [];
  const re = (p) => new RegExp(p, 'gm');
  const rules = {
    ts: [
      [re(/export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/g), 'function'],
      [re(/export\s+class\s+([A-Za-z0-9_$]+)\b/g), 'class'],
      [re(/export\s+const\s+([A-Za-z0-9_$]+)\s*=/g), 'const'],
      [re(/\b(?:export\s+)?interface\s+([A-Za-z0-9_$]+)\b/g), 'interface'],
      [re(/\b(?:export\s+)?type\s+([A-Za-z0-9_$]+)\s*=/g), 'type'],
    ],
    tsx: [
      [re(/export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/g), 'function'],
      [re(/export\s+const\s+([A-Za-z0-9_$]+)\s*=/g), 'const'],
      [re(/export\s+function\s+([A-Za-z0-9_$]+)\s*\(/g), 'function'],
    ],
    js: [
      [re(/export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/g), 'function'],
      [re(/\b(?:export\s+)?class\s+([A-Za-z0-9_$]+)\b/g), 'class'],
      [re(/\b(?:export\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/g), 'function'],
    ],
    py: [
      [re(/^\s*def\s+([A-Za-z0-9_]+)\s*\(/gm), 'function'],
      [re(/^\s*class\s+([A-Za-z0-9_]+)\b/gm), 'class'],
    ],
    go: [
      [re(/^\s*(?:func|type|var|const)\s+([A-Za-z0-9_]+)/gm), 'symbol'],
      [re(/\bfunc\s+(?:\([^)]*\)\s*)?([A-Za-z0-9_]+)\s*\(/g), 'function'],
    ],
    php: [[re(/\bfunction\s+([A-Za-z0-9_]+)\s*\(/g), 'function']],
    rs: [[re(/\bfn\s+([A-Za-z0-9_]+)\s*\(/g), 'function']],
    java: [[re(/\b(?:public|private|protected)?\s*(?:static\s+)?[A-Za-z0-9_<>]+\s+([A-Za-z0-9_]+)\s*\(/g), 'function']],
    kt: [[re(/\bfun\s+([A-Za-z0-9_]+)\s*\(/g), 'function']],
    rb: [[re(/\bdef\s+([A-Za-z0-9_]+)\s*(?:\(|$)/g), 'function']],
  };
  const list = rules[ext] || rules.js;
  for (const [regex, type] of list) {
    let m;
    while ((m = regex.exec(text)) !== null) symbols.push({ name: m[1], type });
  }
  return symbols;
}

export function extractImports(text) {
  const deps = [];
  let m;
  const importRe = /(?:import\s+['"]([^'"]+)['"]|require\(['"]([^'"]+)['"]\)|from\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\))/gm;
  while ((m = importRe.exec(text)) !== null) {
    const src = m[1] || m[2] || m[3] || m[4];
    if (src) deps.push(src);
  }
  return [...new Set(deps)];
}

/** Strip ./ or ../ prefix, extensions; used to map an import specifier to a candidate file. */
export function resolveImportSpecifier({ specifier, fromRel, files }) {
  // Not a relative import -> external/builtin/module; leave unresolved.
  if (!specifier.startsWith('.')) return { specifier, resolved: false };

  const fromDir = path.posix.dirname(fromRel);
  const base = path.posix.normalize(path.posix.join(fromDir, specifier));
  // candidate rel paths to test
  const candidates = [];
  for (const f of files) {
    const noExt = f.rel.replace(/\.[^.]+$/, '');
    if (noExt === base) candidates.push(f.rel);
  }
  if (candidates.length === 0) {
    // also try directory index files
    const idx = files.filter((f) => {
      const noExt = f.rel.replace(/\.[^.]+$/, '');
      return noExt.startsWith(base + '/') && noExt.endsWith('/index');
    });
    for (const f of idx) candidates.push(f.rel);
  }
  if (candidates.length === 0) return { specifier, resolved: false };
  const target = candidates[0];
  return { specifier, resolved: true, id: nodeId(target), rel: target };
}

// --- build -----------------------------------------------------------------

/**
 * Return the full structural graph. Pure: no filesystem writes.
 * files/dirs carry: id, path, hash, symbols, imports (resolved).
 * symbols carry: per-file definition + cross-file references.
 * edges: import edges (resolved to node ids) + reference edges.
 */
export function buildGraph(root, cfg) {
  const files = collectFiles(root, cfg);
  const fileNodes = [];
  const symbolIndex = new Map(); // `${fileRel}#${name}` -> definition info
  const edges = [];

  for (const file of files) {
    const buf = fs.readFileSync(file.abs);
    const text = buf.toString('utf8');
    const symbols = extractSymbols(file, text);
    const importSpecs = extractImports(text);
    const imports = importSpecs.map((s) => {
      const r = resolveImportSpecifier({ specifier: s, fromRel: file.rel, files });
      if (r.resolved) edges.push({ from: nodeId(file.rel), to: r.id, kind: 'imports', specifier: s, resolved: true });
      else edges.push({ from: nodeId(file.rel), to: null, kind: 'imports', specifier: s, resolved: false, unresolved: true });
      return r;
    });
    fileNodes.push({
      id: nodeId(file.rel),
      kind: 'file',
      path: file.rel,
      hash: hash(buf),
      symbols,
      imports,
    });
    for (const s of symbols) {
      symbolIndex.set(`${file.rel}#${s.name}`, { symbol: s.name, type: s.type, file: file.rel, node: nodeId(file.rel) });
    }
  }

  // Cross-file references: for each defined symbol, which other files mention it.
  const fileTexts = new Map();
  for (const file of files) fileTexts.set(file.rel, fs.readFileSync(file.abs, 'utf8'));
  for (const [key, def] of symbolIndex) {
    const refs = [];
    for (const [rel, text] of fileTexts) {
      if (rel === def.file) continue;
      // word-boundary mention of the symbol name anywhere in the file
      const escaped = def.symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`\\b${escaped}\\b`).test(text)) {
        refs.push({ file: rel, node: nodeId(rel) });
        edges.push({ from: def.node, to: nodeId(rel), kind: 'references', symbol: def.symbol });
      }
    }
    symbolIndex.set(key, { ...def, references: refs });
  }

  // dir grouping
  const dirs = new Map();
  for (const n of fileNodes) {
    const dir = n.path.split('/').slice(0, -1).join('/') || '.';
    if (!dirs.has(dir)) dirs.set(dir, []);
    dirs.get(dir).push(n.id);
  }
  const dirNodes = [];
  for (const [dir, ids] of dirs) {
    dirNodes.push({
      id: `dir__${dir.replace(/[\\/]/g, '__')}`,
      kind: 'dir',
      path: dir,
      symbols: [],
      imports: [],
      links: ids,
    });
  }

  return {
    root,
    fileCount: fileNodes.length,
    files: fileNodes,
    dirs: dirNodes,
    symbols: [...symbolIndex.values()],
    edges,
  };
}

// --- write -----------------------------------------------------------------

export function renderNodeMd(node) {
  let md = `# ${node.path}\n\n`;
  if (node.kind === 'dir') {
    md += `Directory node covering ${node.links.length} files.\n\n`;
    for (const id of node.links) md += `- [[${id}]]\n`;
  } else {
    md += `Symbols:\n\n`;
    if (node.symbols.length === 0) {
      md += `- _no symbols matched_\n`;
    } else {
      for (const s of node.symbols) md += `- \`${s.name}\` (${s.type})\n`;
    }
    if (node.imports.length > 0) {
      md += `\nImports:\n\n`;
      for (const imp of node.imports) {
        const target = imp.resolved ? `\`${imp.id}\`` : `\`${imp.specifier}\` (unresolved)`;
        md += `- ${target}\n`;
      }
    }
  }
  return md;
}

/** Write markdown nodes + wiring.json. Incremental: only touch changed files.
 *  Prunes stale .md nodes that no longer map to a node. */
export function writeOutputs(graph, outDir) {
  const graphDir = path.join(outDir, '.graph');
  fs.mkdirSync(graphDir, { recursive: true });

  const wiring = {
    root: graph.root,
    generatedAt: new Date().toISOString(),
    fileCount: graph.fileCount,
    nodeCount: graph.files.length + graph.dirs.length,
    files: graph.files,
    dirs: graph.dirs,
    symbols: graph.symbols,
    edges: graph.edges,
  };

  // existing node ids on disk, to prune stale ones
  const onDisk = fs.existsSync(outDir) ? fs.readdirSync(outDir).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, '')) : [];
  const liveIds = new Set([...graph.files, ...graph.dirs].map((n) => n.id));

  let changed = false;
  for (const node of [...graph.files, ...graph.dirs]) {
    const file = path.join(outDir, `${node.id}.md`);
    const md = renderNodeMd(node);
    const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    if (existing !== md) {
      fs.writeFileSync(file, md);
      changed = true;
    }
  }
  // prune stale
  for (const id of onDisk) {
    if (!liveIds.has(id)) {
      fs.rmSync(path.join(outDir, `${id}.md`), { force: true });
      changed = true;
    }
  }

  // wiring.json: write only when graph differs (skip generatedAt noise)
  const wiringPath = path.join(graphDir, 'wiring.json');
  const prev = fs.existsSync(wiringPath) ? JSON.parse(fs.readFileSync(wiringPath, 'utf8')) : null;
  const prevStripped = prev ? { ...prev, generatedAt: undefined } : null;
  const nextStripped = { ...wiring, generatedAt: undefined };
  const same = prevStripped && JSON.stringify(prevStripped) === JSON.stringify(nextStripped);
  if (!same) {
    fs.writeFileSync(wiringPath, JSON.stringify(wiring, null, 2));
    changed = true;
  }
  return { changed, nodeCount: wiring.nodeCount };
}

// --- CLI -------------------------------------------------------------------

function main() {
  const cfg = parseArgs();
  const graph = buildGraph(cfg.root, cfg);
  const res = writeOutputs(graph, cfg.outDir);
  const rel = path.relative(cfg.root, cfg.outDir) || 'graft';
  console.log(`context-map: ${graph.fileCount} files, ${res.nodeCount} nodes, ${graph.edges.length} edges -> ${rel}/`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) main();

export { main };
