// The server, against an in-memory store and a stand-in for Anthropic and Oura (no network, no keys).
//   node --test test/worker.test.ts

import assert from "node:assert/strict";
import { test } from "node:test";

import worker, { cost } from "../src/worker.ts";
import type { Env, KV } from "../src/worker.ts";

function memoryKV(): KV & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    async get(k) { return data.get(k) ?? null; },
    async put(k, v) { data.set(k, v); },
    async delete(k) { data.delete(k); },
    async list({ prefix }) { return { keys: [...data.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true }; },
  };
}

function setup() {
  const env: Env = { SYLVESTER: memoryKV(), ANTHROPIC_API_KEY: "owner-key", ADMIN_TOKEN: "admin-secret", OURA_CLIENT_ID: "cid", OURA_CLIENT_SECRET: "csecret" };
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    if (String(url).startsWith("https://api.anthropic.com")) {
      return new Response(JSON.stringify({ id: "m", content: [{ type: "text", text: "hi" }], stop_reason: "end_turn",
        usage: { input_tokens: 100_000, output_tokens: 10_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }),
        { status: 200, headers: { "content-type": "application/json", "request-id": "req_1" } });
    }
    if (String(url).startsWith("https://api.ouraring.com/oauth/token")) {
      return new Response(JSON.stringify({ access_token: "a", refresh_token: "r", expires_in: 86400 }), { status: 200 });
    }
    throw new Error("unexpected fetch " + url);
  }) as typeof fetch;
  const call = (path: string, init: RequestInit = {}) => worker.fetch(new Request(`https://sylvester.example.workers.dev${path}`, init), env);
  return { env, calls, call };
}

const body = async (r: Response): Promise<any> => r.json();
const post = (body: unknown, headers: Record<string, string> = {}) => ({ method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

async function joined(s: ReturnType<typeof setup>, monthly = 5) {
  const inv = await body(await s.call("/admin/invites", post({ monthly_usd: monthly, uses: 1, label: "a friend" }, { authorization: "Bearer admin-secret" })));
  const j = await body(await s.call("/v1/join", post({ invite: inv.code })));
  return { code: inv.code as string, token: j.token as string };
}

test("only the admin makes invites; an invite works once and gives a token", async () => {
  const s = setup();
  assert.equal((await s.call("/admin/invites", post({}, { authorization: "Bearer wrong" }))).status, 401);
  const { code, token } = await joined(s);
  assert.ok(token.length > 30);
  assert.equal((await s.call("/v1/join", post({ invite: code }))).status, 403);
  assert.ok(![...(s.env.SYLVESTER as any).data.keys()].some((k: string) => k.includes(token)), "tokens are stored hashed");
});

test("messages go to Anthropic with the owner's key, and their cost is counted", async () => {
  const s = setup();
  const { token } = await joined(s);
  const r = await s.call("/v1/messages?beta=true", post({ model: "claude-opus-5-5", max_tokens: 100_000, messages: [{ role: "user", content: "hi" }] },
    { authorization: `Bearer ${token}`, "anthropic-version": "2023-06-01", "anthropic-beta": "server-side-fallback-2026-07-01,some-other-beta" }));
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("request-id"), "req_1");
  const sent = s.calls[0];
  assert.equal(sent.url, "https://api.anthropic.com/v1/messages?beta=true");
  const h = sent.init.headers as Record<string, string>;
  assert.equal(h["x-api-key"], "owner-key");
  assert.equal(h["anthropic-beta"], "server-side-fallback-2026-07-01");
  assert.equal(JSON.parse(String(sent.init.body)).max_tokens, 16000);
  const u = await body(await s.call("/v1/usage", { headers: { authorization: `Bearer ${token}` } }));
  assert.equal(u.used_usd, 0.6); // 100k in at $4/M + 10k out at $20/M
});

test("the monthly allowance, the model list and server tools are enforced", async () => {
  const s = setup();
  const { token } = await joined(s, 0.5);
  const auth = { authorization: `Bearer ${token}` };
  assert.equal((await s.call("/v1/messages", post({ model: "claude-fable-5-1", max_tokens: 10, messages: [] }, auth))).status, 400);
  assert.equal((await s.call("/v1/messages", post({ model: "claude-opus-5-5", max_tokens: 10, messages: [], tools: [{ type: "web_search_20260209", name: "web_search" }] }, auth))).status, 400);
  assert.equal((await s.call("/v1/messages", post({ model: "claude-opus-5-5", max_tokens: 10, messages: [], stream: true }, auth))).status, 400);
  assert.equal((await s.call("/v1/messages", post({ model: "claude-opus-5-5", max_tokens: 10, messages: [] }, auth))).status, 200);
  assert.equal((await s.call("/v1/messages", post({ model: "claude-opus-5-5", max_tokens: 10, messages: [] }, auth))).status, 402);
  assert.equal((await s.call("/v1/messages", post({ model: "claude-opus-5-5", max_tokens: 10, messages: [] }, { authorization: "Bearer nope" }))).status, 401);
});

test("Oura: the sign-in returns to the app, and the secret stays on the server", async () => {
  const s = setup();
  const start = await body(await s.call("/oura/start"));
  assert.match(start.url, /^https:\/\/cloud\.ouraring\.com\/oauth\/authorize\?/);
  assert.ok(!start.url.includes("csecret"));
  const cb = await s.call(`/oura/callback?code=abc&state=${start.state}`);
  assert.equal(cb.status, 302);
  assert.equal(cb.headers.get("location"), `sylvester://oura?code=abc&state=${start.state}`);
  const tok = await body(await s.call("/oura/token", post({ code: "abc" })));
  assert.equal(tok.access_token, "a");
  assert.match(String(s.calls[0].init.body), /client_secret=csecret/);
});

test("cost counts cache writes and reads", () => {
  assert.equal(cost("claude-opus-5-5", { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1e6, cache_creation: { ephemeral_1h_input_tokens: 1e6, ephemeral_5m_input_tokens: 0 } }), 0.4 + 8);
});
