// What the Coach screens do: send a message, apply or decline a proposal (with the safety review first), and hand
// a blocked proposal back to the Coach. These run outside the screens, so a long answer or a review carries on
// if the person leaves the conversation.

import { useSyncExternalStore } from "react";

import { localToday } from "../engine/util.ts";
import { knowledge, lib, pictures } from "../store/catalog.ts";
import { schedule } from "../store/model.ts";
import { getState, getThreads, saveThread, update } from "../store/store.ts";
import { newThread, safetyReview, send } from "./agent.ts";
import type { Thread } from "./agent.ts";
import { applyChanges, checkChanges } from "./changes.ts";
import { explain, makeClient } from "./claude.ts";
import { connection } from "./connection.ts";
import { systemPrompt } from "./prompts.ts";
import type { Proposal } from "./tools.ts";

const busy = new Map<string, string>(); // thread id -> what it's doing
const listeners = new Set<() => void>();
let snapshot = new Map(busy);
const notify = () => { snapshot = new Map(busy); listeners.forEach(l => l()); };
const setBusy = (id: string, what: string | null) => { if (what) busy.set(id, what); else busy.delete(id); notify(); };

export function useBusy(): Map<string, string> {
  return useSyncExternalStore(cb => { listeners.add(cb); return () => listeners.delete(cb); }, () => snapshot);
}

let system: string | null = null;
const systemText = () => (system ||= systemPrompt(lib, knowledge));

export function startThread(title = "Conversation"): Thread {
  const t = newThread(getState().settings.claude.model, title);
  saveThread(t);
  return t;
}

export async function sendMessage(threadId: string, text: string, effort: "low" | "medium" | "high" = "medium"): Promise<void> {
  const thread = getThreads().find(t => t.id === threadId);
  if (!thread || busy.has(threadId)) return;
  setBusy(threadId, "Thinking…");
  try {
    const state = getState();
    const today = localToday();
    const client = makeClient(await connection(state));
    const sched = (() => { try { return schedule(state, lib, today, pictures); } catch { return null; } })();
    await send(thread, text, { client, system: systemText(), state, lib, sched, today }, effort, t => {
      saveThread(t);
      const last = t.messages[t.messages.length - 1];
      const tool = Array.isArray(last?.content) && last.role === "user" && last.content.some((b: { type: string }) => b.type === "tool_result");
      setBusy(threadId, tool ? "Working on it…" : "Thinking…");
    });
  } catch (e) {
    const t = getThreads().find(x => x.id === threadId);
    if (t) saveThread({ ...t, notice: explain(e) });
  } finally {
    setBusy(threadId, null);
  }
}

function patchProposal(threadId: string, id: string, patch: Partial<Proposal>) {
  const t = getThreads().find(x => x.id === threadId);
  if (!t) return;
  saveThread({ ...t, proposals: t.proposals.map(p => (p.id === id ? { ...p, ...patch } : p)) });
}

export async function applyProposal(threadId: string, id: string): Promise<void> {
  const t = getThreads().find(x => x.id === threadId);
  const p = t?.proposals.find(x => x.id === id);
  if (!t || !p || p.status !== "pending") return;
  if (p.confirm?.length && !p.confirmed) return; // the card asks first
  const today = localToday();
  try {
    let verdict = p.verdict;
    if (p.review) {
      setBusy(threadId, "Safety review…");
      patchProposal(threadId, id, { status: "reviewing", error: undefined });
      const conn = await connection(getState());
      verdict = await safetyReview(makeClient(conn), conn.model, getState(), p, lib, today, knowledge.medical || "");
      if (verdict.verdict === "BLOCK") { patchProposal(threadId, id, { status: "blocked", verdict }); return; }
    }
    const { blocking } = checkChanges(getState(), p.changes, lib, today); // the data may have moved on since
    if (blocking.length) { patchProposal(threadId, id, { status: "blocked", verdict: { verdict: "BLOCK", blocking, warnings: [], missing_information: [] } }); return; }
    // What the person ticked is theirs now: their confirmed ways of doing exercises count in every check.
    const changes = p.confirmed ? p.changes.map(c => c.type !== "set_adaptations" ? c : { ...c, adaptations: c.adaptations.map(a =>
      /confirm/i.test(String(a.source || "")) && p.confirm.some(line => a.how && line.includes(`"${a.how}"`))
        && !(getState().profile.health_profile.adaptations || []).some((b: object) => JSON.stringify(b) === JSON.stringify(a))
        ? { ...a, source: `you (confirmed ${today})` } : a) }) : p.changes;
    update(s => ({
      ...applyChanges(s, changes),
      changeLog: [...s.changeLog, { at: new Date().toISOString(), summary: p.summary, verdict: verdict?.verdict || "no review needed", changes: p.lines }],
    }));
    patchProposal(threadId, id, { status: "applied", verdict });
  } catch (e) {
    patchProposal(threadId, id, { status: "pending", error: explain(e) });
  } finally {
    setBusy(threadId, null);
  }
}

export function confirmProposal(threadId: string, id: string, yes: boolean): void {
  patchProposal(threadId, id, { confirmed: yes });
}

export function declineProposal(threadId: string, id: string): void {
  patchProposal(threadId, id, { status: "declined" });
}

/** Hand a blocked proposal (or one with questions) back to the Coach with the review's findings. */
export function askToFix(threadId: string, p: Proposal): Promise<void> {
  const v = p.verdict;
  const lines = [
    `The safety review ${v?.verdict === "BLOCK" ? "blocked" : "commented on"} "${p.summary}".`,
    ...(v?.blocking.length ? ["Blocking:", ...v.blocking.map(x => `- ${x}`)] : []),
    ...(v?.warnings.length ? ["Warnings:", ...v.warnings.map(x => `- ${x}`)] : []),
    ...(v?.missing_information.length ? ["Questions for me:", ...v.missing_information.map(x => `- ${x}`)] : []),
    "Please fix it and propose again, and ask me anything you need.",
  ];
  return sendMessage(threadId, lines.join("\n"), "medium");
}
