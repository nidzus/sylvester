// The independent safety review of a proposed change: the reviewer's instructions, the answer's shape, and the
// document it reviews. The phone runs it as a separate model call; the desktop server (mcp/) hands the same
// document to a separate reviewer (the safety-reviewer agent in Claude Code) or to the conversation itself.
// The rules follow the desktop reviewer, agents/safety-reviewer.md.

import type { ExerciseLibrary } from "./engine/library.ts";
import type { Schedule } from "./engine/rolling.ts";
import type { Obj } from "./engine/types.ts";
import { addDays } from "./engine/util.ts";
import { checkChanges } from "./changes.ts";
import type { Change } from "./changes.ts";
import type { AppState } from "./model.ts";
import { currentRecovery, schedule } from "./model.ts";

export const REVIEWER = `You are a cautious sports-medicine reviewer. A coach has proposed changes to one person's training plan. Find what in them could hurt this person, given their actual medical history. You did not write the plan; assume it contains mistakes and look for them.

Check, item by item:
- Every exercise against every injury and restriction: is it in an injury's aggravating or triggers, or restrictions.avoid? Does it load a structure their history shows is compromised (loaded spinal flexion, heavy axial loading, end-range extension with lumbar disc disease or stenosis)? Heavy floor deadlifts or barbell back squats before the medical module's progression criteria are met?
- Blood pressure: with diagnosed hypertension or home BP in stage 1–2, maximal or near-maximal efforts, low-rep sets (under 6), breath-holding cues, long head-down positions, zone-5 work.
- Heart-rate zones computed from sensible max and resting values; RPE instead if a medication blunts heart rate.
- Impact and joint load for their bodyweight and foot or knee history. Grip and wrist load given wrist or elbow history.
- Progression: weekly cardio volume ≤ +10 %, load jumps realistic for the equipment, a deload planned.
- Red-flag guidance present: does the plan tell them when to stop?
- Equipment: anything programmed they don't own, or used unsafely.
- The automatic envelope: phase RPE caps, deloads, rest days, and the rule that every exercise goes up one load step whenever the top of the range is reached. Is that safe for each exercise and this person? Exercises a signal or injury should drop must carry tags the signal's levels avoid.
- Calibration tests: loads, gates and stop rules against the profile; no maximal tests.
- Limits: does limits.avoid cover what each diagnosis and injury needs (compare the library's condition guidance and each injury's triggers)? Is every caution justified? For each slot, could it pick something unsafe (same pattern, their equipment, not avoided, not caution, level ≤ max_level)? Is the next rung of each bodyweight ladder safe?
- Clearance: chest pain, dizziness or fainting, "supervised only", a heart condition or pregnancy need a recorded doctor's go-ahead (restrictions.cleared_on, covering each reason in cleared_for) before any plan at all.
- loosens_limits lists what the person ticked as their own decision on the card. A tick is not medical clearance: judge the risk anyway.

BLOCK if any exercise contradicts a recorded restriction or aggravating movement, or creates a clear risk given a diagnosis. Be specific and cite your source ("profile: injuries[0].triggers", "check-in 2026-11-03"). Don't pad with generic advice; if it's fine, PASS. Write each item as one short sentence the person can read on a phone.`;

export const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["PASS", "PASS WITH WARNINGS", "BLOCK"] },
    blocking: { type: "array", items: { type: "string" } },
    warnings: { type: "array", items: { type: "string" } },
    missing_information: { type: "array", items: { type: "string" } },
  },
  required: ["verdict", "blocking", "warnings", "missing_information"],
  additionalProperties: false,
};

export const VERDICTS = ["PASS", "PASS WITH WARNINGS", "BLOCK"] as const;
export interface Verdict { verdict: string; blocking: string[]; warnings: string[]; missing_information: string[] }

/** The parts of a proposal the review needs. */
export interface Reviewable { summary: string; why: string; changes: Change[]; confirm: string[] }

const compactSession = (s: Obj | undefined) => s && (s.battery ? { calibration: s.battery } : {
  intensity: s.intensity, rpe_cap: s.rpe_cap, note: s.coach_note,
  exercises: (s.exercises || []).map((e: Obj) => [e.name, `${e.sets ?? ""}×${typeof e.reps === "object" ? JSON.stringify(e.reps) : e.reps ?? ""}`,
    e.load_kg !== undefined ? `${e.load_kg} kg` : "", e.ex || ""].filter(Boolean).join(" · ")),
});

