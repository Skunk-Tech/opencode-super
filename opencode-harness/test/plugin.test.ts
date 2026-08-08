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
