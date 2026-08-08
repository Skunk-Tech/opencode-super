# OpenCode Harness Self-Update Design

Date: 2026-08-08
Status: Approved
Related: [2026-08-05-opencode-continual-harness-design.md](./2026-08-05-opencode-continual-harness-design.md)

## Objective

Make the Continual Harness self-maintaining without user intervention:

1. **Auto-refine**: periodically run the harness refine loop on its own, so memories and specs stay fresh while the user works, instead of requiring a manual `/refine`.
2. **Auto-pull**: detect and install newer versions of the harness plugin itself, so improvements to the plugin propagate to installed machines without manual reinstall.

Both features are passive (no disruption to the user's workflow), bounded (cost-controlled), and safe (no destructive writes, atomic file replacement).

## Background / Constraints (verified from opencode source)

- **Plugins only run while opencode is open.** A `setInterval` timer inside the plugin fires only during active opencode sessions, not when the app is closed. "On a schedule" therefore means "while opencode is running."
- **opencode never re-fetches installed git plugins.** `Npm.add()` in `packages/core/src/npm.ts` returns early when `node_modules/<name>` already exists. There is no update check and no git metadata kept in the cache (`.git` is stripped). The plugin must self-manage updates.
- **The plugin factory receives an SDK `client`** (`PluginInput.client`). It exposes `client.session.create()`, `client.session.prompt()`, and `client.session.promptAsync()` — so a plugin can programmatically create a session and prompt it, which is the mechanism for auto-refine.
- **`import.meta.url` resolves at runtime** for the ESM bundle, giving the plugin its own on-disk path. This is how auto-pull locates and replaces its own bundle.
- The plugin currently writes only under `~/.config/opencode/harness/` (global state) and records evidence there. Project state is separate.

## Architecture

Two independent subsystems inside the existing `HarnessPlugin` (single-file bundle, `src/plugin.ts` + helpers).

### Subsystem A: Auto-Refine

**Trigger:** on `session.idle` events, after the session ends.

**Throttle / gating:**
- Only run when at least `AUTO_REFINE_MIN_EVIDENCE` (default 5) *new* evidence entries exist since the last auto-refine. "New" is tracked by a watermark: the maximum evidence `ts` seen at last refine time. Entries with `ts > watermark` count as new. This is robust to per-session caps and dedup (evidence timestamps are monotonic within a session and unique across sessions in practice).
- Apply at most `AUTO_REFINE_MAX_OPS` (default 3) refine ops per pass.
- A module-level `refining` flag prevents concurrent auto-refine runs.
- Store `{ lastAutoRefineAt, watermark }` in `~/.config/opencode/harness/refine-state.json`.

**Mechanism:**
1. On `session.idle`, read refine state and current evidence count.
2. If gate not met (too few new entries, already refining, or auto-refine disabled), return.
3. Create a throwaway session via `client.session.create()` with the `refiner` agent.
4. `client.session.prompt()` the session with the same refine workflow the `/refine` command uses (load `harness-refine` skill, review evidence, apply evidence-backed refinements via `harness_apply`).
5. On success, update the watermark. On failure, catch and leave the watermark unchanged so the next session retries. Never surface errors to the user.

**Cost control:** evidence gate + max ops per pass + throttle make auto-refine cheap and bounded.

### Subsystem B: Auto-Pull Plugin Updates

**Trigger:** a `setInterval` timer (`UPDATE_CHECK_HOURS`, default 6) while opencode runs, plus one check shortly after plugin load.

**Precondition:** auto-pull only runs when the plugin's own file path indicates a git-installed location (path contains the package cache layout, e.g. `packages/opencode-super@git+...`). For a local `file://` install (development), auto-pull is skipped.

**Mechanism:**
1. Determine the plugin's own bundle path via `import.meta.url`.
2. Fetch the latest commit SHA for the configured repo (`UPDATE_REPO`, default `Skunk-Tech/opencode-super`) from the GitHub API (`GET /repos/{owner}/{repo}/commits/main`).
3. Compare against a stored `version` marker file next to the plugin (e.g. `harness.version`). If the SHA is unchanged, stop.
4. If newer: download the latest `harness.js` bundle from `raw.githubusercontent.com` into a temp file.
5. Verify the download is non-empty; optionally verify its SHA-256 matches the announced tree SHA.
6. Atomically replace the plugin's own bundle via `write temp + rename`.
7. Update the version marker and surface a one-time notice that a restart is needed to load the update (via a `harness_status`-visible field or a session.idle toast).

**Failure handling:** network errors are silent no-ops. A failed or empty download never replaces the bundle. The plugin never deletes anything.

## Config (module constants, tunable without rebuild of logic)

- `AUTO_REFINE_ENABLED = true`
- `AUTO_REFINE_MIN_EVIDENCE = 5`
- `AUTO_REFINE_MAX_OPS = 3`
- `AUTO_UPDATE_ENABLED = true`
- `UPDATE_CHECK_HOURS = 6`
- `UPDATE_REPO = "Skunk-Tech/opencode-super"`

## Data flow

```
session.idle ──► autoRefineIfDue()
                    │ gate: refining flag, evidence threshold, state watermark
                    ├─ create refiner session (client.session.create)
                    ├─ prompt refine workflow (client.session.prompt)
                    ├─ update refine-state.json watermark
                    └─ catch: leave watermark, retry next session

plugin load / setInterval ──► checkForUpdates()
                    │ gate: AUTO_UPDATE_ENABLED, git-installed location
                    ├─ GitHub API: latest commit SHA
                    ├─ vs harness.version marker
                    ├─ download bundle → temp, verify
                    └─ atomic rename → new bundle + version marker + notice
```

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Refiner session creation/prompt fails | catch, leave watermark unchanged, retry next session, no user-visible error |
| Concurrent session.idle during refine | `refining` flag short-circuits |
| Offline / GitHub API unavailable | silent no-op, retry on next interval |
| Download empty / SHA mismatch | abort replacement, keep running bundle intact |
| Plugin not in git-installed location | auto-pull skipped |
| `import.meta.url` unavailable | auto-pull skipped |

## Testing

- **Unit:** throttle gate logic (evidence watermark threshold), SHA comparison, atomic-replace helper, refine state read/write.
- **Integration (offline):** updater against a local fixture directory that serves a fake newer bundle instead of real GitHub; refine gate against a temp harness state directory.
- **Smoke:** rebuild bundle, reinstall, confirm `opencode debug config` still loads the plugin and registers commands/agent.

## Scope / Non-Goals

- No project-directory writes. Both subsystems write only to `~/.config/opencode/harness/` and the plugin's own bundle.
- No auto-*disable* UI: knobs are module constants, not config-file options.
- No cross-machine sync of harness state.
- Auto-refine uses the existing refine workflow (skill + tools) unchanged.
