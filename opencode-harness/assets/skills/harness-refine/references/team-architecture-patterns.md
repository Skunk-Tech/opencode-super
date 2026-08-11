# Team-Architecture Patterns

Six patterns for coordinating multiple agents on a recurring task type. When proposing a `team` spec, pick the pattern that matches the task shape and fill the fixed body shape.

## 1. Pipeline
Sequential dependent tasks. Each role completes its step and passes the result to the next.
- Use when: strict order, output of one step feeds the next (e.g. research → outline → draft → review).

## 2. Fan-out / Fan-in
Parallel independent tasks. A coordinator fans work out to several roles, then merges their outputs.
- Use when: one task decomposes into independent pieces whose results combine (e.g. review architecture + security + perf in parallel).

## 3. Expert Pool
Context-dependent selective invocation. A dispatcher picks the right specialist per sub-task from a pool.
- Use when: varying subtasks that each need a distinct expert, invoked as needed (not all at once).

## 4. Producer-Reviewer
Generation followed by quality review. A producer creates, a reviewer critiques, iterate until the review gate passes.
- Use when: output quality matters and iteration is cheap (e.g. docs, code review, copy).

## 5. Supervisor
Central agent with dynamic task distribution. A supervisor decomposes work and distributes to subagents, coordinating results.
- Use when: broad open-ended goal where subtasks are discovered as work proceeds.

## 6. Hierarchical Delegation
Top-down recursive delegation. A lead delegates to sub-leads who further decompose and delegate.
- Use when: large complex effort with nested levels of work.

## Team spec body template

```
Pattern: <pipeline | fanout_fanin | expert_pool | producer_reviewer | supervisor | hierarchical>
Task type: <what recurring task this team handles>
Roles: <role 1>, <role 2>, ...
Coordination: <how work flows / who reviews what>
Use when: <friction signal that should trigger this team>
```