/** The 14 days in a form a model reads quickly: one line per exercise. */
export function compactSchedule(sched: Schedule | null) {
  if (!sched) return null;
  return {
    today: sched.today, phase: sched.phase,
    days: sched.days.map(d => ({ date: d.date, weekday: d.weekday, kind: d.kind, title: d.title, intensity: d.intensity,
      reasons: d.reasons?.length ? d.reasons : undefined, note: d.note || undefined, session: compactSession(d.session) })),
  };
}

/** For each slot in the plan, what it could pick for this person (the best fits, in turn), so the reviewer can judge
 *  the rotation, not only the named exercises. */
export function slotCandidates(state: AppState, lib: ExerciseLibrary): Record<string, string[]> {
  const hp = state.profile.health_profile;
  const who = lib.person(hp, state.profile.equipment, state.profile.goals);
  const out: Record<string, string[]> = {};
  for (const [key, r] of Object.entries(state.plan?.routines || {})) {
    (r.exercises || []).forEach((e: Record<string, any>, i: number) => {
      if (!e.slot) return;
      const picks = new Set<string>();
      for (let b = 0; b < 3; b++) {
        const x = lib.pick(e.slot, b, who.equipment, who.avoid, who.max_level, who.caution, who);
        if (x) picks.add(`${x.id} (L${x.level}; loads ${[...lib.stresses(x, who, who.equipment)].join(", ") || "nothing listed"})`);
      }
      out[`${r.title || key} #${i + 1} ${e.slot.pattern}`] = [...picks];
    });
  }
  return out;
}

/** Everything the reviewer reads, or the local checks' block when they already stop it. */
export function reviewDocument(state: AppState, p: Reviewable, lib: ExerciseLibrary, today: string):
  { blocked: Verdict } | { doc: Obj; warnings: string[] } {
  const { after, blocking, warnings } = checkChanges(state, p.changes, lib, today);
  if (blocking.length) return { blocked: { verdict: "BLOCK", blocking, warnings, missing_information: [] } };
  const rec = currentRecovery(state, today);
  const doc = {
    today,
    profile: state.profile.health_profile,
    equipment: state.profile.equipment,
    current_plan: state.plan,
    proposal: { summary: p.summary, why: p.why, changes: p.changes },
    plan_after_changes: after.plan,
    library_entries: Object.fromEntries([...JSON.stringify(after.plan || {}).matchAll(/"(?:ex|anywhere_ex)":"([a-z0-9_]+)"|"from":\[([^\]]*)\]/g)]
      .flatMap(m => (m[1] ? [m[1]] : (m[2] || "").replace(/"/g, "").split(","))).filter(id => lib.get(id))
      .map(id => [id, (({ id: _, cues: __, ...rest }) => rest)(lib.get(id)!)])),
    slot_candidates: slotCandidates(after, lib),
    next_14_days_after: (() => { try { return compactSchedule(schedule(after, lib, today, {})); } catch (e) { return `doesn't build: ${(e as Error).message}`; } })(),
    loosens_limits: p.confirm,
    conditions_guidance: Object.fromEntries((state.profile.health_profile.limits?.conditions || [])
      .map((c: string) => [c, lib.data.conditions[c]]).filter(([, v]: [string, unknown]) => v)),
    local_check_warnings: warnings,
    recovery: rec && { status: rec.status, flags: rec.flags },
    checkins_14d: state.checkins.filter(c => c.date >= addDays(today, -14)),
    calibration_results: state.assessments,
  };
  return { doc, warnings };
}

/** A verdict as the reviewer returned it, checked; null when it isn't one. */
export function readVerdict(v: unknown): Verdict | null {
  const x = v as Partial<Verdict> | null;
  if (!x || !VERDICTS.includes(x.verdict as typeof VERDICTS[number])) return null;
  const list = (a: unknown) => (Array.isArray(a) ? a.map(String) : []);
  return { verdict: x.verdict!, blocking: list(x.blocking), warnings: list(x.warnings), missing_information: list(x.missing_information) };
}
