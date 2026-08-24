# Harness Audit + True Red Teaming

**Date:** 2026-08-24

## Problem

The Continual Harness refine loop currently trusts the `refiner`'s
recommendations without verification:

- `harness-refine` skill workflow: status -> gather evidence -> score ->
  `harness_apply` -> report. There is **no verification step** between scoring
  and applying, and nothing checks that a write actually landed correctly.
- `applyOps` (opencode-harness/src/refine.ts) snapshots both stores then writes
  files and returns `{ snapshotID, applied }`. No read-back, no validation.
- Fabricated or mis-grounded evidence can therefore become a permanent memory.
- A single-session observation can be promoted into a general lesson.
- A proposed write can clobber a trusted, high-confidence existing memory.

This is the exact gap LongHorizon-Harness (AMAP-ML/LongHorizon-Harness) closes
with its Manager/Executor/Auditor loop: an independent auditor verifies claims
against real state before they become trusted progress, and accepted progress is
checkpointed so it can be recovered. This spec adopts those loop patterns into
the zero-dependency harness plugin as: (1) a programmatic audit gate that
falsifies weak ops, (2) a separate adversarial reviewer agent that challenges
the refiner's proposals, and (3) read-back verification with an exposed snapshot
for rollback.

## Design Decisions (confirmed with user)

- **Layer**: plugin tool + skill update. A new `harness_audit` plugin tool
  verifies proposed ops against ground truth; the `harness-refine` skill
  workflow invokes it. Zero new dependencies.
- **Gate strictness**: gate BEFORE apply (refuse invalid ops) + verify AFTER
  (read-back writes, expose snapshot id for rollback).
- **Audit checks** (all five selected): evidence grounding, body
  structure/format, name-conflict detection, read-back verification, scope
  consistency.
- **Red teaming** (both selected): adversarial op falsification (programmatic,
  inside the audit gate) + a separate adversarial reviewer agent
  (`harness-redteam`).

## Architecture

### New/modified units

**`opencode-harness/src/refine.ts`**

- Add `validateOps(global, project, ops): ValidationResult` — pure, testable.
  Per-op verdicts for all checks. No side effects.
- Modify `applyOps(global, project, ops)` — runs `validateOps` internally,
  rejects failing ops, applies only valid ones, then read-back verifies each
  written file and returns the new shape.

New return shape of `applyOps`:

```ts
type ApplyResult = {
  snapshotID: string;
  applied: string[];
  rejected: { op: string; reason: string }[];
  verified: { name: string; kind: "memory" | "spec"; ok: boolean }[];
};
```

**`opencode-harness/src/plugin.ts`**

- New tool `harness_audit`: takes `ops` (same schema as `harness_apply`),
  returns the `validateOps` verdict as text (pass/fail per op + reasons).
  Read-only — never writes, never snapshots.
- `harness_apply`: runs the same validation; applies the valid subset, returns
  the rejected list and verified writes. Enforcement in code, not instruction.
- New agent `harness-redteam` registered in the `config` hook alongside
  `refiner`.
- Updated `harness_refine` tool prompt: instruct the refiner to run the
  red-team pass + `harness_audit` before applying.

**`opencode-harness/assets/agents/redteam.md`** — the adversarial reviewer agent
definition.

**`skills/harness-refine/SKILL.md`** and
**`opencode-harness/assets/skills/harness-refine/SKILL.md`** — mirrored workflow
updates (red-team dispatch, audit before apply, verify-after + rollback).

### `harness-redteam` agent

- **Mode**: subagent, read-only. Permissions mirror the refiner's
  `edit: deny, bash: deny`.
- **Job**: the adversary. Given the refiner's proposed ops and the full
  evidence summary, challenge each one: find counter-evidence in the full
  harness store, question scope, demand the evidence supports the claim,
  recommend `reject` / `revise` / `accept`.

### Red-team dispatch mechanism (open item for planning)

The refiner dispatches `harness-redteam` via the `task` tool. The refiner's
current permission block is `{ edit: deny, bash: deny, skill:
{ "harness-refine": "allow" } }`. Verify during planning whether subagent
dispatch to `harness-redteam` is permitted by default in opencode; if not,
either add an explicit permission allow for the `task` tool targeting
`harness-redteam`, or run the red-team pass as a distinct phase inside the
refine session with the adversary persona loaded. This is the one item to
confirm before implementation.

## The audit checks (`validateOps`)

Each op gets `{ index, op, name, pass, reasons[] }`.

1. **Evidence grounding** — each `evidence[]` string must reference a real
   evidence row. Match rules (first hit passes):
   - exact row match: `ts` + `kind` + `tool` (e.g.
     `"2026-08-15T00:00:00.000Z tool_failure bash"`)
   - bare `ts` matches any row with that timestamp
   - bare kind/tool fragment matches a row containing it
   - Unmatched refs -> fail with the list. Ops with empty `evidence[]` are
     **allowed** (confidence is the guard) but flagged as a warning.

2. **Body structure/format** — spec bodies must be non-empty; team specs
   (`specKind: "team"`) must include the fixed-shape fields: `Pattern:`,
   `Task type:`, `Roles:`, `Coordination:`, `Use when:`. Memory bodies must be
   non-empty.

3. **Name-conflict detection** — if an op writes a memory/spec whose name
   already exists (target scope) with a different body, flag as conflict
   (potential clobber). Identical body -> idempotent pass. `delete` ops exempt.

4. **Scope consistency** — a `project` scope op must target the project dir; a
   `global` op must not duplicate an existing project memory under the same
   name with a different body (would shadow it in `loadMergedState`).
   `specKind` is only valid when `op: "spec"`.

