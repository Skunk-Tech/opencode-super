import { expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import {
  isGitInstalledBundle, versionMarkerFile, readVersionMarker, writeVersionMarker,
  atomicReplace, fetchLatestSha, fetchBundle, checkForUpdates,
} from "../src/updater";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "updater-test-"));
}

test("isGitInstalledBundle detects npm/git cache layout", () => {
  expect(isGitInstalledBundle("/cache/packages/opencode-super@git+https_/node_modules/opencode-super/.opencode/plugins/harness.js")).toBe(true);
  expect(isGitInstalledBundle("C:\\Users\\x\\.config\\opencode\\plugins\\harness.js")).toBe(false);
});

test("versionMarkerFile appends .version next to the bundle", () => {
  expect(versionMarkerFile("/a/b/harness.js")).toBe("/a/b/harness.js.version");
});

test("readVersionMarker returns undefined for missing marker", () => {
  const dir = tmpDir();
  expect(readVersionMarker(path.join(dir, "harness.js"))).toBeUndefined();
});

test("writeVersionMarker then readVersionMarker round-trips", () => {
  const dir = tmpDir();
  const own = path.join(dir, "harness.js");
  writeVersionMarker(own, "abc123");
  expect(readVersionMarker(own)).toBe("abc123");
});

test("atomicReplace writes content and leaves no temp file", () => {
  const dir = tmpDir();
  const own = path.join(dir, "harness.js");
  fs.writeFileSync(own, "old", "utf8");
  atomicReplace(own, "new content");
  expect(fs.readFileSync(own, "utf8")).toBe("new content");
  expect(fs.readdirSync(dir).filter((f) => f.includes("harness.tmp"))).toEqual([]);
});

test("fetchLatestSha parses the GitHub API response", async () => {
  const fetcher = async () => ({ ok: true, json: async () => ({ sha: "deadbeef" }) }) as any;
  expect(await fetchLatestSha("Skunk-Tech/opencode-super", fetcher)).toBe("deadbeef");
});

test("fetchLatestSha returns undefined on network error", async () => {
  const fetcher = async () => { throw new Error("offline"); };
  expect(await fetchLatestSha("Skunk-Tech/opencode-super", fetcher)).toBeUndefined();
});

test("fetchBundle downloads non-empty bundle text", async () => {
  const fetcher = async () => ({ ok: true, text: async () => "export const x = 1;" }) as any;
  expect(await fetchBundle("Skunk-Tech/opencode-super", "abc", fetcher)).toBe("export const x = 1;");
});

test("fetchBundle returns undefined for empty body", async () => {
  const fetcher = async () => ({ ok: true, text: async () => "" }) as any;
  expect(await fetchBundle("Skunk-Tech/opencode-super", "abc", fetcher)).toBeUndefined();
});

test("checkForUpdates replaces bundle when newer, writes marker", async () => {
  const dir = tmpDir();
  const own = path.join(dir, "node_modules", "opencode-super", ".opencode", "plugins", "harness.js");
  fs.mkdirSync(path.dirname(own), { recursive: true });
  fs.writeFileSync(own, "old bundle", "utf8");
  const urls: string[] = [];
  const fetcher = async (url: string) => {
    urls.push(url);
    if (url.includes("commits/main")) return { ok: true, json: async () => ({ sha: "newsha" }) } as any;
    return { ok: true, text: async () => "new bundle" } as any;
  };
  const result = await checkForUpdates(own, "Skunk-Tech/opencode-super", { fetcher: fetcher as any });
  expect(result).toBe("updated");
  expect(fs.readFileSync(own, "utf8")).toBe("new bundle");
  expect(readVersionMarker(own)).toBe("newsha");
});

test("checkForUpdates is a no-op when disabled", async () => {
  const dir = tmpDir();
  const own = path.join(dir, "harness.js");
  const result = await checkForUpdates(own, "Skunk-Tech/opencode-super", { enabled: false });
  expect(result).toBe("skipped");
});

test("checkForUpdates skips non-git installs", async () => {
  const dir = tmpDir();
  const own = path.join(dir, "harness.js");
  const result = await checkForUpdates(own, "Skunk-Tech/opencode-super", {});
  expect(result).toBe("skipped");
});

test("checkForUpdates does not replace on download failure", async () => {
  const dir = tmpDir();
  const own = path.join(dir, "node_modules", "opencode-super", ".opencode", "plugins", "harness.js");
  fs.mkdirSync(path.dirname(own), { recursive: true });
  fs.writeFileSync(own, "old bundle", "utf8");
  const fetcher = async () => ({ ok: false }) as any;
  const result = await checkForUpdates(own, "Skunk-Tech/opencode-super", { fetcher: fetcher as any });
  expect(result).toBe("skipped");
  expect(fs.readFileSync(own, "utf8")).toBe("old bundle");
});
