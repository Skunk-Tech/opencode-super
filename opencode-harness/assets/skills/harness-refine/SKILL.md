---
name: harness-refine
description: Review harness evidence and refine durable memories, specs, or new skills/agents. Use when the user runs /refine, asks to improve the harness, or wants to learn from recent sessions.
---

# Harness Refine

You are running the opencode Continual Harness refine loop. Be conservative and evidence-driven.

## Workflow

1. Call `harness_status` to see current state.
2. Call `harness_refine` with an optional `focus` to gather recent evidence and recommendations.
3. Score candidate improvements on: frequency, cost, risk, stability, existing coverage (use the rubric from the session trajectory).
4. For each strong candidate (score >= 0.6), call `harness_apply` with a concrete op:
   - `memory` — durable lesson with exact body and evidence reference.
   - `spec` — updated skill/subagent description.
   - `delete` — a memory/spec that proved wrong or is superseded.
5. For brand-new skills or agents: only create them if repeated friction clearly justifies it. Prefer updating existing memories/specs first.
6. If no candidate is strong, report "No change recommended" and stop.

## Rules

- Never rewrite the base system prompt.
- Every `harness_apply` snapshots automatically; verify the returned snapshot id.
- Prefer small, focused edits over sweeping changes.
- Ask the user before creating new skills or agents (unless they already approved the refine run).
- Do not manufacture improvements; weak evidence means no change.
