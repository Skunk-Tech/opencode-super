import { expect, test } from "bun:test";
import { appendEvidence, readEvidence, evidenceCountForSession } from "../src/store";
import { tmpDir } from "./helpers";

test("appendEvidence writes a JSONL entry and is readable", () => {
  const { dir, cleanup } = tmpDir();
  try {
    appendEvidence(dir, { ts: "2026-08-05T00:00:00.000Z", sessionID: "s1", kind: "tool_failure", tool: "bash", args: "npm run build", output: "Error: failed" });
    const rows = readEvidence(dir);
    expect(rows.length).toBe(1);
    expect(rows[0].tool).toBe("bash");
    expect(rows[0].output).toContain("Error");
  } finally { cleanup(); }
});

test("consecutive duplicate evidence entries are deduped", () => {
  const { dir, cleanup } = tmpDir();
  try {
    const entry = { ts: "2026-08-05T00:00:00.000Z", sessionID: "s1", kind: "tool_failure" as const, tool: "bash", args: "x", output: "boom" };
    appendEvidence(dir, entry);
    appendEvidence(dir, entry);
    expect(readEvidence(dir).length).toBe(1);
  } finally { cleanup(); }
});

test("evidence is capped at MAX_PER_SESSION per session", () => {
  const { dir, cleanup } = tmpDir();
  try {
    for (let i = 0; i < 30; i++) {
      appendEvidence(dir, { ts: `2026-08-05T00:00:00.00${i}Z`, sessionID: "s1", kind: "tool_failure", tool: "bash", args: `cmd ${i}` });
    }
    expect(evidenceCountForSession(dir, "s1")).toBe(25);
  } finally { cleanup(); }
});

test("truncation of args and output", () => {
  const { dir, cleanup } = tmpDir();
  try {
    appendEvidence(dir, { ts: "2026-08-05T00:00:00.000Z", sessionID: "s1", kind: "tool_failure", tool: "bash", args: "a".repeat(500), output: "o".repeat(1000) });
    const [row] = readEvidence(dir);
    expect(row.args!.length).toBeLessThanOrEqual(200);
    expect(row.output!.length).toBeLessThanOrEqual(500);
  } finally { cleanup(); }
});
