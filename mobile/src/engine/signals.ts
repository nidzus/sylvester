// Daily check-in scales: the common ones, plus each person's own warning signals (port of core/signals.py).

import type { Obj, Signal } from "./types.ts";

export const BASE: Signal[] = [
  { key: "mood", label: "Mood", lo: 1, hi: 5, hint: "1 low · 5 great" },
  { key: "energy", label: "Energy", lo: 1, hi: 5, hint: "1 drained · 5 full" },
  { key: "stress", label: "Stress", lo: 1, hi: 5, hint: "1 calm · 5 overloaded" },
  { key: "motivation", label: "Motivation to train", lo: 1, hi: 5, hint: "1 none · 5 eager" },
  { key: "soreness", label: "Muscle soreness", lo: 1, hi: 5, hint: "1 none · 5 very sore" },
  { key: "pain", label: "Pain", lo: 0, hi: 10, hint: "0 none · 10 worst" },
];
export const BASE_KEYS = BASE.map(s => s.key);

export function personal(healthProfile: Obj | null | undefined): Signal[] {
  const out: Signal[] = [];
  for (const s of healthProfile?.signals || []) {
    if (s.key && !BASE_KEYS.includes(s.key) && s.label) out.push({ lo: 0, hi: 3, hint: "", ...s });
  }
  return out;
}

/** The action for the highest level at or below value, or null. A level may be just a day word ("easy"). */
export function levelActions(signal: Signal, value: unknown): Obj | null {
  if (value === null || value === undefined || value === "") return null;
  const v = Number(value);
  if (!Number.isFinite(v)) return null;
  let best: [number, Obj] | null = null;
  for (const [lvl, action] of Object.entries(signal.levels || {})) {
    const l = Number(lvl);
    if (!Number.isFinite(l)) continue;
    if (v >= l && (best === null || l > best[0])) best = [l, typeof action === "string" ? { day: action } : action];
  }
  return best ? best[1] : null;
}
