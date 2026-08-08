import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

export const GITHUB_API = "https://api.github.com/repos";
export const RAW_GITHUB = "https://raw.githubusercontent.com";

export function ownBundlePath(): string | undefined {
  try {
    return fileURLToPath(import.meta.url);
  } catch {
    return undefined;
  }
}

export function isGitInstalledBundle(ownPath: string): boolean {
  return ownPath.split(/[\\/]/).includes("node_modules");
}

export function versionMarkerFile(ownPath: string): string {
  return ownPath + ".version";
}

export function readVersionMarker(ownPath: string): string | undefined {
  const file = versionMarkerFile(ownPath);
  if (!fs.existsSync(file)) return undefined;
  const content = fs.readFileSync(file, "utf8").trim();
  return content.length > 0 ? content : undefined;
}

export function writeVersionMarker(ownPath: string, sha: string): void {
  fs.writeFileSync(versionMarkerFile(ownPath), sha, "utf8");
}

export function atomicReplace(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.harness.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, filePath);
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export async function fetchLatestSha(repo: string, fetcher: FetchLike = fetch): Promise<string | undefined> {
  try {
    const res = await fetcher(`${GITHUB_API}/${repo}/commits/main`, { headers: { "User-Agent": "opencode-harness" } });
    if (!res.ok) return undefined;
    const json = (await res.json()) as { sha?: string };
    return json.sha;
  } catch {
    return undefined;
  }
}

export async function fetchBundle(repo: string, ref: string, fetcher: FetchLike = fetch): Promise<string | undefined> {
  try {
    const res = await fetcher(`${RAW_GITHUB}/${repo}/${ref}/.opencode/plugins/harness.js`);
    if (!res.ok) return undefined;
    const text = await res.text();
    return text.length > 0 ? text : undefined;
  } catch {
    return undefined;
  }
}

export async function checkForUpdates(
  ownPath: string,
  repo: string,
  opts: { enabled?: boolean; fetcher?: FetchLike } = {},
): Promise<"updated" | "current" | "skipped"> {
  if (opts.enabled === false) return "skipped";
  if (!isGitInstalledBundle(ownPath)) return "skipped";
  const fetcher = opts.fetcher ?? fetch;
  const latest = await fetchLatestSha(repo, fetcher);
  if (!latest) return "skipped";
  const current = readVersionMarker(ownPath);
  if (current === latest) return "current";
  const bundle = await fetchBundle(repo, latest, fetcher);
  if (!bundle) return "skipped";
  try {
    atomicReplace(ownPath, bundle);
    writeVersionMarker(ownPath, latest);
    return "updated";
  } catch {
    return "skipped";
  }
}
