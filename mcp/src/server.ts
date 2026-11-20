// Sylvester's MCP server: JSON-RPC over stdio, one message per line, no dependencies. Claude Code starts it through
// the plugin (.claude-plugin/plugin.json) and Claude Desktop through the extension (mcp/extension/manifest.json).
//
//   node mcp/src/server.ts          (Node 22.18 or newer runs the TypeScript as is)
//
// Nothing but protocol messages may go to stdout; diagnostics go to stderr.

import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

import { INSTRUCTIONS, PROMPTS } from "./instructions.ts";
import { TOOLS, callTool } from "./tools.ts";

export const VERSION = "1.0.0";
const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

type Id = string | number | null;
interface Message { jsonrpc?: string; id?: Id; method?: string; params?: Record<string, any> }

class RpcError extends Error {
  code: number;
  constructor(code: number, message: string) { super(message); this.code = code; }
}

export function handle(msg: Message): unknown {
  const p = msg.params || {};
  switch (msg.method) {
    case "initialize":
      return {
        protocolVersion: PROTOCOLS.includes(p.protocolVersion) ? p.protocolVersion : PROTOCOLS[1],
        capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
        serverInfo: { name: "sylvester", title: "Sylvester", version: VERSION },
        instructions: INSTRUCTIONS,
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools: TOOLS.map(t => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema,
        annotations: { title: t.title, ...t.annotations } })) };
    case "tools/call": {
      if (!TOOLS.some(t => t.name === p.name)) throw new RpcError(-32602, `Unknown tool: ${p.name}`);
      const r = callTool(String(p.name), p.arguments || {});
      return { content: [{ type: "text", text: r.text }], isError: !!r.error };
    }
    case "prompts/list":
      return { prompts: PROMPTS.map(x => ({ name: x.name, title: x.title, description: x.description, arguments: x.arguments || [] })) };
    case "prompts/get": {
      const x = PROMPTS.find(q => q.name === p.name);
      if (!x) throw new RpcError(-32602, `Unknown prompt: ${p.name}`);
      return { description: x.description, messages: [{ role: "user", content: { type: "text", text: x.text(p.arguments || {}) } }] };
    }
    case "resources/list":
      return { resources: [] };
    case "resources/templates/list":
      return { resourceTemplates: [] };
  }
  throw new RpcError(-32601, `Method not found: ${msg.method}`);
}

function reply(out: (line: string) => void, line: string): void {
  let msg: Message;
  try { msg = JSON.parse(line); } catch {
    out(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }));
    return;
  }
  const isRequest = msg.id !== undefined && msg.id !== null;
  if (!msg.method) return; // a response to something we never ask
  if (!isRequest) return; // notifications (initialized, cancelled) need no answer
  try {
    out(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: handle(msg) }));
  } catch (e) {
    const code = e instanceof RpcError ? e.code : -32603;
    out(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code, message: (e as Error).message } }));
  }
}

export function serve(input: NodeJS.ReadableStream = process.stdin, write: (s: string) => void = s => { process.stdout.write(s + "\n"); }): void {
  const rl = createInterface({ input, crlfDelay: Infinity });
  rl.on("line", line => { if (line.trim()) reply(write, line); });
  rl.on("close", () => process.exit(0));
}

// Serve when run directly (not when a test imports handle()).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) serve();
