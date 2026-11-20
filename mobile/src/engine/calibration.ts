// The calibration test catalogue: the shared tests (coach/assessments.json) merged with the person's own
// adjustments (plans/calibration.json on the desktop). Port of coach/catalogue.py and phone.py battery_doc.
// Test ids are stable across people and retests; personal changes never rename a test.

import type { Obj } from "./types.ts";

export interface Catalogue { tests: Record<string, Obj>; batteries: Record<string, Obj> }

export function mergeCatalogue(shared: Catalogue, personal: Partial<Catalogue> | null | undefined): Catalogue {
  const tests: Record<string, Obj> = { ...shared.tests };
  for (const [id, over] of Object.entries(personal?.tests || {})) tests[id] = { ...(tests[id] || {}), ...over };
  return { tests, batteries: { ...(shared.batteries || {}), ...(personal?.batteries || {}) } };
}

/** A battery as a session the phone shows test by test (kind "assessment"). */
export function batteryDoc(cat: Catalogue, batteryId: string, date: string): Obj | null {
  const b = cat.batteries[batteryId];
  if (!b) return null;
  const tests = (b.tests || []).filter((t: string) => cat.tests[t]).map((t: string) => {
    const { needs: _n, implement: _i, ...rest } = cat.tests[t];
    return { id: t, ...rest };
  });
  return { kind: "assessment", battery: batteryId, title: b.title, date, duration: b.duration || "",
    coach_note: b.coach_note || "", warmup: b.warmup || [], tests };
}

/** One result row per test and side, as records/assessments.csv keeps them. */
export interface AssessmentResult {
  test: string; name: string; side: string; value: string; unit: string; load_kg: string; rpe: string; pain: string;
  flags: string[]; note: string;
}
