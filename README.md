# opencode-super

**Make opencode better every session — automatically.**

opencode-super is a single, self-installing plugin that pairs two powerful systems for [opencode](https://opencode.ai):

- **Superpowers** — a battle-tested library of agent workflow skills (brainstorming, test-driven development, systematic debugging, subagent-driven development, writing plans, and more), the same methodology used to build this plugin.
- **The Continual Harness** — a self-improving agent harness. It watches how you work, records what succeeds and what fails, and quietly refines its own memories and specs so your agent gets smarter over time — without you doing a thing.

One line in your config. No file copying. No manual setup. It installs, it observes, it improves.

---

## Why you want this

Standard agents start every session blank. They relearn your project's quirks, your conventions, and the same painful gotchas over and over.

The Continual Harness fixes that. It gives your agent **a memory that persists between sessions** and **a brain that refines itself**:

- **Remembers what it learns.** Errors, fixes, and working patterns are captured as evidence and distilled into durable memories and specs — injected into every future session's system prompt.
- **Improves on its own schedule.** After enough new evidence, the harness runs its `/refine` loop automatically. It proposes conservative, evidence-backed improvements to its own memory. Nothing is guessed; everything is traceable and rollback-able.
- **Keeps itself updated.** The plugin checks for new versions of itself and upgrades in place. You always run the latest harness.
- **Stops quitting early.** Models sometimes stop mid-task. The harness detects premature stops, nudges continuation, and logs the behavior as evidence so the pattern can be corrected.
- **Fits any project.** Memories and specs are scoped global or per-project, so each repo gets exactly the context it needs.

**In short: you spend less time re-explaining your project, and your agent makes fewer repeat mistakes, every single week.**

---

## Install

Requires [opencode](https://opencode.ai) and [Bun](https://bun.sh) (for building from source; plain install needs neither).

Add one line to your opencode config — global for every project, or per-project:

**Global** — `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["opencode-super@git+https://github.com/Skunk-Tech/opencode-super.git"]
}
```

**Per-project** — `.opencode/opencode.json` in your repo root:

```json
{
  "plugin": ["opencode-super@git+https://github.com/Skunk-Tech/opencode-super.git"]
}
```

Then **restart opencode**.

> **Upgrading from Superpowers:** if you already list `superpowers@git+...` in your `plugin` array, remove it. opencode-super includes it — keeping both causes conflicts.

opencode's built-in plugin installer fetches the package from this repository, so updates are pulled automatically on restart.

---

## First run

1. Add the plugin line and restart opencode.
2. Work normally — open a session, build something, hit a few problems. Every tool call, error, and session is silently recorded as evidence (nothing leaves your machine; it's stored under `~/.config/opencode/harness/`).
3. That's it. The harness self-refines when enough evidence accumulates. Or trigger a review yourself anytime with `/refine`.

No configuration, no prompts, no friction.

---

## What you get

### Superpowers (workflow skills)

The full skills library, injected into every session, including:

`brainstorming` · `writing-plans` · `executing-plans` · `subagent-driven-development` · `test-driven-development` · `systematic-debugging` · `requesting-code-review` · `receiving-code-review` · `verification-before-completion` · `using-git-worktrees` · `dispatching-parallel-agents` · `writing-skills` · `find-skills`

### Continual Harness (self-improvement)

**Automatic evidence capture**
- Tool outcomes (`tool.execute.after`), session events, and failures are recorded into `~/.config/opencode/harness/evidence.jsonl`, deduplicated and capped per session.

**Durable, versioned memory**
- Memories and specs (skills / subagents) stored globally or per-project.
- Active memories are injected into the system prompt each session; the full harness state folds into context on compaction.
- Every change is snapshotted; anything can be rolled back.

**The `/refine` loop**
- Reviews recent evidence against current state and proposes conservative, evidence-backed improvements.
- **Self-running:** after ≥5 new evidence entries since the last refine, it runs automatically on session end (max 3 changes per pass). Disable anytime.
- **Self-updating:** the plugin checks this repository for a new version every 6 hours while opencode is open, and installs it in place (restart to load).

**Premature-stop protection**
- Detects when a model stops early after tool activity, logs it as evidence, and injects a continuation nudge into the system prompt so future sessions push tasks to completion.

### Commands

| Command | Purpose |
|---------|---------|
| `/refine` | Review evidence and apply evidence-backed refinements (optionally scoped: `/refine <focus>`) |
| `/harness status` | Show memory/spec counts, evidence totals, snapshots, last auto-refine, and update status |
| `/harness history` | List snapshot IDs for rollback |
| `/harness rollback <id>` | Roll the harness state back to a snapshot |

### Custom tools

The harness exposes five tools for the `refiner` subagent (used by `/refine`): `harness_refine`, `harness_apply`, `harness_status`, `harness_history`, `harness_rollback`.

---

## Configuration

All knobs are module constants in `opencode-harness/src/`. If you build from source, you can tune them:

| Constant | Default | Purpose |
|----------|---------|---------|
| `AUTO_REFINE_ENABLED` | `true` | Run the refine loop automatically |
| `AUTO_REFINE_MIN_EVIDENCE` | `5` | New-evidence threshold before auto-refine runs |
| `AUTO_REFINE_MAX_OPS` | `3` | Max changes applied per auto-refine pass |
| `AUTO_UPDATE_ENABLED` | `true` | Check for plugin updates on a schedule |
| `UPDATE_CHECK_HOURS` | `6` | Hours between update checks |
| `UPDATE_REPO` | `Skunk-Tech/opencode-super` | Repository to check for updates |

### Choose the model the plugin's work uses

The harness's own work — the `refiner` subagent that runs `/refine`, `/harness`, and the automatic refine loop — uses your session's model by default. You can pin it to any model you have **registered** in your `opencode.json` providers.

Pass it as a plugin option by writing the plugin entry in array form:

```json
{
  "plugin": [["opencode-super@git+https://github.com/Skunk-Tech/opencode-super.git", { "model": "omni-deepseek/ds/deepseek-v4-flash" }]]
}
```

Or set it the standard opencode way — configure the `refiner` agent's model directly (this wins over the plugin option):

```json
{
  "plugin": ["opencode-super@git+https://github.com/Skunk-Tech/opencode-super.git"],
  "agent": { "refiner": { "model": "anthropic/claude-sonnet-4-5" } }
}
```

The model applies to the `refiner` agent and the `/refine` + `/harness` commands, and is forwarded to auto-refine sessions so the plugin's work uses your chosen model. Auto-refine sessions are created **nested under the session that triggered them**, matching the desktop app's built-in nested-session display.

> **Note on the desktop app Settings GUI:** the opencode desktop Settings dialog currently has no plugin-settings panel, so this model is configured in `opencode.json` rather than through a settings checkbox. A native GUI picker for plugin settings would need an upstream opencode feature (a plugin settings panel); until then this config-file surface is the supported way to choose the model.

---

## Repository layout

```
opencode-harness/          # the harness SOURCE (dev repo)
  src/                     #   plugin entry, evidence store, refine engine, updater
  test/                    #   bun test suite (79 tests)
  scripts/                 #   build + install scripts
  assets/                  #   skill, command, and agent definitions
.opencode/plugins/         # the INSTALL package (built, ready to load)
  index.js                 #   package.json main — re-exports both plugins
  superpowers.js           #   upstream Superpowers plugin
  harness.js               #   harness plugin (self-contained bundle)
skills/                    # Superpowers skills + harness-refine
docs/superpowers/          # design specs and implementation plans
```

### Build the harness from source

```bash
cd opencode-harness
bun install
bun test              # run the suite (79 tests)
bun run build         # produces dist/harness.js with all deps inlined
bun run install:harness  # install into ~/.config/opencode/ (dev use)
```

After changing source, rebuild and sync the installed bundle:

```bash
cd opencode-harness
bun run build
cp dist/harness.js ../.opencode/plugins/harness.js
```

---

## Privacy & safety

- **All data stays local.** Evidence, memories, and specs live under `~/.config/opencode/harness/` (or your project's `.opencode/harness/`). Nothing is uploaded anywhere.
- **No project writes from the harness itself.** It only writes to the harness state directory and, for self-update, its own bundle file.
- **Every change is reversible.** The refine loop snapshots state before any write, and `/harness rollback <id>` restores it.
- **Conservative by default.** Weak evidence means no change. Refinements require repeated, consistent evidence.

---

## Updating

The plugin checks for updates automatically (every 6 hours while opencode is open) and installs them in place. When an update is downloaded you'll see it in `/harness status`; **restart opencode** to load it.

You can also force a refresh manually:

```bash
opencode update
```

---

## License

See [LICENSE](LICENSE). This package bundles [obra/superpowers](https://github.com/obra/superpowers) (MIT) and the Continual Harness.

**opencode-super** — a plugin that makes opencode a little better, every session.
