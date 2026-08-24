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
4. For each strong candidate (score >= 0.6), draft the concrete op you would apply.
5. **Red-team your proposals**: dispatch the `harness-redteam` subagent via the task tool with your drafted ops and the full evidence summary. Incorporate its accept/revise/reject feedback — revise or drop ops it challenges. (If subagent dispatch is unavailable in this session, load the red-team prompt yourself and challenge each op adversarially before continuing.)
6. **Audit before apply**: call `harness_audit` with your (possibly revised) ops. Only proceed to apply ops that PASS. Treat warnings as guidance — address them by adjusting confidence or evidence refs where possible.
7. Apply the passing ops with `harness_apply`:
   - `memory` — durable lesson with exact body and evidence reference.
   - `spec` — updated skill/subagent/team description.
   - `delete` — a memory/spec that proved wrong or is superseded.
8. **Verify after apply**: read the returned `verified` list. A `verified: false` entry means the write did not land or did not parse — roll back to the returned snapshot id with `harness_rollback <snapshotID>` and report the failure.
9. For brand-new skills or agents: only create them if repeated friction clearly justifies it. Prefer updating existing memories/specs first.
10. If no candidate is strong, report "No change recommended" and stop.

## Rules

- Never rewrite the base system prompt.
- Every `harness_apply` snapshots automatically; verify the returned snapshot id.
- Never apply an op that `harness_audit` marked FAIL — the gate is enforced in code, so a FAIL op will be rejected by `harness_apply` anyway; treat the audit result as authoritative.
- If `harness_apply` returns `rejected` entries, do not retry them unchanged; revise them to address the reasons.
- Prefer small, focused edits over sweeping changes.
- Ask the user before creating new skills or agents (unless they already approved the refine run).
- Do not manufacture improvements; weak evidence means no change.
