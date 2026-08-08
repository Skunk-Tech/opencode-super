import { $ } from "bun";

await $`bun build ${import.meta.dir}/../src/plugin.ts --outfile ${import.meta.dir}/../dist/harness.js --target node`;
console.log("Built dist/harness.js");
