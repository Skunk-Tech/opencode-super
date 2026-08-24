import fs from "fs";
import path from "path";
import os from "os";
import { $ } from "bun";

const root = path.resolve(import.meta.dir, "..");
const configDir = path.join(os.homedir(), ".config", "opencode");
const dist = path.join(root, "dist", "harness.js");

if (!fs.existsSync(dist)) {
  console.error("dist/harness.js missing. Run `bun run build` first.");
  process.exit(1);
}

const copies: Array<[string, string]> = [
  [dist, path.join(configDir, "plugins", "harness.js")],
  [path.join(root, "assets", "skills", "harness-refine"), path.join(configDir, "skills", "harness-refine")],
  [path.join(root, "assets", "commands", "refine.md"), path.join(configDir, "commands", "refine.md")],
  [path.join(root, "assets", "commands", "harness.md"), path.join(configDir, "commands", "harness.md")],
  [path.join(root, "assets", "agents", "refiner.md"), path.join(configDir, "agents", "refiner.md")],
  [path.join(root, "assets", "agents", "redteam.md"), path.join(configDir, "agents", "redteam.md")],
];

for (const [src, dest] of copies) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.statSync(src).isDirectory()) {
    fs.cpSync(src, dest, { recursive: true });
  } else {
    fs.copyFileSync(src, dest);
  }
  console.log(`Installed ${dest}`);
}
console.log("Harness installed. Restart opencode to load the plugin.");
