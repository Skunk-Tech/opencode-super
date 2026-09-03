/**
 * Context Map plugin for OpenCode.ai
 *
 * Auto-builds the regenerable structural map (scripts/build-context-map.js)
 * once per project at session start and injects a bootstrap note so the agent
 * knows the map is ready to read. Zero deps, no daemon, no per-prompt token tax.
 *
 * The map is a local, regenerable cache (like node_modules) — it is gitignored.
 *
 * Correctness notes (defect pass):
 *  - The note is injected ONLY after the build actually succeeds and the wiring
 *    graph exists; a failed/missing node/script no longer announces a map that
 *    is not there.
 *  - Builds are shared per project root across plugin instances, so loading the
 *    plugin twice (git install + local repo) triggers one build, not two.
 *  - makeNote/parseBuildOutput/ensureBuild are exported pure functions so the
 *    plugin is unit-testable without spawning node.
 */

import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outRel = 'graft/';

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
const defaultRunBuild = (scriptPath, cwd) =>
  new Promise((resolve) => {
    const child = spawn('node', [scriptPath], { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', () => {});
    child.on('error', () => resolve({ ok: false }));
    child.on('exit', (code) => {
      if (code !== 0) return resolve({ ok: false });
      const stats = parseBuildOutput(stdout);
      resolve({ ok: true, ...stats });
    });
  });

// Share one in-flight build per project root across plugin instances (double-load safe).
const inflight = new Map();

/** Ensure the map is built once for `root`, returning { ok, ... }. */
export const ensureBuild = (root, { runBuild = defaultRunBuild, scriptPath } = {}) => {
  if (!inflight.has(root)) {
    const script = scriptPath || path.resolve(__dirname, '../../scripts/build-context-map.js');
    const wiringOk = () => fs.existsSync(path.join(root, outRel, '.graph', 'wiring.json'));
    inflight.set(root, runBuild(script, root).then((res) => ({ ...res, ready: res.ok && wiringOk() })));
  }
  return inflight.get(root);
};

export const ContextMapPlugin = async ({ directory }) => {
  const root = directory || process.cwd();
  let injected = false;
  let buildReady = false;
  let cachedNote = null;

  // Kick off the build in the background; don't block plugin load.
  ensureBuild(root).then((res) => {
    buildReady = true;
    if (res.ready) cachedNote = makeNote(outRel);
  });

  return {
    'experimental.chat.messages.transform': async (_input, output) => {
      if (injected) return;
      if (!buildReady) return; // not built yet — wait for a later message/step
      if (!cachedNote || !output.messages.length) return;
      const firstUser = output.messages.find((m) => m.info?.role === 'user');
      if (!firstUser || !firstUser.parts.length) return;
      // Guard: skip if already injected (defensive; `injected` should suffice).
      if (firstUser.parts.some((p) => p.type === 'text' && p.text.includes('Context Map ready'))) {
        injected = true;
        return;
      }
      const ref = firstUser.parts[0];
      firstUser.parts.unshift({ ...ref, type: 'text', text: cachedNote });
      injected = true;
    },
  };
};

export default ContextMapPlugin;
