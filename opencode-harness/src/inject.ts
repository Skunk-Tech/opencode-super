import type { HarnessState } from "./store";

/** Cap on any single memory/spec body surfaced to the model. Bodies grow unbounded
 *  (refiners append addenda forever); without a cap the whole store gets dumped
 *  into context. Truncation preserves the head (the newest guidance is appended at
 *  the tail by convention, so head-capture keeps the core claim). */
export const MAX_BODY_CHARS = 1500;
/** Hard ceiling for compaction-context text so a huge store cannot blow context. */
export const COMPACTION_TOTAL_MAX = 60_000;
/** Maximum number of spec entries included in compaction context. */
export const COMPACTION_MAX_SPECS = 20;

function clip(body: string, max: number): string {
  if (body.length <= max) return body;
  return `${body.slice(0, max)}\n…[truncated ${body.length - max} chars]`;
}

export function filterByScope(state: HarnessState, scope: "global" | "project"): HarnessState {
  return {
    ...state,
    memories: state.memories.filter((m) => m.scope === scope || m.scope === "global"),
    specs: state.specs.filter((s) => s.scope === scope || s.scope === "global"),
  };
}

export function buildInjection(state: HarnessState, scope: "global" | "project", maxEntries = 8): string {
  const filtered = filterByScope(state, scope);
  const memories = [...filtered.memories].sort((a, b) => b.confidence - a.confidence).slice(0, maxEntries);
  if (memories.length === 0) return "";
  const lines = memories.map((m) => `- ${clip(m.body, MAX_BODY_CHARS)}`).join("\n");
  return `<harness-memories scope="${scope}">\n${lines}\n</harness-memories>`;
}

/** Pick highest-confidence entries first, clipped, until a total character budget is reached. */
function boundedEntries<T extends { name: string; body: string; confidence: number }>(
  entries: T[],
  totalMax: number,
): { lines: string[]; shown: number; total: number } {
  const sorted = [...entries].sort((a, b) => b.confidence - a.confidence);
  const lines: string[] = [];
  let used = 0;
  let shown = 0;
  for (const e of sorted) {
    const line = `- ${clip(e.body, MAX_BODY_CHARS)}`;
    if (used + line.length > totalMax && shown > 0) break;
    lines.push(line);
    used += line.length;
    shown += 1;
  }
  return { lines, shown, total: entries.length };
}

export function buildCompactionContext(state: HarnessState, scope: "global" | "project"): string[] {
  const filtered = filterByScope(state, scope);
  const parts: string[] = [];
  if (filtered.memories.length > 0) {
    const { lines, shown, total } = boundedEntries(filtered.memories, COMPACTION_TOTAL_MAX);
    let head = `## Harness memories (${shown}/${total} highest-confidence)\n`;
    if (shown < total) head += `> ${total - shown} lower-confidence memories omitted for context budget.\n`;
    parts.push(head + lines.join("\n"));
  }
  const nonTeamSpecs = filtered.specs.filter((s) => s.kind !== "team");
  if (nonTeamSpecs.length > 0) {
    const specs = nonTeamSpecs.slice(0, COMPACTION_MAX_SPECS).map((s) => `- ${s.name}: ${clip(s.body, MAX_BODY_CHARS)}`);
    parts.push(`## Harness specs (${Math.min(nonTeamSpecs.length, COMPACTION_MAX_SPECS)}/${nonTeamSpecs.length})\n${specs.join("\n")}`);
  }
  return parts;
}

/** Compact, budget-bounded state listing used by harness_refine instead of dumping
 *  the entire store as JSON (which reached ~2.7MB / ~770K tokens). */
export function buildStateSummary(state: HarnessState, scope: "global" | "project", totalMax = COMPACTION_TOTAL_MAX): string {
  const filtered = filterByScope(state, scope);
  const lines: string[] = [`memories: ${filtered.memories.length} | specs: ${filtered.specs.length} (${scope} scope)`];
  if (filtered.memories.length > 0) {
    const { lines: memLines, shown, total } = boundedEntries(filtered.memories, totalMax);
    lines.push(`memories shown (${shown}/${total} by confidence):`);
    if (shown < total) lines.push(`  > ${total - shown} omitted for context budget`);
    lines.push(...memLines);
  }
  const nonTeamSpecs = filtered.specs.filter((s) => s.kind !== "team");
  if (nonTeamSpecs.length > 0) {
    const specs = nonTeamSpecs.slice(0, COMPACTION_MAX_SPECS).map((s) => `- ${s.name}: ${clip(s.body, MAX_BODY_CHARS)}`);
    lines.push(`specs (${Math.min(nonTeamSpecs.length, COMPACTION_MAX_SPECS)}/${nonTeamSpecs.length}):`);
    lines.push(...specs);
  }
  return lines.join("\n");
}

export function buildContinuationNudge(): string {
  return `<harness-continuation>
Prefer to complete your work rather than stop early. If a task is unfinished, continue using tools and working toward completion instead of ending your turn. Only stop when the requested work is actually done or you are blocked and need the user.
</harness-continuation>`;
}
