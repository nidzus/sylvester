// Oura ring: sign in once, then pull the last days whenever the app opens.
//
// Oura's sign-in needs the app's client secret, which can't live on a phone, so the Sylvester server (proxy/) does
// the two token steps: it redirects Oura's callback back into the app (sylvester://oura) and swaps the code or
// refresh token for access tokens. The tokens then live in this phone's Keychain; the data comes straight from
// Oura to the phone, never through the server.

import * as WebBrowser from "expo-web-browser";

import type { DailyRow } from "../engine/types.ts";
import { addDays, localToday } from "../engine/util.ts";
import { getSecret, setSecret } from "../store/secrets.ts";
import { REST_MODE_LOOKBACK_DAYS, ouraRows } from "./ouraMap.ts";
import type { OuraPull } from "./ouraMap.ts";

const API = "https://api.ouraring.com/v2/usercollection";
const KEY = "oura_tokens";
const RETURN = "sylvester://oura";

interface Tokens { access_token: string; refresh_token: string; expires_at: number }

async function post(server: string, path: string, body: object): Promise<Tokens> {
  const r = await fetch(`${server.replace(/\/+$/, "")}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(r.status === 404 ? "This Sylvester server doesn't offer Oura." : `Oura sign-in failed (${r.status}).`);
  const t = await r.json();
  return { access_token: t.access_token, refresh_token: t.refresh_token, expires_at: Date.now() + (Number(t.expires_in) || 86400) * 1000 };
}

/** Opens Oura's sign-in page; resolves when the person comes back with access granted. */
export async function connect(server: string): Promise<void> {
  const start = await fetch(`${server.replace(/\/+$/, "")}/oura/start`);
  if (!start.ok) throw new Error(start.status === 404 ? "This Sylvester server doesn't offer Oura." : `Couldn't start the Oura sign-in (${start.status}).`);
  const { url, state } = await start.json();
  const res = await WebBrowser.openAuthSessionAsync(url, RETURN);
  if (res.type !== "success") throw new Error("Oura sign-in was cancelled.");
  const back = new URL(res.url);
  if (back.searchParams.get("state") !== state) throw new Error("Oura sign-in didn't match; try again.");
  const code = back.searchParams.get("code");
  if (!code) throw new Error(back.searchParams.get("error") || "Oura didn't grant access.");
  await setSecret(KEY, JSON.stringify(await post(server, "/oura/token", { code })));
}

export async function disconnect(): Promise<void> {
  await setSecret(KEY, null);
}

export async function isConnected(): Promise<boolean> {
  return !!(await getSecret(KEY));
}

async function token(server: string): Promise<string> {
  const raw = await getSecret(KEY);
  if (!raw) throw new Error("Oura isn't connected.");
  let t: Tokens = JSON.parse(raw);
  if (t.expires_at - Date.now() < 5 * 60_000) {
    t = await post(server, "/oura/refresh", { refresh_token: t.refresh_token });
    await setSecret(KEY, JSON.stringify(t)); // Oura's refresh tokens rotate: save the new one at once
  }
  return t.access_token;
}

async function get(endpoint: string, tok: string, start: string, end: string): Promise<object[]> {
  const out: object[] = [];
  let next: string | null = null;
  do {
    const q: URLSearchParams = new URLSearchParams({ start_date: start, end_date: end, ...(next ? { next_token: next } : {}) });
    const r: Response = await fetch(`${API}/${endpoint}?${q}`, { headers: { Authorization: `Bearer ${tok}` } });
    if (r.status === 401) throw new Error("Oura sign-in expired. Connect Oura again in Settings.");
    if (!r.ok) throw new Error(`Oura ${endpoint}: ${r.status}`);
    const body: { data?: object[]; next_token?: string | null } = await r.json();
    out.push(...(body.data || []));
    next = body.next_token || null;
  } while (next);
  return out;
}

/** The last `days` days (default two weeks; the first pull takes 90 for a baseline). */
export async function pull(server: string, days = 14): Promise<DailyRow[]> {
  const tok = await token(server);
  const end = addDays(localToday(), 1), start = addDays(localToday(), -days);
  // Only readiness is required; the rest (heart_health ones need a newer sign-in) are skipped when unavailable.
  const names = ["daily_readiness", "daily_sleep", "daily_activity", "daily_stress", "daily_resilience", "sleep",
                 "daily_spo2", "vO2_max", "daily_cardiovascular_age"] as const;
  const got = await Promise.all(names.map(n => get(n, tok, start, end).catch(e => (n === "daily_readiness" ? Promise.reject(e) : []))));
  // Rest Mode: from further back (periods are listed by start day); unavailable -> null, so rest_mode is left out.
  const rest = await get("rest_mode_period", tok, addDays(start, -REST_MODE_LOOKBACK_DAYS), end).catch(() => null);
  return ouraRows({ ...Object.fromEntries(names.map((n, i) => [n, got[i]])), rest_mode_period: rest } as OuraPull);
}
