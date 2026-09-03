/**
 * Context Map shared helpers.
 *
 * Kept OUT of .opencode/plugins/ on purpose: opencode's plugin loader treats
 * every exported function of a discovered bare .js file as a plugin and calls
 * it with a context object. A file there must export exactly one function (the
 * plugin). These pure helpers live here instead so they are unit-testable
 * without being mis-invoked as plugins.
 */

import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const outRelDefault = 'graft/';

/** Build the agent-facing note. Pure, so the text is testable. */
export const makeNote = (mapPath) => {
  const note = `
**Context Map ready.** A regenerable structural map of this codebase was built at session start at \`<OUT>\`.

- Markdown nodes: \`graft/*.md\` — one per file/group, with symbols + imports.
- Wiring graph: \`graft/.graph/wiring.json\` — files, dirs, symbols, edges. Each symbol lists the files that reference it; import edges resolve to real node ids.

Use \`superpowers:context-map\` to read it. Callers of a symbol = find the symbol entry in \`wiring.json\` and read its \`references\`. Rebuild with:
\`\`\`bash
node scripts/build-context-map.js
\`\`\`
`;
  return note.replace('<OUT>', mapPath);
};

/** Parse the builder's stdout summary line into counts. Returns null when absent. */
export const parseBuildOutput = (text) => {
  const m = String(text || '').match(/context-map:\s+(\d+)\s+files,\s+(\d+)\s+nodes,\s+(\d+)\s+edges/);
  if (!m) return null;
  return { fileCount: Number(m[1]), nodeCount: Number(m[2]), edgeCount: Number(m[3]) };
};

/** Spawn `node scripts/build-context-map.js` in a project root. Injectable for tests. */
export const defaultRunBuild = (scriptPath, cwd) =>
  new Promise((resolve) => {
    if (typeof cwd !== 'string' || !cwd) return resolve({ ok: false, ready: false });
    const child = spawn('node', [scriptPath], { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', () => {});
    child.on('error', () => resolve({ ok: false, ready: false }));
    child.on('exit', (code) => {
      if (code !== 0) return resolve({ ok: false, ready: false });
      const stats = parseBuildOutput(stdout);
      resolve({ ok: true, ready: true, ...stats });
    });
  });

// Share one in-flight build per project root across plugin instances (double-load safe).
const inflight = new Map();

/** Ensure the map is built once for `root`, returning { ok, ready, ... }. */
export const ensureBuild = (root, { runBuild = defaultRunBuild, scriptPath } = {}) => {
  if (typeof root !== 'string' || !root) {
    return Promise.resolve({ ok: false, ready: false });
  }
  if (!inflight.has(root)) {
    // This lib lives in scripts/ next to build-context-map.js.
    const script = scriptPath || path.resolve(__dirname, './build-context-map.js');
    const wiringOk = () => fs.existsSync(path.join(root, outRelDefault, '.graph', 'wiring.json'));
    inflight.set(root, runBuild(script, root).then((res) => ({ ...res, ready: res.ok && wiringOk() })));
  }
  return inflight.get(root);
};
