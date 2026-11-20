// Builds the Claude Desktop extension: dist/sylvester.mcpb
//
//   cd mcp && npm run extension
//
// The server is bundled into one plain JavaScript file (Claude Desktop runs it with its own Node.js, so the person
// installs nothing), and the app's shared files go beside it in app/, where src/paths.ts looks for them:
//
//   dist/extension/
//     manifest.json  icon.png  LICENSE  NOTICE.md
//     server/index.mjs
//     app/coach/library.json, assessments.json, knowledge/*.md, exercises/{exercises,everkinetic}.json + licences
//
// Nothing personal is read or packed: only files from this repository.

import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const HERE = dirname(fileURLToPath(import.meta.url));
const MCP = join(HERE, "..");
const REPO = join(MCP, "..");
const OUT = join(MCP, "dist", "extension");
const manifest = JSON.parse(readFileSync(join(MCP, "extension", "manifest.json"), "utf8"));

rmSync(join(MCP, "dist"), { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

await build({
  entryPoints: [join(MCP, "src", "server.ts")],
  outfile: join(OUT, "server", "index.mjs"),
  bundle: true, platform: "node", format: "esm", target: "node18",
  legalComments: "none", logLevel: "warning",
  // The bundle is the entry point, so its own guard (import.meta.url === argv[1]) starts the server.
});

const copy = (from, to = from) => { mkdirSync(dirname(join(OUT, to)), { recursive: true }); copyFileSync(join(REPO, from), join(OUT, to)); };
copy("mcp/extension/manifest.json", "manifest.json");
copy("mobile/assets/icon.png", "icon.png");
copy("LICENSE");
copy("NOTICE.md");
for (const f of ["library.json", "assessments.json"]) copy(`coach/${f}`, `app/coach/${f}`);
cpSync(join(REPO, "coach", "knowledge"), join(OUT, "app", "coach", "knowledge"), { recursive: true, filter: s => statSync(s).isDirectory() || s.endsWith(".md") });
for (const f of readdirSync(join(REPO, "coach", "exercises")).filter(f => /\.(json|md)$/.test(f))) copy(`coach/exercises/${f}`, `app/coach/exercises/${f}`);

const MCPB_DIR = join(MCP, "node_modules", "@anthropic-ai", "mcpb");
const bin = JSON.parse(readFileSync(join(MCPB_DIR, "package.json"), "utf8")).bin;
const MCPB = join(MCPB_DIR, typeof bin === "string" ? bin : bin.mcpb);
const mcpb = (...args) => {
  const r = spawnSync(process.execPath, [MCPB, ...args], { cwd: MCP, stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status || 1);
};
mcpb("validate", join(OUT, "manifest.json"));
const target = join(MCP, "dist", "sylvester.mcpb");
mcpb("pack", OUT, target);

// The packed server must start and answer from its own folder, with no repository around it.
const probe = spawnSync(process.execPath, [join(OUT, "server", "index.mjs")], {
  input: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "find_exercises", arguments: { pattern: "hinge" } } }) + "\n",
  encoding: "utf8", env: { ...process.env, SYLVESTER_APP: "", SYLVESTER_DATA: join(MCP, "dist", "no-data-here") }, timeout: 20000,
});
const answer = JSON.parse(probe.stdout.split("\n")[0] || "{}");
if (answer.result?.isError !== false) {
  console.error("The bundled server didn't answer:", probe.stdout || probe.stderr);
  process.exit(1);
}
console.log(`\nBuilt ${target} (version ${manifest.version}). In Claude Desktop: open it, or drag it onto Settings > Extensions.`);
