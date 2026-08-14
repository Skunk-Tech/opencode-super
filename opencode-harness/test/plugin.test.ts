import { expect, test } from "bun:test";
import { looksLikeError, isPrematureStop, HarnessPlugin } from "../src/plugin";

test("isPrematureStop flags finish:stop after tool activity", () => {
  expect(isPrematureStop("stop", true)).toBe(true);
});

test("isPrematureStop does not flag a clean stop without prior tool activity", () => {
  expect(isPrematureStop("stop", false)).toBe(false);
  expect(isPrematureStop(undefined, true)).toBe(false);
  expect(isPrematureStop("tool-calls", true)).toBe(false);
});

test("looksLikeError uses the bash exit code when available", () => {
  expect(looksLikeError("npm error code ENOENT", { exit: 1 }, "bash")).toBe(true);
  expect(looksLikeError("tests passed, 0 failed", { exit: 0 }, "bash")).toBe(false);
});

test("looksLikeError treats null/absent exit code as not-a-failure for bash", () => {
  expect(looksLikeError("timeout", { exit: null }, "bash")).toBe(false);
  expect(looksLikeError("unknown", {}, "bash")).toBe(false);
  expect(looksLikeError(undefined, {}, "bash")).toBe(false);
});

test("looksLikeError never flags non-bash tool output as failure (output is content, not status)", () => {
  expect(looksLikeError("Error: Cannot find module", {}, "read")).toBe(false);
  expect(looksLikeError("session_error type definition", {}, "read")).toBe(false);
  expect(looksLikeError("tests passed, 0 failed", {}, "grep")).toBe(false);
  expect(looksLikeError("build failed", { exit: 1 }, "bash")).toBe(true);
});

test("HarnessPlugin config hook registers refine/harness commands and refiner agent", async () => {
  const hooks = await HarnessPlugin({ directory: process.cwd() } as any);
  const config: any = { command: {}, agent: {} };
  await hooks.config?.(config);
  expect(config.command["refine"]).toBeDefined();
  expect(config.command["refine"].agent).toBe("refiner");
  expect(config.command["harness"]).toBeDefined();
  expect(config.agent["refiner"]).toBeDefined();
  expect(config.agent["refiner"].mode).toBe("subagent");
  expect(config.agent["refiner"].permission.skill["harness-refine"]).toBe("allow");
});

test("HarnessPlugin applies a model from plugin options to commands and refiner agent", async () => {
  const hooks = await HarnessPlugin({ directory: process.cwd() } as any, { model: "omni-deepseek/ds/deepseek-v4-flash" });
  const config: any = { command: {}, agent: {} };
  await hooks.config?.(config);
  expect(config.command["refine"].model).toBe("omni-deepseek/ds/deepseek-v4-flash");
  expect(config.command["harness"].model).toBe("omni-deepseek/ds/deepseek-v4-flash");
  expect(config.agent["refiner"].model).toBe("omni-deepseek/ds/deepseek-v4-flash");
});

test("HarnessPlugin does not clobber a user-set agent.refiner.model", async () => {
  const hooks = await HarnessPlugin({ directory: process.cwd() } as any, { model: "omni-deepseek/ds/deepseek-v4-flash" });
  const config: any = { command: {}, agent: { refiner: { model: "anthropic/claude-sonnet-4-5" } } };
  await hooks.config?.(config);
  expect(config.agent["refiner"].model).toBe("anthropic/claude-sonnet-4-5");
  expect(config.command["refine"].model).toBe("anthropic/claude-sonnet-4-5");
  expect(config.command["harness"].model).toBe("anthropic/claude-sonnet-4-5");
});

test("HarnessPlugin leaves commands/agent model undefined when no model configured", async () => {
  const hooks = await HarnessPlugin({ directory: process.cwd() } as any);
  const config: any = { command: {}, agent: {} };
  await hooks.config?.(config);
  expect(config.command["refine"].model).toBeUndefined();
  expect(config.command["harness"].model).toBeUndefined();
  expect(config.agent["refiner"].model).toBeUndefined();
});

import { AUTO_REFINE_ENABLED } from "../src/plugin";

test("AUTO_REFINE_ENABLED constant defaults true", () => {
  expect(AUTO_REFINE_ENABLED).toBe(true);
});

import { AUTO_UPDATE_ENABLED, UPDATE_CHECK_HOURS, UPDATE_REPO } from "../src/plugin";

test("update constants have spec defaults", () => {
  expect(AUTO_UPDATE_ENABLED).toBe(true);
  expect(UPDATE_CHECK_HOURS).toBe(6);
  expect(UPDATE_REPO).toBe("Skunk-Tech/opencode-super");
});

test("harness_team returns a named team spec body", async () => {
  const hooks = (await HarnessPlugin({ directory: process.cwd(), client: {} } as any)) as any;
  try {
    await hooks.tool.harness_apply.execute({
      ops: [{ op: "spec", kind: "spec", specKind: "team", name: "doc-team", scope: "global", body: "Pattern: pipeline\nTask type: docs\nRoles: writer, reviewer\nCoordination: writer then reviewer\nUse when: repeated doc rewrites", confidence: 0.7, evidence: ["smoke"] }],
    });
    const out = await hooks.tool.harness_team.execute({ name: "doc-team" });
    expect(out).toContain("doc-team");
    expect(out).toContain("Pattern: pipeline");
  } finally {
    // cleanup: these smoke tests write to the real global harness dir; delete the spec so runs stay isolated
    await hooks.tool.harness_apply.execute({
      ops: [{ op: "delete", kind: "spec", name: "doc-team", scope: "global", body: "" }],
    });
  }
});

test("harness_team lists all teams when no name given", async () => {
  const hooks = (await HarnessPlugin({ directory: process.cwd(), client: {} } as any)) as any;
  const out = await hooks.tool.harness_team.execute({});
  expect(out.length).toBeGreaterThan(0);
});

test("harness_team reports unknown name and lists available teams", async () => {
  const hooks = (await HarnessPlugin({ directory: process.cwd(), client: {} } as any)) as any;
  const out = await hooks.tool.harness_team.execute({ name: "no-such-team" });
  expect(out).toContain("no-such-team");
  expect(out).toMatch(/Available teams:|No team specs stored yet\./);
});
