// The Sylvester server: a Cloudflare Worker that lets invited people use the Coach on the owner's Anthropic account.
//
//   POST /v1/join       {invite}            -> {token, monthly_usd}   an invite code becomes a personal token
//   GET  /v1/usage      (Bearer token)      -> {month, used_usd, monthly_usd}
//   POST /v1/messages   (Bearer token)      -> forwarded to Anthropic with the owner's key, within the monthly allowance
//   GET  /oura/start, /oura/callback, POST /oura/token, /oura/refresh   Oura sign-in for the app (holds the client secret)
//   POST /admin/invites (Bearer ADMIN_TOKEN) {monthly_usd, uses, label} -> {code}
//   GET  /admin/users   (Bearer ADMIN_TOKEN) -> who joined and what they used this month
//
// It stores invites, hashed tokens and monthly totals in one KV namespace, and nothing else: request and response
// bodies (which hold people's health data) are passed through and never logged or kept.

export interface KV {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list(opts: { prefix: string; cursor?: string }): Promise<{ keys: { name: string }[]; list_complete: boolean; cursor?: string }>;
}

export interface Env {
  SYLVESTER: KV;
  ANTHROPIC_API_KEY: string;
  ADMIN_TOKEN: string;
  OURA_CLIENT_ID?: string;
  OURA_CLIENT_SECRET?: string;
  ALLOWED_MODELS?: string;   // comma-separated; default below
  MAX_TOKENS?: string;       // per request; default 16000
}

const ANTHROPIC = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];
const BETAS = new Set(["server-side-fallback-2026-07-01", "server-side-fallback-2026-06-01"]);
// $ per million tokens: input, output. Cache writes cost 1.25x input (5 min) or 2x (1 h); cache reads 0.1x.
const PRICES: Record<string, [number, number]> = {
  "claude-opus-5-5": [4, 20], "claude-sonnet-5-5": [2, 10], "claude-haiku-5-5": [0.1, 0.5],
};
const MAX_BODY = 4_000_000;
const OURA_AUTH = "https://cloud.ouraring.com/oauth/authorize";
const OURA_TOKEN = "https://api.ouraring.com/oauth/token";
const OURA_SCOPES = "daily heartrate personal session spo2 stress heart_health"; // heart_health: VO2 max, cardiovascular age
const APP_RETURN = "sylvester://oura";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const error = (status: number, message: string) => json({ type: "error", error: { type: "sylvester_error", message } }, status);

function randomToken(bytes = 32): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map(x => x.toString(16).padStart(2, "0")).join("");
}

function bearer(req: Request): string {
  const h = req.headers.get("authorization") || "";
  return h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : "";
}

