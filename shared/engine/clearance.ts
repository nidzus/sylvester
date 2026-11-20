// Who needs a doctor's go-ahead before any plan (port of clearance_reasons in coach/rolling.py): a yes to chest
// pain, dizziness or fainting, or "train only under supervision" in the health check; a heart condition (the
// health-check question also covers high blood pressure, so a yes counts unless they said it's blood pressure
// only); pregnancy (the care provider's OK). A go-ahead covers the reasons it was given for, with a date
// (restrictions.cleared_for / cleared_on); a new reason needs a new one. Until then the plan lays out no sessions.

import type { Obj } from "./types.ts";

export const REASONS: Record<string, string> = {
  chest: "chest pain", dizzy: "dizziness or fainting", supervised: "a doctor's advice to exercise only under supervision",
  heart: "a heart condition", pregnancy: "pregnancy (your care provider's OK)",
};

/** Reason keys (see REASONS) that call for a go-ahead, whether or not one is recorded. */
export function clearanceKeys(hp: Obj): string[] {
  const a = hp?.screening?.answers || {};
  const conds: string[] = hp?.limits?.conditions || [];
  const out: string[] = [];
  for (const k of ["chest", "dizzy", "supervised"]) if (a[k] === "yes") out.push(k);
  if (conds.includes("heart") || (a.heart === "yes" && !conds.includes("hypertension"))) out.push("heart");
  if (conds.includes("pregnancy")) out.push("pregnancy");
  return out;
}

/** What still stands between this person and a plan, in words ([] = nothing). */
export function needsClearance(hp: Obj): string[] {
  const r = hp?.restrictions || {};
  const covered = /^\d{4}-\d{2}-\d{2}$/.test(String(r.cleared_on || "")) ? new Set<string>(r.cleared_for || []) : new Set<string>();
  return clearanceKeys(hp).filter(k => !covered.has(k)).map(k => REASONS[k]);
}
