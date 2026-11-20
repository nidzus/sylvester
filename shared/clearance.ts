// The doctor's go-ahead: the rule lives in the engine (engine/clearance.ts, the same as the desktop's); this records it.

import { clearanceKeys } from "./engine/clearance.ts";
import type { Obj } from "./engine/types.ts";

export { clearanceKeys, needsClearance } from "./engine/clearance.ts";

/** Record a go-ahead for everything that currently calls for one. */
export function recordClearance(hp: Obj, date: string, by: string): Obj {
  const r = hp.restrictions || {};
  const note = `Cleared to train by ${by} (${date}).`;
  return { ...hp, restrictions: { ...r, cleared_on: date, cleared_by: by, cleared_for: clearanceKeys(hp),
    medical_advice: [String(r.medical_advice || "").trim(), note].filter(Boolean).join(" ") } };
}
