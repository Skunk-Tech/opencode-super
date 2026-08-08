import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

export function tmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "harness-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
