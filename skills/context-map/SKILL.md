---
name: context-map
description: Use when exploring or orienting in an unfamiliar or large codebase before building or debugging, or when the build-test-tune loop needs to skip re-exploring the repo each iteration. Triggers on "map the codebase", "how is this project structured", "find all callers of X", "show me the architecture", "speed up exploration", or when a subagent keeps re-grepping the same files.
---

# Context Map

## Overview

Build and read a regenerable, agent-readable structural map of the codebase — a zero-dependency mirror of Graft's structural tier. It skips the agent's repeated repo rediscovery so each build-test-tune iteration starts oriented instead of blind.

**Core principle:** Build the map once, read it, don't rebuild it every turn.

## When to Use

- Orienting in an unfamiliar or large codebase before building or debugging.
- Finding all callers/references of a symbol, or what a file imports.
- The build-test-tune loop repeatedly re-greps the same files each iteration.
- A subagent needs to know the project structure before writing code.

## Build the Map

Run the builder once at the start of a session (or when the code has moved significantly):

```bash
node scripts/build-context-map.js [dir] [--extensions ts,py,go,php,js,json] [--out graft/]
```

- `dir` defaults to the current working directory.
- Writes to `graft/` (gitignored): one `.md` node per file/group plus `graft/.graph/wiring.json`.
- Incremental by content hash: re-running only rebuilds changed files.
- Structural tier is deterministic — no LLM, no key, no network.

The map is a local, regenerable cache like `node_modules`. Commit the wiring if you want teammates to share it; each runs `build-context-map.js` to regenerate their own.

## Read the Map

The map has two shapes:

- **Markdown nodes** (`graft/*.md`) — human-readable, one per file or directory. Each lists symbols and imports. Directories link to their files via `[[wikilinks]]`.
- **Wiring graph** (`graft/.graph/wiring.json`) — machine-readable: files, dirs, symbols, and edges (`imports` + `references`).

To find callers of a symbol, read that symbol's `references` entries (each lists a file that mentions it). To find what a file depends on, read its import edges (resolved to real node ids) or its markdown node's Imports section.

```bash
node -e '
const w=require("./graft/.graph/wiring.json");
const sym=w.symbols.find(s=>s.symbol==="getBootstrapContent");
console.log((sym?.references||[]).map(r=>r.file));
'
```

## Wire Into Iterative Execution

When the loop builds → tests → tunes across many tasks, build the map once and hand each subagent the relevant nodes so it doesn't re-grep the repo.

1. Build the map (above) at loop start.
2. Before dispatching a build subagent, read `wiring.json` for that task's files and pass the matching node paths.
3. The subagent reads the node's Imports and Symbols, opens only the files it needs, writes code.
4. If the code changes a lot, rebuild the map before the next batch.

This keeps the orchestrator thin (see `superpowers:iterative-execution`) and each subagent focused.

## Common Mistakes

- Rebuilding the map every iteration instead of once per session.
- Passing the whole `graft/` to every subagent instead of just the relevant nodes.
- Reading `wiring.json` as JSON without `require`/`JSON.parse` in Node.
- Forgetting to `gitignore graft/` so the cache isn't committed.

## Related Skills

- **superpowers:iterative-execution** — the loop that drives the map.
- **superpowers:subagent-driven-development** — how to hand subagents focused context.
