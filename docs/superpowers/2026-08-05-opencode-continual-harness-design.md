# Continual Harness for OpenCode — Design

**Date:** 2026-08-05
**Status:** Approved (pending spec review)
**Scope:** A global opencode plugin that makes the agent self-improve over time, adapted from [PrimeIntellect-ai/prime-agent](https://github.com/PrimeIntellect-ai/prime-agent)'s Continual Harness.

## Problem

OpenCode sessions are ephemeral: useful working patterns, hard-won project knowledge, and recurring friction evaporate when a chat ends. Prime-agent solves this with a *Continual Harness* — durable, evidence-backed state (memories, skill descriptions, subagent specs, supplemental prompts) that the agent actively uses and refines through small, evidence-backed updates with rollback.

This spec adapts that concept to OpenCode's plugin/skill/agent extension surface.

## Goals

- Continuously capture evidence from real sessions without excessive disk/token cost.
- Maintain durable, versioned state that outlives any single chat window.
- Inject that state into new sessions so it is actively used.
- Provide a `/refine` loop that applies small, evidence-backed updates to memories, specs, and (when justified) new skills/agents — all snapshot-then-commit for rollback.
- Never rewrite the immutable base system prompt; only supplement it.

## Non-Goals

- Not a faithful port of prime-agent's RLM/IPython programming model.
- No background daemon, scheduling, heartbeats, or cross-agent messaging (out of scope for this iteration).
- No automatic writes without user awareness: refinements are suggested or user-triggered; asset creation requires approval.

## Architecture

Two state tiers, mirroring prime-agent's session-local + durable split:

```
~/.config/opencode/
├── plugins/harness.ts                        # plugin: hooks, tools, store, evidence
├── skills/harness-refine/SKILL.md            # workflow skill guiding /refine
├── commands/harness.md                       # /harness status|history|rollback
├── agents/refiner.md                         # dedicated subagent for /refine deep passes
└── harness/                                  # GLOBAL durable state (cross-project)
    ├── evidence.jsonl                        # append-only signal events
    ├── state.json                            # compiled memories + specs + versions
    ├── memories/                             # one file per memory (frontmatter + body)
    ├── specs/                                # reusable skill/subagent specs
    └── reflections/<ts>/                     # snapshot before each write -> rollback

.opencode/harness/                            # PER-PROJECT state (repo-local memories)
```

### State store

- **Global** (`~/.config/opencode/harness/`): cross-project memories and reusable specs, tagged by project path.
- **Per-project** (`.opencode/harness/` in each repo): repo-specific memories that should not leak across repos.
- `state.json` is the compiled, deduplicated, versioned view used for injection; `evidence.jsonl` is the raw append-only input. `reflections/<ts>/` snapshots the pre-write state of anything `/refine` modifies.

## Components

### 1. Evidence collection (automatic, plugin hooks)

- `tool.execute.after` — record failures and error signals: tool name, args summary, truncated output, exit status. Detect retry patterns (same tool repeated shortly after a failure).
- `event` — on `session.error`, `session.idle`, `session.created`: record outcome, duration, and scope.
- Deduplicate and cap per session so `evidence.jsonl` stays lean. Only signal-rich events are stored; routine successes are not.

### 2. Injection (state outlives the chat)

- `experimental.chat.system.transform` — prepend active memories (filtered to the session's project/scope) to the system prompt at session start.
- `experimental.session.compacting` — fold current harness state into the compaction prompt so long sessions don't lose it.
- Guardrail: supplemental injection only; the immutable base system prompt is never rewritten.

### 3. `/refine` loop (evidence-backed self-improvement)

Surface:

- Custom tool `harness_refine`.
- `/refine [focus]` command.
- `harness-refine` SKILL.md guiding the workflow.
- `refiner` subagent for deep passes.

The refine pass:

1. Reads the current trajectory (`client.session.messages`), recent evidence, existing harness state, and an inventory of existing skills/agents/commands.
2. Scores candidate improvements on: frequency, cost, risk, stability, coverage (same rubric as the existing `reflect` skill).
3. Applies writes, each **snapshot-then-commit**:
   - **memories** — add/strengthen/weaken with evidence references;
   - **spec updates** — refine existing skill descriptions / reusable subagent specs;
   - **new assets** — create brand-new skills or agents only when repeated friction justifies it (smallest-useful-form, conservative).
4. Weak evidence -> recommend *no change*.

### 4. Triggers

- On `session.idle` / `session.error` with enough new evidence, append a TUI toast/prompt suggesting `/refine`. Never auto-writes.
- Manual `/refine [focus]` anytime.
- `/harness status`, `/harness history`, `/harness rollback <id>`.

### 5. Relationship to existing `reflect` skill

Keep both; they are complementary.

- `reflect` — periodic deep audit (reads the OpenCode SQLite DB across sessions, session archaeology).
- harness — continuous incremental loop (live evidence hooks, memory store, rollback, injection).
- Cross-reference: reflect can propose new assets -> `/refine` snapshots them; harness evidence feeds reflect's archaeology.

## Design Decisions (locked during brainstorming)

| Question | Decision |
|----------|----------|
| Approach | A. Harness plugin (global plugin, hooks, tools, store) |
| State scope | Global + per-project |
| Refine trigger | Suggest on idle + manual `/refine` |
| Write scope | Full asset creation (memories, spec updates, new skills/agents) |
| Injection | System prompt injection + compaction fold |
| reflect overlap | Keep both, complementary |

## Error Handling

- **Evidence write failure:** log and continue; never block the session.
- **State file corruption:** if `state.json` fails to parse, fall back to recompiling from `memories/` + `specs/`; surface a warning.
- **Rollback target missing:** `/harness rollback` reports the missing snapshot id and lists the nearest available one.
- **Plugin hook failure:** hook wiring is isolated behind one adapter module; a thrown hook error must not break normal agent execution.

## Security / Privacy

- Harness state lives under the user's config directory and per-project `.opencode/`; no credentials or secrets are stored.
- Evidence truncates tool output; sensitive payloads are not persisted.
- All asset writes require user approval (permission `ask` for writes to skills/agents/commands).

## Testing / Verification

- Plugin loads without error (`opencode` start; plugin logs).
- Evidence hooks record on a scripted failure (verify `evidence.jsonl` gains an entry).
- Injection appears in a session's system prompt (verify via a short session + inspect messages).
- `/refine` run produces a memory write with a matching snapshot under `reflections/`.
- `/harness rollback <id>` restores the previous `state.json`.
- Windows compatibility: all file I/O via Node `fs`/`path`, no shell dependence.

## Proposed Build Order

1. Plugin skeleton + evidence hooks + store (verify plugin loads).
2. System-prompt injection + compaction fold.
3. `/refine` tool + skill + command + snapshot/rollback.
4. `refiner` subagent + `/harness` commands + idle-suggest.
5. Verification pass and docs.

## Trade-offs / Risks

- **System-prompt injection cost:** filtered + capped; only active memories (~a few hundred tokens).
- **Plugin API churn:** `experimental.*` hooks are versioned surface; isolate hook wiring behind one adapter module to ease upgrades.
- **Over-refinement:** conservative scoring + user approval on all asset writes; memory writes carry a review step.
