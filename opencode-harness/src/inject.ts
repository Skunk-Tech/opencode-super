import type { HarnessState } from "./store";

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
  const lines = memories.map((m) => `- ${m.body}`).join("\n");
  return `<harness-memories scope="${scope}">\n${lines}\n</harness-memories>`;
}

export function buildCompactionContext(state: HarnessState, scope: "global" | "project"): string[] {
  const filtered = filterByScope(state, scope);
  const parts: string[] = [];
  if (filtered.memories.length > 0) {
    parts.push(`## Harness memories\n${filtered.memories.map((m) => `- ${m.body}`).join("\n")}`);
  }
  if (filtered.specs.length > 0) {
    parts.push(`## Harness specs\n${filtered.specs.map((s) => `- ${s.name}: ${s.body}`).join("\n")}`);
  }
  return parts;
}

export function buildContinuationNudge(): string {
  return `<harness-continuation>
Prefer to complete your work rather than stop early. If a task is unfinished, continue using tools and working toward completion instead of ending your turn. Only stop when the requested work is actually done or you are blocked and need the user.
</harness-continuation>`;
}
