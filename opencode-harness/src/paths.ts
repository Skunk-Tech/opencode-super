import path from "path";
import os from "os";
import fs from "fs";

export function globalHarnessDir(): string {
  return path.join(os.homedir(), ".config", "opencode", "harness");
}

export function projectHarnessDir(worktreeOrDir: string): string {
  return path.join(worktreeOrDir, ".opencode", "harness");
}

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
