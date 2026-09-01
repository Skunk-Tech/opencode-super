---
name: iterative-execution
description: Use when running a build-test-tune loop over a written implementation plan until the project is complete or blocked - keep iterating in subagents while watching the context window, resuming from a file-based checkpoint across sessions. Triggers on "keep going until done", "run the loop", "iterate until complete", "build test tune loop", or resuming a previous execution session.
---

# Iterative Execution

## Overview

Run a **build → test → tune** loop over a written plan until the project is complete or blocked. Keep the orchestrator's context thin by doing the work in subagents, and checkpoint to a file so the loop resumes across sessions and restarts.

**Core principle:** Evidence before claims, loop until done-or-blocked, stay thin.

## When to Use

- A plan exists (from `writing-plans` / `executing-plans`) and you want it executed to completion through repeated build-test-tune cycles.
- The work spans many tasks and the loop must survive context pressure or a model/session restart.
- Resuming a previous execution session mid-loop.

**Not this skill:** a single linear run of a short plan (use `executing-plans`), or the initial planning phase (use `writing-plans`).

## The Loop

```
START → load plan + checkpoint → LOOP {
  1. pick next unstarted task (project → phase → task order)
  2. dispatch BUILD work to a subagent
  3. run VERIFICATION (tests/lint) — fresh, full output
  4. pass → mark task done, checkpoint, continue
  5. fail → dispatch TUNE subagent (diagnose + targeted fix), retry
  6. after 5 tries → mark BLOCKED, capture last error, checkpoint, exit
}
→ all green? finish-a-development-branch : report done/blocked state
```

**Continuous execution:** do not pause to check in between tasks. Execute until everything is green or something is blocked. "Should I continue?" prompts waste time — the plan says execute, so execute.

## The Three Levels

Loop over the plan in this order — project, then phase, then task.

- **Task** — one unit of work in the plan. A task is "done" only when its own verification passes.
- **Phase** — a group of tasks. Track phase completion for the checkpoint and the final summary.
- **Project** — the whole plan. "Complete" = every task green or blocked.

## The 5-Try Blocked Rule

Each task carries a `tries` counter in the checkpoint file.

1. Build (subagent) → test → if fail, Tune (subagent: read failure, targeted fix) → retry.
2. Repeat up to **5 tries** per task.
3. On the 5th failure, mark the task `blocked`, capture the last error, checkpoint, and exit the loop.

"Tune" is a diagnosis pass, not a blind re-run. If the same error repeats, the fix must change the approach, not just retry.

## Context Guard (A + B)

- **A — Subagents only:** build and tuning run in subagents with isolated context. The orchestrator stays thin regardless of how long the loop runs. Construct each subagent's instructions exactly — it should not inherit the orchestrator's history.
- **B — Token meter:** before each iteration, check an estimated context meter (remaining tokens). If it is getting tight, force a checkpoint and yield to your human partner — resume later — even if the current task is not done.

Subagents keep the main context thin; the token meter is the safety net that hands back to you before the window actually fills.

## The Checkpoint File

The loop persists state to a single JSON file so it can resume across sessions and restarts.

**Location:** `.opencode/iteration-state.json` at the **project root** (anchored to the repo root, not the global config dir, so each project keeps its own state and never collides with another).

**Written** at the end of every iteration and on every state change.

**Contents:**
```json
{
  "project": "short name",
  "planPath": "path to the written plan",
  "loopIteration": 0,
  "startedAt": "ISO timestamp",
  "lastCheckpoint": "ISO timestamp",
  "phases": [
    {
      "name": "phase name",
      "status": "pending|in_progress|done",
      "tasks": [
        {
          "id": "task-id",
          "title": "task title",
          "status": "pending|done|blocked",
          "tries": 0,
          "lastError": "short summary of the last failure, or empty",
          "verified": false
        }
      ]
    }
  ],
  "blockedTasks": ["task-id", ...],
  "resumeFromSession": "optional note if resuming a prior session"
}
```

**On startup:**
- File exists and not all tasks done/blocked → resume from the next unstarted task.
- File exists and complete → report final state; do not re-run.
- No file → start fresh (load the plan, initialize the checkpoint).

**Git status:** the file is gitignored (transient runtime state), so it is not committed to the repo.

## Verification

Prove each pass before marking a task done — run the FULL verification command with fresh, complete output, check the exit code, and count failures. Do not infer a pass from a partial or cached run. See `superpowers:verification-before-completion`.

## Common Mistakes

- Running the loop in the primary model instead of subagents, so context grows every iteration and degrades quality.
- Marking a task done from a cached or partial test run.
- Retrying the same failing approach five times without changing it.
- Resolving the checkpoint against the global config dir, so two projects share one state file.
- Pausing to check in between tasks.
- Resuming across sessions but never writing the checkpoint, so the loop restarts from scratch each time.

## Integration

**Required sibling skills:**
- **superpowers:writing-plans** — produces the plan this loop executes. Do not loop over a plan that does not exist.
- **superpowers:verification-before-completion** — prove each task's pass before marking it done.
- **superpowers:finishing-a-development-branch** — complete development after all tasks are green or blocked.

**Required workflow skills:**
- **superpowers:using-git-worktrees** — verify an isolated workspace exists before building.
- **superpowers:subagent-driven-development** — model for constructing focused subagents (use if not already running with subagents).

## Real-World Impact

- Linear execution: stops at the first failed test, leaving the task unfinished.
- Iterative loop: builds, tests, tunes, and retries — finishing tasks that need more than one pass.
- Subagent orchestration + checkpoint: survives long loops and session restarts without re-reading the whole project.
