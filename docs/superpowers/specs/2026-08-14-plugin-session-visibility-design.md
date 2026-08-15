# Plugin Session Visibility: Nest, Hide, and Model Control for Refiner Sessions

**Date:** 2026-08-14

## Problem

The opencode Continual Harness plugin's **auto-refine** creates a new, fully
visible session every time it runs. `runAutoRefine()` in
`opencode-harness/src/autorefine.ts` calls `client.session.create({ query: {
directory } })` and prompts that session with the `refiner` agent. Because
these sessions are created as top-level sessions (no `parentID`), every one
appears as a new row in the opencode desktop app's session list. For a user
running opencode for real work, this floods the session list and buries their
actual sessions.

The user wants:

1. Plugin-created sessions placed **beneath** the real sessions they came from.
2. A **settings switch** to turn the visibility of those plugin sessions on or
   off.
3. The ability to choose **which model** the plugin's sessions use (e.g. a
   local model instead of an API model), since the plugin sessions consume
   tokens.

The desktop app (`packages/app`) is the primary surface where this is seen.

## Investigation Findings

The opencode server and desktop app already contain most of the machinery
needed. The plugin just is not using it.

- `Session` objects have a `parentID` field. `session.create` accepts
  `body.parentID`. Sessions created with a parent become "child" sessions.
- The desktop app's home session list **already filters out** any session with
  a `parentID` set or with `time.archived` set
  (`packages/app/src/context/global-sync/home-session-index.ts`,
  `parseHomeSessionIndex` / `applyHomeSessionEvent`). Child and archived
  sessions do not appear as top-level rows.
- Sessions have a `time.archived` field, settable via `session.update`. The
  desktop app exposes an archive action already.
- `session.create` and `session.promptAsync` accept a `model` override
  (`{ providerID, modelID }`), so the refiner can be pointed at any configured
  model, including a local one.

Consequence: this is a **plugin-only change**. No opencode core
server/UI patch is required for the visibility and nesting requirements; the
desktop app's existing parentID/archive filtering does the work once the plugin
starts creating sessions as children (or archiving them).

Note on "beneath the real sessions": the desktop app filters child sessions out
of the home list rather than rendering an expandable tree under each parent. So
"nested" mode means "attached to the real session as a child and removed from
the top-level list", not "indented under it in a visible tree". This matches the
user's goal of no longer losing the real sessions.

## Current Plugin Behavior

`opencode-harness/src/plugin.ts`:

- The plugin factory is `HarnessPlugin: Plugin = async ({ directory, client })
  => { ... }`. It does **not** currently accept plugin options.
- The `event` hook listens for `session.idle`. On idle it calls
  `runAutoRefine(refineClient, directory, global, project, { enabled, ... })`.
- A `refineClient` adapter wraps the SDK client's `session.create` /
  `session.promptAsync`.

`opencode-harness/src/autorefine.ts`:

- `runAutoRefine` checks the evidence gate (`>= 5` new entries for this
  project), then calls `client.session.create({ query: { directory } })` and
  `client.session.promptAsync({ path: { id }, body: { agent: "refiner",
  parts: [...] } })`.
- It writes a watermark to `refine-state.json` on success.

The `/refine` and `/harness` commands are user-invoked and should remain normal,
visible sessions. Only the auto-refine spawned sessions are affected by this
change.

## Design

### 1. Nest auto-refine sessions under the triggering real session

The `session.idle` event handler already has the triggering session's `id`.
Thread it through to auto-refine so the created session is a child:

- `plugin.ts` event hook: pass `parentID: id` (when available) into
  `runAutoRefine`.
- `autorefine.ts` `runAutoRefine(..., { parentID })`: pass
  `body: { parentID, title: "[harness] refine" }` to `session.create`.

Result: refiner sessions become children of the real session that triggered
them, and the desktop app's existing `parentID` filtering hides them from the
home list.

### 2. Always nest (no toggle)

The visibility switch from the original brainstorming was intentionally dropped
after implementation review: the user confirmed always-nest is the desired
behavior and a toggle is not needed. Every auto-refine session is created as a
child of the triggering session, which the desktop app already hides from the
home list. No `sessionVisibility` option exists.

### 3. Configurable refiner model

Extend the plugin factory to accept the opencode plugin-options tuple form and
read a `model` option (string like `"provider/model-id"`):

```jsonc
// ~/.config/opencode/opencode.jsonc
"plugin": [
  ["opencode-super@git+https://github.com/Skunk-Tech/opencode-super.git",
   { "model": "omni-deepseek/ds/deepseek-v4-flash" }]
]
```

- When set, pass the string directly to the `refiner` agent definition's `model`
  field in the `config` hook so both auto-refine and the `/refine` command use
  it.
- Also pass it as `model` on `session.create` / `promptAsync` for the auto-refine
  path. The SDK accepts `model: { providerID, modelID }`; `parseModelRef` splits
  the `"provider/model-id"` string on the first `/` to build that object
  (handling slashes in the model id itself, e.g. `ds/deepseek-v4-flash`).
- When unset, keep the current default model behavior. A user-set
  `agent.refiner.model` wins over the plugin option.

### 4. Build and ship

- Rebuild the bundle: `bun run build` in `opencode-harness/`, then copy
  `opencode-harness/dist/harness.js` to `.opencode/plugins/harness.js` (the
  artifact fetched by the self-updater).
- Update tests: `opencode-harness/test/plugin.test.ts` and
  `opencode-harness/test/autorefine.test.ts` for the new factory signature and
  options.

## Out of Scope

- No change to the `/refine` and `/harness` commands (user-invoked, stay normal
  sessions).
- No opencode core/UI patch. An expandable visible tree under each parent
  session is explicitly out of scope (would require a core UI change); nesting
  means filtered from the home list and attached to the parent.
- No auto-refine gating/throttling changes beyond the existing watermark.
- No visibility toggle / archive-on-complete option. Always-nest was confirmed
  as the final behavior.

## Files Touched

- `opencode-harness/src/autorefine.ts`
- `opencode-harness/src/plugin.ts`
- `opencode-harness/test/autorefine.test.ts`
- `opencode-harness/test/plugin.test.ts`
- `.opencode/plugins/harness.js` (rebuilt bundle)
- `README.md` or `docs/` (document the new plugin options)

## Verification

- `bun test` in `opencode-harness/` passes.
- `bun run build` produces a bundle; `.opencode/plugins/harness.js` is updated.
- Manual check in the desktop app: after auto-refine runs, no new top-level
  session appears; the session list stays clean. With `sessionVisibility:
  "visible"`, the old behavior returns.
- With `refinerModel` set, auto-refine sessions use that model (observable in
  the session's model indicator).
