import { expect, test } from "bun:test";
import path from "path";
import os from "os";
import { globalHarnessDir, projectHarnessDir } from "../src/paths";

test("globalHarnessDir points under config dir", () => {
  const dir = globalHarnessDir();
  expect(dir.endsWith(path.join(".config", "opencode", "harness"))).toBe(true);
  expect(path.isAbsolute(dir)).toBe(true);
});

test("projectHarnessDir nests under worktree", () => {
  const dir = projectHarnessDir("C:\\proj\\myrepo");
  expect(dir.endsWith(path.join("myrepo", ".opencode", "harness"))).toBe(true);
});
