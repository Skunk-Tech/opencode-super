/**
 * Context Map plugin for OpenCode.ai
 *
 * Auto-builds the regenerable structural map (scripts/build-context-map.js)
 * once per project at session start and injects a bootstrap note so the agent
 * knows the map is ready to read. Zero deps, no daemon, no per-prompt token tax.
 *
 * The map is a local, regenerable cache (like node_modules) — it is gitignored.
 *
 * IMPORTANT — single export rule: opencode's plugin loader treats every exported
 * function of a discovered bare .js file under .opencode/plugins/ as a plugin and
 * calls it with a context object. So this file exports ONLY ContextMapPlugin.
 * Pure helpers (makeNote/parseBuildOutput/ensureBuild) live in
 * scripts/context-map-lib.js so they are testable without being mis-invoked as
 * plugins (the harness bundle and superpowers.js follow the same rule).
 */

import { makeNote, ensureBuild, outRelDefault } from '../../scripts/context-map-lib.js';

export const ContextMapPlugin = async ({ directory } = {}) => {
  // Discovery may call the plugin with a context where directory is not a usable
  // project path; only build when we have a real one, else stay a no-op.
  const root = typeof directory === 'string' && directory ? directory : '';
  let injected = false;
  let buildReady = true;
  let cachedNote = null;

  if (root) {
    buildReady = false;
    // Kick off the build in the background; don't block plugin load.
    ensureBuild(root).then((res) => {
      buildReady = true;
      if (res.ready) cachedNote = makeNote(outRelDefault);
    });
  }

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
