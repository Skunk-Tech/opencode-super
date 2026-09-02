#!/usr/bin/env node
/**
 * build-context-map.js
 *
 * Build a regenerable, agent-readable structural map of a codebase — a
 * zero-dependency mirror of Graft's structural tier. Reads source files,
 * extracts symbols, groups them into nodes, links them, and writes markdown
 * nodes with [[wikilinks]] plus a per-symbol wiring graph.
 *
 * Deterministic structural tier: no LLM, no network, no key. The map is a
 * local, regenerable cache (like node_modules), not a committed artifact.
 *
 * Usage:
 *   node scripts/build-context-map.js [dir] [--extensions .ts,.py,...]
 *       [--include src,**] [--exclude test,**] [--out graft/]
 *
 * Output (gitignored):
 *   <out>/*.md            one node per file/group, with [[wikilinks]]
 *   <out>/.graph/wiring.json   per-symbol edges + build metadata
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// --- arg parsing -----------------------------------------------------------

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const flag = (name) => argv.includes(name);

const positional = argv.find(
  (a) => !a.startsWith('--') && a !== arg('--extensions', '') && a !== arg('--out', 'graft')
);
const root = path.resolve(positional || process.cwd());
const outDir = path.resolve(root, arg('--out', 'graft'));
const exts = (arg('--extensions', '') || 'ts,tsx,js,jsx,mjs,cjs,py,go,php,rs,java,kt,rb')
  .split(',')
  .map((e) => e.trim().replace(/^\./, '').toLowerCase())
  .filter(Boolean);
const includeGlobs = (arg('--include', '') || '**/*')
  .split(',')
  .map((g) => g.trim())
  .filter(Boolean);
const excludeGlobs = (arg('--exclude', 'node_modules,dist,.git,__pycache__,**/test,**/test,**/tests') || '')
  .split(',')
  .map((g) => g.trim())
  .filter(Boolean);

// --- helpers ---------------------------------------------------------------

const hash = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

const globMatch = (relPath, patterns) =>
  patterns.some((p) => {
    if (p === '**/*') return true;
    const segments = relPath.split('/');
    for (const seg of segments) {
      const re = new RegExp(
        '^' + p.replace(/\./g, '\\.').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*') + '$'
      );
      if (re.test(seg)) return true;
    }
    return false;
  });

const collectFiles = (dir, rel = '') => {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'graft' || entry.name === '.graph') continue;
      files.push(...collectFiles(abs, relPath));
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).replace(/^\./, '').toLowerCase();
      if (!exts.includes(ext)) continue;
      if (!globMatch(relPath, includeGlobs)) continue;
      if (globMatch(relPath, excludeGlobs)) continue;
      files.push({ abs, rel: relPath, ext });
    }
  }
  return files;
};

// --- symbol extraction -----------------------------------------------------

