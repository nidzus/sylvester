// Talking to Claude. Two ways, one SDK:
//   own_key  the person's own Anthropic API key (kept in the iPhone Keychain), straight to api.anthropic.com
//   hosted   the app owner's key, through the Sylvester server (proxy/): the phone holds only a personal token,
//            the server adds the key, checks the monthly allowance and forwards the request. It stores nothing.
// A Claude Pro or Max subscription can't be used by other apps, so these are the two options.

import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessage, MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/beta/messages/messages";

import type { ClaudeMode } from "../../../shared/model.ts";

export const MODELS = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5", note: "Best coaching. About $4 / $20 per million tokens in / out." },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", note: "Faster, about half the cost." },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5", note: "Cheapest; fine for quick questions, weaker at writing plans." },
];

export interface Connection { mode: ClaudeMode; model: string; apiKey?: string | null; proxyUrl?: string; token?: string | null }

export class NotConnected extends Error {}

export function makeClient(c: Connection): Anthropic {
  const common = { maxRetries: 2, timeout: 240_000, dangerouslyAllowBrowser: true };
  if (c.mode === "own_key") {
    if (!c.apiKey) throw new NotConnected("Add your Anthropic API key in Settings first.");
    return new Anthropic({ ...common, apiKey: c.apiKey });
  }
  if (c.mode === "hosted") {
    if (!c.proxyUrl || !c.token) throw new NotConnected("Join with an invite code in Settings first.");
    return new Anthropic({ ...common, apiKey: null, authToken: c.token, baseURL: c.proxyUrl.replace(/\/+$/, "") });
  }
  throw new NotConnected("The Coach is off. Turn it on in Settings.");
}

type Params = Omit<MessageCreateParamsNonStreaming, "model">;

/** One request with the defaults every call uses: refusals retried on Anthropic's recommended fallback model
 *  (Opus and Sonnet; Haiku has none). Thinking is adaptive (the model's default); effort is set per call. */
export async function create(client: Anthropic, model: string, params: Params): Promise<BetaMessage> {
  const fallback = model.startsWith("claude-opus") || model.startsWith("claude-sonnet");
  return client.beta.messages.create({
    model,
    ...params,
    ...(fallback ? { betas: [...(params.betas || []), "server-side-fallback-2026-07-01"], fallbacks: "default" } : {}),
  } as MessageCreateParamsNonStreaming);
}

/** A message the person can act on, for anything that went wrong. */
export function explain(err: unknown): string {
  if (err instanceof NotConnected) return err.message;
  if (err instanceof Anthropic.AuthenticationError) return "Claude didn't accept the key or token. Check it in Settings.";
  if (err instanceof Anthropic.PermissionDeniedError) return "This key isn't allowed to use that model. Pick another model in Settings.";
  if (err instanceof Anthropic.RateLimitError) return "Too many requests right now. Wait a minute and try again.";
  if (err instanceof Anthropic.APIConnectionTimeoutError) return "Claude took too long to answer. Try again; a shorter question helps.";
  if (err instanceof Anthropic.APIConnectionError) return "No connection to Claude. Check the internet and try again.";
  if (err instanceof Anthropic.APIError) {
    if (err.status === 402) return "This month's Coach allowance is used up. It resets on the 1st; the plan and logging keep working.";
    if (err.status && err.status >= 500) return "Claude is having trouble right now. Try again in a few minutes.";
    return `Claude couldn't handle the request (${err.status ?? "error"}): ${err.message}`;
  }
  return `Something went wrong: ${(err as Error)?.message || String(err)}`;
}

export function textOf(msg: BetaMessage): string {
  return msg.content.filter(b => b.type === "text").map(b => (b as { text: string }).text).join("\n").trim();
}
