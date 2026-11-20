// Which Claude the Coach uses, and joining the hosted service with an invite code.

import Constants from "expo-constants";

import type { AppState } from "../../../shared/model.ts";
import { getSecret, setSecret } from "../store/secrets.ts";
import type { Connection } from "./claude.ts";

/** The Sylvester server this build talks to (app.json -> expo.extra.serverUrl), unless Settings names another. */
export const BUILT_IN_SERVER = String(Constants.expoConfig?.extra?.serverUrl || "");

export function serverUrl(state: AppState): string {
  return (state.settings.claude.proxyUrl || BUILT_IN_SERVER).replace(/\/+$/, "");
}

export async function connection(state: AppState): Promise<Connection> {
  const c = state.settings.claude;
  return {
    mode: c.mode, model: c.model,
    apiKey: c.mode === "own_key" ? await getSecret("anthropic_api_key") : null,
    proxyUrl: serverUrl(state), token: c.mode === "hosted" ? await getSecret("hosted_token") : null,
  };
}

export async function join(server: string, invite: string): Promise<{ monthly_usd: number }> {
  if (!server) throw new Error("This build has no Sylvester server. Enter its address under Advanced.");
  const r = await fetch(`${server}/v1/join`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ invite: invite.trim() }) });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `The server said no (${r.status}).`);
  await setSecret("hosted_token", body.token);
  return { monthly_usd: body.monthly_usd };
}

export async function usage(server: string): Promise<{ month: string; used_usd: number; monthly_usd: number } | null> {
  const token = await getSecret("hosted_token");
  if (!server || !token) return null;
  const r = await fetch(`${server}/v1/usage`, { headers: { authorization: `Bearer ${token}` } });
  return r.ok ? r.json() : null;
}