const extractSymbols = (file, text) => {
  const ext = file.ext;
  const symbols = [];
  const re = (p) => new RegExp(p, 'gm');
  const rules = {
    ts: [
      [re(/export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/g), 'function'],
      [re(/export\s+class\s+([A-Za-z0-9_$]+)\b/g), 'class'],
      [re(/export\s+const\s+([A-Za-z0-9_$]+)\s*=/g), 'const'],
    ],
    js: [
      [re(/\bfunction\s+([A-Za-z0-9_$]+)\s*\(/g), 'function'],
      [re(/\bclass\s+([A-Za-z0-9_$]+)\b/g), 'class'],
    ],
    py: [
      [re(/^\s*def\s+([A-Za-z0-9_]+)\s*\(/gm), 'function'],
      [re(/^\s*class\s+([A-Za-z0-9_]+)\b/gm), 'class'],
    ],
    go: [[re(/\bfunc\s+(?:\([^)]*\)\s*)?([A-Za-z0-9_]+)\s*\(/g), 'function']],
    php: [[re(/\bfunction\s+([A-Za-z0-9_]+)\s*\(/g), 'function']],
    rs: [[re(/\bfn\s+([A-Za-z0-9_]+)\s*\(/g), 'function']],
    java: [[re(/\b(?:public|private|protected)?\s*(?:static\s+)?[A-Za-z0-9_<>]+\s+([A-Za-z0-9_]+)\s*\(/g), 'function']],
    kt: [[re(/\bfun\s+([A-Za-z0-9_]+)\s*\(/g), 'function']],
    rb: [[re(/\bdef\s+([A-Za-z0-9_]+)\s*(?:\(|$)/g), 'function']],
  };
  const tiers = [ext, 'generic'];
  for (const key of tiers) {
    const list = rules[key];
    if (!list) continue;
    for (const [regex, type] of list) {
      let m;
      while ((m = regex.exec(text)) !== null) symbols.push({ name: m[1], type });
    }
  }
  return symbols;
};

const extractImports = (text) => {
  const deps = new Set();
  let m;
  const importRe = /(?:import\s+['"]([^'"]+)['"]|require\(['"]([^'"]+)['"]\)|from\s+['"]([^'"]+)['"])/gm;
  while ((m = importRe.exec(text)) !== null) {
    const src = m[1] || m[2] || m[3];
    if (src && src.startsWith('.')) deps.add(src);
  }
  return [...deps];
};

// --- build -----------------------------------------------------------------

const graphDir = path.join(outDir, '.graph');
fs.mkdirSync(graphDir, { recursive: true });

const files = collectFiles(root);
const nodes = [];
const symbolIndex = new Map();
const edges = [];

for (const file of files) {
  const buf = fs.readFileSync(file.abs);
  const h = hash(buf);
  const text = buf.toString('utf8');
  const symbols = extractSymbols(file, text);
  const imports = extractImports(text);

  const node = {
    id: file.rel.replace(/[\\/]/g, '__'),
    kind: 'file',
    path: file.rel,
    hash: h,
    symbols,
    imports,
  };
  nodes.push(node);

  for (const s of symbols) {
    symbolIndex.set(`${file.rel}#${s.name}`, { node: node.id, symbol: s.name, type: s.type, file: file.rel });
  }
  for (const imp of imports) {
    edges.push({ from: node.id, to: imp, kind: 'imports' });
  }
}

// group nodes by directory
const dirs = new Map();
for (const node of nodes) {
  const dir = node.path.split('/').slice(0, -1).join('/') || '.';
  if (!dirs.has(dir)) dirs.set(dir, []);
  dirs.get(dir).push(node.id);
}
for (const [dir, ids] of dirs) {
  if (ids.length < 1) continue;
  nodes.push({
    id: `dir__${dir.replace(/[\\/]/g, '__')}`,
    kind: 'dir',
    path: dir,
    symbols: [],
    imports: [],
    links: ids,
  });
}

// --- write markdown nodes --------------------------------------------------

const link = (id) => `[[${id}]]`;
const nodeFile = (id) => path.join(outDir, `${id}.md`);

for (const node of nodes) {
  let md = `# ${node.path}\n\n`;
  if (node.kind === 'dir') {
    md += `Directory node covering ${node.links.length} files.\n\n`;
    for (const id of node.links) {
      const n = nodes.find((x) => x.id === id);
      if (n) md += `- ${link(n.id)}\n`;
    }
  } else {
    md += `Symbols:\n\n`;
    if (node.symbols.length === 0) {
      md += `- _no symbols matched_\n`;
    } else {
      for (const s of node.symbols) {
        md += `- \`${s.name}\` (${s.type})\n`;
      }
    }
    if (node.imports.length > 0) {
      md += `\nImports:\n\n`;
      for (const imp of node.imports) md += `- ${imp}\n`;
    }
  }
  fs.writeFileSync(nodeFile(node.id), md);
}

// --- write wiring graph ----------------------------------------------------

fs.writeFileSync(
  path.join(graphDir, 'wiring.json'),
  JSON.stringify(
    {
      root,
      generatedAt: new Date().toISOString(),
      fileCount: nodes.filter((n) => n.kind === 'file').length,
      nodeCount: nodes.length,
      extensions: exts,
      files: nodes.filter((n) => n.kind === 'file'),
      dirs: nodes.filter((n) => n.kind === 'dir'),
      symbols: [...symbolIndex.values()],
      edges,
    },
    null,
    2
  )
);

console.log(
  `context-map: ${nodes.filter((n) => n.kind === 'file').length} files, ${nodes.length} nodes, ${edges.length} edges -> ${path.relative(root, outDir)}/`
);
