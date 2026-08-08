# opencode-super

A combined opencode plugin package: **Superpowers** (workflow skills + bootstrap) **plus** the **Continual Harness** (a self-improving agent harness with evidence capture, durable memories, and a `/refine` loop).

Reference it once in your opencode config and both plugins load — no file copying, no extra install steps.

## Install (Linux / macOS / Windows)

Add this line to your global config `~/.config/opencode/opencode.json` (or `.opencode/opencode.json` for a single project):

```json
{
  "plugin": ["opencode-super@git+https://github.com/Skunk-Tech/opencode-super.git"]
}
```

OpenCode's own plugin installer fetches and updates the package automatically. If you already list `superpowers@git+...` in your `plugin` array, remove it — this package supersedes it.

## What you get

**From Superpowers (upstream `obra/superpowers`):**
- The full skills library (brainstorming, TDD, systematic-debugging, subagent-driven-development, writing-plans, etc.)
- The `using-superpowers` bootstrap injected into each session

**From the Continual Harness:**
- Automatic evidence capture (`tool.execute.after`, session events) into `~/.config/opencode/harness/`
- Durable, versioned memories and skill/subagent specs (global + per-project)
- System-prompt injection of active memories; compaction-fold of harness state
- `/refine` — evidence-backed self-improvement loop with snapshot/rollback
- `/harness status`, `/harness history`, `/harness rollback <id>`

These are provided as the `HarnessPlugin` custom tools (`harness_refine`, `harness_apply`, `harness_status`, `harness_history`, `harness_rollback`), the `refiner` subagent, and the `refine`/`harness` commands.

## First run

1. Restart opencode after adding the plugin line.
2. Start a session and let it do some work (failures generate evidence).
3. Run `/refine` to review evidence and apply conservative, rollback-able improvements.

## Layout

```
.opencode/plugins/
  index.js         # re-exports both plugins (package.json main)
  superpowers.js   # upstream superpowers plugin (unmodified)
  harness.js       # harness plugin (self-contained bundle)
skills/            # superpowers skills + harness-refine/SKILL.md
```

## Rebuilding the harness bundle

The harness source lives in the separate `opencode-harness/` package. To rebuild `harness.js` after changing it:

```bash
cd opencode-harness
bun run build        # produces dist/harness.js with deps inlined
cp dist/harness.js ../opencode-super/.opencode/plugins/harness.js
```

## Updating

```
opencode update   # or bump the ref / reinstall the plugin
```