/** Constant-time comparison for the admin token. */
function same(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

interface User { id: string; label: string; monthly_usd: number; created: string }

async function user(req: Request, env: Env): Promise<User | null> {
  const t = bearer(req);
  if (!t) return null;
  const raw = await env.SYLVESTER.get(`user:${await sha256(t)}`);
  return raw ? JSON.parse(raw) : null;
}

const month = (now = new Date()) => now.toISOString().slice(0, 7);

async function used(env: Env, id: string): Promise<number> {
  return Number(await env.SYLVESTER.get(`usage:${id}:${month()}`)) || 0;
}

/** What a response cost, from its token counts (an estimate: a fallback model's own price may differ a little). */
export function cost(model: string, usage: Record<string, any> | undefined): number {
  if (!usage) return 0;
  const [pin, pout] = PRICES[model] || PRICES["claude-opus-5-5"];
  const cc = usage.cache_creation || {};
  const writes1h = Number(cc.ephemeral_1h_input_tokens) || 0;
  const writes5m = cc.ephemeral_5m_input_tokens !== undefined ? Number(cc.ephemeral_5m_input_tokens) || 0
    : Math.max(0, (Number(usage.cache_creation_input_tokens) || 0) - writes1h);
  const tokens = (Number(usage.input_tokens) || 0) * pin + writes5m * pin * 1.25 + writes1h * pin * 2
    + (Number(usage.cache_read_input_tokens) || 0) * pin * 0.1 + (Number(usage.output_tokens) || 0) * pout;
  return tokens / 1e6;
}

async function messages(req: Request, env: Env): Promise<Response> {
  const u = await user(req, env);
  if (!u) return error(401, "Unknown or missing token. Join again with an invite code.");
  const spent = await used(env, u.id);
  if (spent >= u.monthly_usd) return error(402, `This month's allowance ($${u.monthly_usd}) is used up.`);
  const text = await req.text();
  if (text.length > MAX_BODY) return error(413, "The request is too large.");
  let body: Record<string, any>;
  try { body = JSON.parse(text); } catch { return error(400, "The request isn't JSON."); }
  const models = (env.ALLOWED_MODELS || "").split(",").map(s => s.trim()).filter(Boolean);
  if (!(models.length ? models : DEFAULT_MODELS).includes(body.model)) return error(400, `The model ${body.model} isn't offered here.`);
  if (body.stream) return error(400, "Streaming isn't offered here.");
  const cap = Number(env.MAX_TOKENS) || 16000;
  if (!(Number(body.max_tokens) > 0) || body.max_tokens > cap) body.max_tokens = Math.min(Number(body.max_tokens) || cap, cap);
  // Only the app's own tools: no server-side tools, MCP servers or containers on the owner's account.
  for (const k of ["mcp_servers", "container", "speed", "service_tier", "inference_geo"]) delete body[k];
  if (Array.isArray(body.tools) && body.tools.some((t: any) => t.type && t.type !== "custom")) return error(400, "Only the app's own tools are allowed.");
  const betas = (req.headers.get("anthropic-beta") || "").split(",").map(s => s.trim()).filter(b => BETAS.has(b));
  const r = await fetch(`${ANTHROPIC}${new URL(req.url).search.includes("beta=true") ? "?beta=true" : ""}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": req.headers.get("anthropic-version") || "2023-06-01",
      ...(betas.length ? { "anthropic-beta": betas.join(",") } : {}),
    },
    body: JSON.stringify(body),
  });
  const out = await r.text();
  if (r.ok) {
    try {
      const c = cost(body.model, JSON.parse(out).usage);
      await env.SYLVESTER.put(`usage:${u.id}:${month()}`, String(Math.round((spent + c) * 1e6) / 1e6));
    } catch { /* a response without usage costs nothing to record */ }
  }
  return new Response(out, { status: r.status, headers: { "content-type": r.headers.get("content-type") || "application/json",
    ...(r.headers.get("request-id") ? { "request-id": r.headers.get("request-id")! } : {}) } });
}

async function join(req: Request, env: Env): Promise<Response> {
  const { invite } = await req.json().catch(() => ({})) as { invite?: string };
  if (!invite || typeof invite !== "string") return json({ error: "Enter an invite code." }, 400);
  const key = `invite:${await sha256(invite.trim())}`;
  const raw = await env.SYLVESTER.get(key);
  if (!raw) return json({ error: "That invite code isn't valid (or was used up)." }, 403);
  const inv = JSON.parse(raw) as { monthly_usd: number; uses: number; label: string };
  if (inv.uses <= 1) await env.SYLVESTER.delete(key);
  else await env.SYLVESTER.put(key, JSON.stringify({ ...inv, uses: inv.uses - 1 }));
  const token = randomToken();
  const u: User = { id: randomToken(9), label: inv.label || "", monthly_usd: inv.monthly_usd, created: new Date().toISOString() };
  await env.SYLVESTER.put(`user:${await sha256(token)}`, JSON.stringify(u));
  await env.SYLVESTER.put(`member:${u.id}`, JSON.stringify(u));
  return json({ token, monthly_usd: u.monthly_usd });
}

async function admin(req: Request, env: Env, path: string): Promise<Response> {
  if (!same(bearer(req), env.ADMIN_TOKEN || "")) return error(401, "Not allowed.");
  if (path === "/admin/invites" && req.method === "POST") {
    const b = await req.json().catch(() => ({})) as { monthly_usd?: number; uses?: number; label?: string };
    const code = randomToken(9);
    await env.SYLVESTER.put(`invite:${await sha256(code)}`, JSON.stringify({
      monthly_usd: Math.max(0, Number(b.monthly_usd) || 5), uses: Math.max(1, Number(b.uses) || 1), label: String(b.label || "") }));
    return json({ code });
  }
  if (path === "/admin/users" && req.method === "GET") {
    const out = [];
    let cursor: string | undefined;
    do {
      const page = await env.SYLVESTER.list({ prefix: "member:", cursor });
      for (const k of page.keys) {
        const u = JSON.parse((await env.SYLVESTER.get(k.name)) || "{}") as User;
        out.push({ ...u, used_usd: await used(env, u.id), month: month() });
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    return json(out);
  }
  return error(404, "Unknown admin route.");
}

async function ouraToken(env: Env, params: Record<string, string>): Promise<Response> {
  const r = await fetch(OURA_TOKEN, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.OURA_CLIENT_ID!, client_secret: env.OURA_CLIENT_SECRET!, ...params }).toString() });
  const body = await r.text();
  return new Response(body, { status: r.status, headers: { "content-type": "application/json" } });
}

async function oura(req: Request, env: Env, path: string, origin: string): Promise<Response> {
  if (!env.OURA_CLIENT_ID || !env.OURA_CLIENT_SECRET) return error(404, "Oura isn't set up on this server.");
  const redirect = `${origin}/oura/callback`;
  if (path === "/oura/start") {
    const state = randomToken(16);
    await env.SYLVESTER.put(`oura-state:${state}`, "1", { expirationTtl: 600 });
    const q = new URLSearchParams({ client_id: env.OURA_CLIENT_ID, redirect_uri: redirect, response_type: "code", scope: OURA_SCOPES, state });
    return json({ url: `${OURA_AUTH}?${q}`, state });
  }
  if (path === "/oura/callback") {
    const u = new URL(req.url);
    const back = new URLSearchParams();
    for (const k of ["code", "state", "error"]) { const v = u.searchParams.get(k); if (v) back.set(k, v); }
    return new Response(null, { status: 302, headers: { location: `${APP_RETURN}?${back}` } });
  }
  if (path === "/oura/token" && req.method === "POST") {
    const { code } = await req.json().catch(() => ({})) as { code?: string };
    if (!code) return error(400, "No code.");
    return ouraToken(env, { grant_type: "authorization_code", code, redirect_uri: redirect });
  }
  if (path === "/oura/refresh" && req.method === "POST") {
    const { refresh_token } = await req.json().catch(() => ({})) as { refresh_token?: string };
    if (!refresh_token) return error(400, "No refresh token.");
    return ouraToken(env, { grant_type: "refresh_token", refresh_token });
  }
  return error(404, "Unknown Oura route.");
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    try {
      if (path === "/v1/messages" && req.method === "POST") return await messages(req, env);
      if (path === "/v1/join" && req.method === "POST") return await join(req, env);
      if (path === "/v1/usage" && req.method === "GET") {
        const u = await user(req, env);
        return u ? json({ month: month(), used_usd: await used(env, u.id), monthly_usd: u.monthly_usd }) : error(401, "Unknown token.");
      }
      if (path.startsWith("/admin/")) return await admin(req, env, path);
      if (path.startsWith("/oura/")) return await oura(req, env, path, url.origin);
      if (path === "/") return new Response("Sylvester server", { status: 200 });
      return error(404, "Not found.");
    } catch {
      return error(500, "The Sylvester server had a problem.");
    }
  },
};
