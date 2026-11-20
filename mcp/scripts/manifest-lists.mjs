// Prints the tools and prompts as extension/manifest.json lists them (from the server itself), so the manifest can be
// brought up to date after adding or renaming one: node scripts/manifest-lists.mjs --write
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TOOLS } from "../src/tools.ts";
import { PROMPTS } from "../src/instructions.ts";
import { VERSION } from "../src/server.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const path = join(HERE, "..", "extension", "manifest.json");
const short = d => d.split(/(?<=\.)\s/)[0];
const lists = {
  tools: TOOLS.map(t => ({ name: t.name, description: short(t.description) })),
  prompts: PROMPTS.map(p => ({ name: p.name, description: p.description,
    ...(p.arguments?.length ? { arguments: p.arguments.map(a => a.name) } : {}),
    text: p.text(Object.fromEntries((p.arguments || []).map(a => [a.name, `\${arguments.${a.name}}`]))) })),
};
if (process.argv.includes("--write")) {
  const m = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, JSON.stringify({ ...m, version: VERSION, ...lists }, null, 2) + "\n");
  console.log(`updated ${path}`);
} else console.log(JSON.stringify(lists, null, 2));