5. **Read-back verification** (post-apply, in `applyOps`) — re-read via
   `listMemories`/`listSpecs`; confirm each applied op's name + body is present
   and parses. Mismatch -> `verified: false` + snapshot id returned for
   rollback.

Confidence: out-of-range `confidence` (outside 0..1) gets a warning.

## True red teaming

### Programmatic adversarial falsification (in `validateOps`)

Strengthens the gate against the loop's three most common failure modes:

1. **Single-session over-generalization** — if every `evidence[]` ref for a
   memory/update resolves to rows from the same `sessionID`, flag: *"evidence
   rests on a single session; lower confidence or gather more before
   promoting."*

2. **Counter-evidence scan** — for each cited evidence ref, search the full
   store for contradicting rows: a later `retry`/pass for the same `tool` (the
   failure was transient), or a `session_error` in the same session that
   undermines the claim. Found -> op flagged `contested`; passes only if the
   refiner's body acknowledges the counter-evidence.

3. **High-confidence contradiction** — compare against existing memories with
   `confidence >= 0.7` in the target scope: same/similar name with a different
   body -> **fail** (would corrupt a trusted memory). Same body -> idempotent
   pass.

### Human/adversarial reviewer (agent)

`harness-redteam` challenges the refiner's proposed ops before the audit gate.
Workflow: refiner proposes ops -> dispatches `harness-redteam` with ops + full
evidence summary -> adversary returns challenges -> refiner revises or defends
-> `harness_audit` -> `harness_apply`.

## Data flow and recovery

**`harness_audit` (pre-apply, read-only):**

```
refiner proposes ops -> harness_audit(ops) -> validateOps -> verdict text:
  PASS op#1 memory:foo (evidence grounded, no conflict)
  FAIL op#2 spec:team-x (missing "Coordination:" field)
```

No snapshot, no state write.

**`harness_apply` (enforced gate):**

1. Snapshot both stores first (existing behavior, unchanged).
2. Run `validateOps`. Failing ops are skipped, not applied.
3. Apply the passing subset.
4. Read-back verify each applied write via `listMemories`/`listSpecs`.
5. Return `{ snapshotID, applied, rejected, verified }` as text.

**Recovery semantics:**

- Snapshot is taken before any validation/write, so a rejected or failed write
  is always undoable via `harness_rollback <snapshotID>`.
- A read-back failure does NOT auto-rollback — it returns `verified: false` +
  the snapshot id, and the skill instructs the refiner to roll back. Explicit
  over automatic for a conservative tool.
- `delete` ops: validated for name existence (delete of a non-existent entry is
  a warning), exempt from conflict check, verified by confirming the file is
  gone.

**Error handling:**

- `validateOps` is pure and never throws on malformed input — malformed ops
  become `rejected` with a reason, not exceptions.
- Empty ops array -> `applied: []`, `rejected: []`, returns a message.

## Testing

New file `opencode-harness/test/refine.test.ts` plus additions to existing
suites. Run with `/home/developer/.eigent/bin/bun test` (bun is not on PATH in
this environment; use the explicit path).

**`refine.test.ts` — `validateOps` unit tests:**

1. Evidence grounding: valid ref passes, unmatched ref fails, empty evidence ->
   warning not failure.
2. Body structure: team spec missing `Coordination:` fails; memory empty body
   fails; well-formed passes.
3. Name conflict: existing memory with different body -> conflict; identical
   body -> idempotent pass; delete exempt.
4. Scope consistency: project op targets project; global op duplicating a
   project memory -> fail; specKind on a memory op -> fail.
5. Confidence range: 0..1 passes, 1.5 warns.
6. Red team: single-session evidence -> flag; counter-evidence present ->
   contested; high-confidence contradiction -> fail.

**`applyOps` integration tests:**

7. Rejects failing ops, applies valid subset, returns `rejected` with reasons.
8. Read-back verification: after write, file exists, parses, body matches;
   forced-corrupt write (mock) -> `verified: false`.
9. Snapshot id returned even when some ops rejected.
10. Delete op: file gone after apply, verified.

**`plugin.test.ts`:**

11. `harness_audit` tool: verdict text contains PASS/FAIL, no state written
    (evidence file unchanged, no new snapshot).

Expected result: 79 + ~13 new ~= 92 passing.

## Out of Scope

- No change to `/refine` and `/harness` command behavior beyond the workflow
  updates described here.
- No opencode core/UI patch.
- No auto-refine gating/throttling changes.
- No auto-rollback on read-back failure (explicit rollback via skill
  instruction; auto-rollback is riskier than the failure it prevents).
- No post-apply adversarial eval that injects a memory into a live session to
  test behavior (would require spawning sessions; out of scope for this pass).

## Files Touched

- `opencode-harness/src/refine.ts`
- `opencode-harness/src/plugin.ts`
- `opencode-harness/assets/agents/redteam.md` (new)
- `opencode-harness/assets/skills/harness-refine/SKILL.md`
- `skills/harness-refine/SKILL.md`
- `opencode-harness/test/refine.test.ts` (new)
- `opencode-harness/test/plugin.test.ts`
- `.opencode/plugins/harness.js` (rebuilt bundle)
- `README.md`

## Verification

- `/home/developer/.eigent/bin/bun test` passes (~92 tests).
- `bun run build` in `opencode-harness/` produces a bundle;
  `.opencode/plugins/harness.js` is updated.
- Manual: run `/refine`; confirm the refiner dispatches `harness-redteam`,
  `harness_audit` gates, and `harness_apply` returns
  `{ snapshotID, applied, rejected, verified }`.
- Negative test: hand a fabricated-evidence op to `harness_audit` -> it must
  FAIL (the gate catches lies).
