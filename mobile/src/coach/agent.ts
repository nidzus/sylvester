// One conversation with the Coach: the tool loop, the proposals it makes, and the safety review before applying.
// The history is append-only (thinking blocks and fallback blocks go back exactly as received), so prompt caching
// and the model's own reasoning carry across turns.

import type Anthropic from "@anthropic-ai/sdk";
import type { BetaContentBlockParam, BetaMessage, BetaMessageParam, BetaToolResultBlockParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";

import type { ExerciseLibrary } from "../../../shared/engine/library.ts";
import type { Schedule } from "../../../shared/engine/rolling.ts";
import type { AppState } from "../../../shared/model.ts";
import { REVIEWER, REVIEW_SCHEMA, reviewDocument } from "../../../shared/review.ts";
import { create, textOf } from "./claude.ts";
import { contextMessage } from "./prompts.ts";
import { TOOLS, runTool } from "./tools.ts";
import type { Proposal } from "./tools.ts";

export interface Usage { input: number; output: number; cache_read: number; cache_write: number }
export interface Thread {
  id: string; title: string; created: string; model: string;
  messages: BetaMessageParam[];
  proposals: Proposal[];
  usage: Usage;
  notice?: string; // the last turn's problem, if any (a refusal, a cut-off answer)
}

export function newThread(model: string, title = "Conversation"): Thread {
  return { id: `t-${Date.now().toString(36)}`, title, created: new Date().toISOString(), model, messages: [], proposals: [],
    usage: { input: 0, output: 0, cache_read: 0, cache_write: 0 } };
}

const MAX_STEPS = 12;

function addUsage(u: Usage, m: BetaMessage): Usage {
  return { input: u.input + (m.usage.input_tokens || 0), output: u.output + (m.usage.output_tokens || 0),
    cache_read: u.cache_read + (m.usage.cache_read_input_tokens || 0), cache_write: u.cache_write + (m.usage.cache_creation_input_tokens || 0) };
}

export interface TurnEnv { client: Anthropic; system: string; state: AppState; lib: ExerciseLibrary; sched: Schedule | null; today: string }

/** Send the person's message and run the Coach until it answers. Calls onUpdate after every step, so the screen can
 *  show tool progress and proposals as they arrive. */
export async function send(thread: Thread, text: string, env: TurnEnv, effort: "low" | "medium" | "high" = "medium",
                           onUpdate?: (t: Thread) => void): Promise<Thread> {
  let t: Thread = { ...thread, notice: undefined, messages: [...thread.messages] };
  const first = t.messages.length === 0;
  const content: BetaContentBlockParam[] = first
    ? [{ type: "text", text: contextMessage(env.state, env.sched, env.today) }, { type: "text", text }]
    : [{ type: "text", text }];
  t.messages.push({ role: "user", content });
  onUpdate?.(t);
  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await create(env.client, t.model, {
      max_tokens: 16000,
      system: [{ type: "text", text: env.system, cache_control: { type: "ephemeral", ttl: "1h" } }],
      messages: t.messages,
      tools: TOOLS,
      output_config: { effort },
      cache_control: { type: "ephemeral" },
    });
    t = { ...t, usage: addUsage(t.usage, res), messages: [...t.messages, { role: "assistant", content: res.content as BetaContentBlockParam[] }] };
    if (res.stop_reason === "tool_use") {
      const results: BetaToolResultBlockParam[] = [];
      const proposals = [...t.proposals];
      for (const b of res.content) {
        if (b.type !== "tool_use") continue;
        let out: { content: string; is_error?: boolean };
        try {
          out = runTool(b.name, (b.input || {}) as Record<string, unknown>, env, p => proposals.push(p));
        } catch (e) {
          out = { content: `The tool failed: ${(e as Error).message}`, is_error: true };
        }
        results.push({ type: "tool_result", tool_use_id: b.id, content: out.content, ...(out.is_error ? { is_error: true } : {}) });
      }
      t = { ...t, proposals, messages: [...t.messages, { role: "user", content: results }] };
      onUpdate?.(t);
      continue;
    }
    if (res.stop_reason === "pause_turn") { onUpdate?.(t); continue; }
    if (res.stop_reason === "refusal") t.notice = "The Coach couldn't answer that one. Try rephrasing it.";
    else if (res.stop_reason === "max_tokens") t.notice = "The answer was cut off. Ask the Coach to continue.";
    if (first && t.title === "Conversation") t.title = text.slice(0, 60);
    onUpdate?.(t);
    return t;
  }
  t.notice = "The Coach took too many steps. Ask again, more specifically.";
  return t;
}

/** The Coach's visible text per turn, for the chat screen. Tool calls show as one short line. */
export function transcript(t: Thread): { role: "user" | "coach" | "tool"; text: string }[] {
  const out: { role: "user" | "coach" | "tool"; text: string }[] = [];
  t.messages.forEach((m, i) => {
    const blocks = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
    for (const b of blocks as { type: string; text?: string; name?: string }[]) {
      if (m.role === "user" && b.type === "text" && !(i === 0 && b.text?.startsWith("<my_data>"))) out.push({ role: "user", text: b.text || "" });
      if (m.role === "assistant" && b.type === "text" && b.text?.trim()) out.push({ role: "coach", text: b.text });
      if (m.role === "assistant" && b.type === "tool_use") out.push({ role: "tool", text: TOOL_LABEL[b.name || ""] || b.name || "" });
    }
  });
  return out;
}

const TOOL_LABEL: Record<string, string> = {
  find_exercises: "Looked through the exercise library", get_exercise: "Read an exercise", get_schedule: "Read the next 14 days",
  get_history: "Read your logs", propose_changes: "Proposed changes",
};

export type Verdict = NonNullable<Proposal["verdict"]>;

/** The independent safety review (a separate call, without the Coach's conversation). */
export async function safetyReview(client: Anthropic, model: string, state: AppState, p: Proposal, lib: ExerciseLibrary, today: string,
                                   medical: string): Promise<Verdict> {
  const r = reviewDocument(state, p, lib, today);
  if ("blocked" in r) return r.blocked;
  const { doc, warnings } = r;
  const res = await create(client, model, {
    max_tokens: 8000,
    system: [{ type: "text", text: `${REVIEWER}\n\n<knowledge module="medical">\n${medical}\n</knowledge>`, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: `Review this proposal.\n<data>\n${JSON.stringify(doc)}\n</data>` }],
    output_config: { effort: "high", format: { type: "json_schema", schema: REVIEW_SCHEMA } },
  });
  if (res.stop_reason === "refusal") throw new Error("The safety review couldn't run on this proposal. Ask the Coach to rephrase it.");
  try {
    const v = JSON.parse(textOf(res)) as Verdict;
    if (!["PASS", "PASS WITH WARNINGS", "BLOCK"].includes(v.verdict)) throw new Error("bad verdict");
    return { ...v, warnings: [...warnings, ...(v.warnings || [])] };
  } catch {
    throw new Error("The safety review's answer couldn't be read. Try again.");
  }
}
