// What the Coach may change, and the checks every change passes before the person sees an Apply button.
// The Coach never writes directly: it proposes a list of changes (the propose_changes tool), the local checks
// below run at once (anything blocking goes straight back to the Coach to fix), and a separate safety review runs
// before applying anything that changes exercises or intensity. Pure functions; tested under Node.

import { ExerciseLibrary } from "./engine/library.ts";
import { build } from "./engine/rolling.ts";
import type { Exercise, Obj, Person, PlanDoc, Routine } from "./engine/types.ts";
import { addDays } from "./engine/util.ts";
import { needsClearance } from "./engine/clearance.ts";
import type { AppState } from "./model.ts";
import { currentRecovery, workoutRows } from "./model.ts";

export type Change =
  | { type: "new_plan"; plan: PlanDoc }
  | { type: "set_rolling"; rolling: Obj }
  | { type: "set_routine"; key: string; routine: Routine }
  | { type: "remove_routine"; key: string }
  | { type: "set_override"; date: string; override: Obj }
  | { type: "clear_override"; date: string }
  | { type: "set_program"; program: string }
  | { type: "set_limits"; limits: Obj }
  | { type: "set_coaching"; coaching: Obj }
  | { type: "set_adaptations"; adaptations: Obj[] }
  | { type: "set_signals"; signals: Obj[] }
  | { type: "set_goals"; goals: Obj[] }
  | { type: "set_load_steps"; load_steps: Record<string, number[]> }
  | { type: "set_calibration"; calibration: Obj };

export const CHANGE_TYPES = ["new_plan", "set_rolling", "set_routine", "remove_routine", "set_override", "clear_override",
  "set_program", "set_limits", "set_coaching", "set_adaptations", "set_signals", "set_goals", "set_load_steps", "set_calibration"];

/** Only going back to the regular plan, or a rest day, skips the model's safety review: the program text is what the
 *  person reads (it must keep its stop rules) and goals change which exercises the plan picks. */
export function needsReview(changes: Change[]): boolean {
  return changes.some(c => {
    if (c.type === "clear_override") return false;
    if (c.type === "set_override") return (c.override.kind || "session") !== "rest";
    return true;
  });
}

export function describe(c: Change): string {
  switch (c.type) {
    case "new_plan": return `New plan "${c.plan.name}" with ${Object.keys(c.plan.routines || {}).length} routines`;
    case "set_rolling": return "Plan schedule: training days, rotation, phases and rules";
    case "set_routine": return `Routine "${c.routine.title || c.key}" (${(c.routine.exercises || []).length} exercises)`;
    case "remove_routine": return `Remove routine "${c.key}"`;
    case "set_override": return `${c.date}: ${c.override.title || c.override.kind || "session"}`;
    case "clear_override": return `${c.date}: back to the regular plan`;
    case "set_program": return "The plan's direction (program text)";
    case "set_limits": return "Your limits: what to avoid and what needs care";
    case "set_coaching": return "Coaching focus and emphasis";
    case "set_adaptations": return `Your way of doing exercises (${c.adaptations.length})`;
    case "set_signals": return `Your check-in signals (${c.signals.length})`;
    case "set_goals": return `Goals (${c.goals.length})`;
    case "set_load_steps": return "The weights your equipment allows";
    case "set_calibration": return "Your calibration tests";
  }
}

/** Structural check of what the model sent; returns the problems in words it can act on. */
export function shapeErrors(changes: unknown): string[] {
  if (!Array.isArray(changes) || !changes.length) return ["changes must be a non-empty list"];
  const errs: string[] = [];
  changes.forEach((c: any, i) => {
    const at = `changes[${i}]`;
    if (!c || !CHANGE_TYPES.includes(c.type)) { errs.push(`${at}: unknown type ${JSON.stringify(c?.type)}`); return; }
    const need = (k: string, kind: string) => {
      const v = c[k];
      const ok = kind === "array" ? Array.isArray(v) : kind === "date" ? typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)
        : kind === "object" ? v && typeof v === "object" && !Array.isArray(v) : typeof v === kind;
      if (!ok) errs.push(`${at} (${c.type}): "${k}" must be ${kind === "date" ? "a YYYY-MM-DD date" : `a${kind === "object" || kind === "array" ? "n" : ""} ${kind}`}`);
    };
    switch (c.type) {
      case "new_plan": need("plan", "object"); break;
      case "set_rolling": need("rolling", "object"); break;
      case "set_routine": need("key", "string"); need("routine", "object"); break;
      case "remove_routine": need("key", "string"); break;
      case "set_override": need("date", "date"); need("override", "object"); break;
      case "clear_override": need("date", "date"); break;
      case "set_program": need("program", "string"); break;
      case "set_limits": need("limits", "object"); break;
      case "set_coaching": need("coaching", "object"); break;
      case "set_adaptations": need("adaptations", "array"); break;
      case "set_signals": need("signals", "array"); break;
      case "set_goals": need("goals", "array"); break;
      case "set_load_steps": need("load_steps", "object"); break;
      case "set_calibration": need("calibration", "object"); break;
    }
  });
  return errs;
}

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

export function applyChanges(state: AppState, changes: Change[]): AppState {
  const s = clone(state);
  const hp = s.profile.health_profile;
  const plan = (): PlanDoc => (s.plan ||= { name: "plan", program: "", rolling: {}, routines: {}, overrides: {} });
  for (const c of changes) {
    switch (c.type) {
      case "new_plan": {
        const p = clone(c.plan);
        s.plan = { ...p, program: p.program || "", routines: p.routines || {}, overrides: p.overrides || {} };
        break;
      }
      case "set_rolling": plan().rolling = clone(c.rolling); break;
      case "set_routine": plan().routines[c.key] = clone(c.routine); break;
      case "remove_routine": delete plan().routines[c.key]; break;
      case "set_override": plan().overrides[c.date] = clone(c.override); break;
      case "clear_override": delete plan().overrides[c.date]; break;
      case "set_program": plan().program = c.program; break;
      case "set_limits": hp.limits = { ...(hp.limits || {}), ...clone(c.limits) }; break; // keys left out stay as they were
      case "set_coaching": hp.coaching = clone(c.coaching); break;
      case "set_adaptations": hp.adaptations = clone(c.adaptations); break;
      case "set_signals": hp.signals = clone(c.signals); break;
      case "set_goals": s.profile.goals = { ...s.profile.goals, goals: clone(c.goals) }; break;
      case "set_load_steps": s.profile.equipment = { ...s.profile.equipment, load_steps: clone(c.load_steps) }; break;
      case "set_calibration": s.calibration = clone(c.calibration); break;
    }
  }
  return s;
}

/** blocking: must change; hard: blocking that stays blocking even when it was already there before a proposal. */
export interface Findings { blocking: string[]; warnings: string[]; hard?: string[] }

const unconfirmed = (a: Obj) => /confirm/i.test(String(a.source || ""));

/** What an exercise loads for the safety checks: only the person's confirmed ways of doing it count, so an adaptation
 *  the Coach suggested can't take an avoided stress away until the person has said yes to it. */
function checkedStresses(lib: ExerciseLibrary, ex: Exercise, who: Person): Set<string> {
  return lib.stresses(ex, { ...who, adaptations: who.adaptations.filter(a => !unconfirmed(a)) }, who.equipment);
}

/** The rules a plan must meet whatever the model thinks: run on the state as it would be after the changes. */
export function checkPlan(after: AppState, lib: ExerciseLibrary, today: string): Findings {
  const blocking: string[] = [], warnings: string[] = [], hard: string[] = [];
  const block = (msg: string, isHard = false) => { blocking.push(msg); if (isHard) hard.push(msg); };
  const hp = after.profile.health_profile;
  const plan = after.plan;
  if (!plan) return { blocking, warnings, hard };
  const who = lib.person(hp, after.profile.equipment, after.profile.goals);
  const patterns = new Set(Object.keys(lib.data.patterns));
  const routines = { ...after.sharedRoutines, ...plan.routines };
  const rolling = plan.rolling || {};
  const conditions: string[] = hp.limits?.conditions || [];
  const byName = new Map(lib.data.exercises.map(e => [e.name.trim().toLowerCase(), e]));
  const avoided = (ex: Exercise) => [...checkedStresses(lib, ex, who)].filter(s => who.avoid.has(s));

  // A health-check answer or a condition that needs a doctor's go-ahead: no training plan until it's recorded.
  const clearance = needsClearance(hp);
  if (clearance.length && (rolling.rotation || []).length) {
    block(`No training plan until a doctor's go-ahead is recorded (because of ${clearance.join(", ")}). The person records it on the Today screen.`, true);
  }
  // Each condition's own guidance has to stay in the limits (as avoid, or at least caution).
  for (const c of conditions) {
    for (const s of lib.data.conditions[c]?.avoid || []) {
      if (!who.avoid.has(s) && !who.caution.has(s)) block(`limits: ${lib.data.conditions[c]?.label || c} needs "${s}" avoided (or at least handled with caution).`, true);
    }
  }
  for (const r of rolling.rotation || []) if (!routines[r]) blocking.push(`rolling.rotation names "${r}", which isn't a routine.`);
  if (!(rolling.rotation || []).length) blocking.push("rolling.rotation is empty.");
  if (rolling.recovery_routine && !routines[rolling.recovery_routine]) warnings.push(`recovery_routine "${rolling.recovery_routine}" isn't a routine.`);
  if (rolling.optional?.routine && !routines[rolling.optional.routine]) blocking.push(`optional.routine "${rolling.optional.routine}" isn't a routine.`);
  if (rolling.start && !/^\d{4}-\d{2}-\d{2}$/.test(rolling.start)) blocking.push(`rolling.start "${rolling.start}" isn't a date.`);
  const capLimit = conditions.includes("hypertension") || conditions.includes("heart") ? 8 : 9;
  for (const ph of rolling.phases || []) {
    if (!(ph.weeks > 0)) blocking.push(`Phase "${ph.name}" needs weeks > 0.`);
    if (ph.rpe_cap === undefined || ph.rpe_cap === null) block(`Phase "${ph.name}" needs an rpe_cap (without one the plan allows maximal efforts).`, true);
    else if (ph.rpe_cap > capLimit) block(`Phase "${ph.name}": RPE cap ${ph.rpe_cap} is above ${capLimit}${capLimit === 8 ? " (blood pressure or heart condition)" : ""}; no maximal efforts.`, true);
  }
  if ((rolling.phases || []).length > 2 && !(rolling.phases || []).some((p: Obj) => p.deload)) warnings.push("No deload phase.");
  const rules = rolling.rules || {};
  if (rules.pain_stop !== undefined && rules.pain_stop > 3) block(`rules.pain_stop ${rules.pain_stop}: pain above 3/10 must stop progress.`, true);
  if (rules.hard_rpe !== undefined && rules.hard_rpe > 9) block(`rules.hard_rpe ${rules.hard_rpe} is above 9.`, true);
  if (rules.progress_rpe !== undefined && rules.progress_rpe > 8) block(`rules.progress_rpe ${rules.progress_rpe}: loads may only go up after sets at RPE 8 or less.`, true);
  if (rules.regress_rpe !== undefined && rules.regress_rpe > 9.5) block(`rules.regress_rpe ${rules.regress_rpe} is above 9.5.`, true);

  /** A name that isn't a library id: checked against the library's names; unknown names can't be checked. */
  const norm = (t: string) => t.toLowerCase().replace(/[^a-z]+/g, " ").replace(/s\b/g, "").trim();
  // Longest name first, so "Wall push-up" matches Wall push-up rather than Push-up.
  const names = lib.data.exercises.map(e => [` ${norm(e.name)} `, e] as const).filter(([n]) => n.trim().length > 3)
    .sort((x, y) => y[0].length - x[0].length);
  const checkName = (name: string, at: string) => {
    const text = ` ${norm(String(name))} `;
    const ex = byName.get(String(name).trim().toLowerCase().replace(/\s*[×x]\s*\d.*$/, "")) || names.find(([n]) => text.includes(n))?.[1];
    if (ex) {
      const hit = avoided(ex);
      if (hit.length) block(`${at}: ${ex.name} loads ${hit.join(", ")}, which this person avoids.`, true);
    }
    return !!ex;
  };
  const checkEntry = (e: Obj, at: string) => {
    if (e.slot) {
      if (!patterns.has(e.slot.pattern)) blocking.push(`${at}: slot pattern "${e.slot.pattern}" isn't in the library.`);
      for (const id of e.slot.from || []) {
        const ex = lib.get(id);
        if (!ex) blocking.push(`${at}: slot option "${id}" isn't in the library.`);
        else if (ex.pattern !== e.slot.pattern) blocking.push(`${at}: "${id}" is a ${ex.pattern} exercise, not ${e.slot.pattern}.`);
        else {
          const hit = avoided(ex);
          if (hit.length) block(`${at}: slot option ${id} loads ${hit.join(", ")}, which this person avoids.`);
          if (ex.level > who.max_level + 1) warnings.push(`${at}: slot option ${id} is level ${ex.level}, above their level cap ${who.max_level}.`);
        }
      }
      return;
    }
    if (e.ex) {
      const ex = lib.get(e.ex);
      if (!ex) { blocking.push(`${at}: "${e.ex}" isn't in the library.`); return; }
      const hit = avoided(ex);
      // The engine swaps it before it reaches a session, so an old one doesn't hold up other changes; a new one blocks.
      if (hit.length) block(`${at}: ${ex.name} loads ${hit.join(", ")}, which this person avoids. Pick another exercise.`);
      if (!lib.hasEquipment(ex, who.equipment)) warnings.push(`${at}: ${ex.name} needs equipment this person hasn't listed.`);
      if (ex.implement && e.load_kg === undefined) warnings.push(`${at}: ${ex.name} has no starting load_kg.`);
      if (ex.level > who.max_level) warnings.push(`${at}: ${ex.name} is level ${ex.level}, above their level cap ${who.max_level}.`);
    } else if (!e.name) {
      blocking.push(`${at}: an exercise needs "ex" (a library id), "slot", or at least a name.`);
    } else if (!checkName(e.name, at)) {
      warnings.push(`${at}: "${e.name}" isn't a library exercise, so it can't be checked against the limits; use a library id.`);
    }
    if (e.anywhere_ex && e.anywhere_ex !== "skip") {
      const alt = lib.get(e.anywhere_ex);
      if (!alt) blocking.push(`${at}: anywhere_ex "${e.anywhere_ex}" isn't in the library.`);
      else {
        const hit = avoided(alt);
        if (hit.length) block(`${at}: anywhere_ex ${alt.name} loads ${hit.join(", ")}.`);
      }
    }
  };
  // Blood pressure: no low-rep sets under strain (coach/knowledge/medical.md: 8–15 reps, no singles or grinding reps).
  const bpCare = conditions.includes("hypertension") || conditions.includes("heart");
  const lowRepStrain = (e: Obj, at: string) => {
    const ex = lib.get(e.ex);
    const first = Number(String(typeof e.reps === "object" ? e.reps?.reps ?? "" : e.reps ?? "").match(/\d+/)?.[0]);
    if (bpCare && ex && !avoided(ex).length && checkedStresses(lib, ex, who).has("high_pressure") && first > 0 && first < 6 && (ex.unit || "reps") === "reps") {
      block(`${at}: ${ex.name} for ${e.reps} reps: with high blood pressure or a heart condition, sets under strain stay at 6 reps or more.`, true);
    }
  };
  if (plan.program && !/stop and get help/i.test(plan.program)) warnings.push("The program text has no \"Stop and get help\" section any more.");
  for (const [key, r] of Object.entries(plan.routines || {})) {
    (r.exercises || []).forEach((e: Obj, i: number) => { checkEntry(e, `${r.title || key} #${i + 1}`); lowRepStrain(e, `${r.title || key} #${i + 1}`); });
    for (const w of r.warmup || []) checkName(w, `${r.title || key} warm-up`);
  }
  for (const [date, o] of Object.entries(plan.overrides || {})) {
    if (date < addDays(today, -1)) continue;
    (o.exercises || []).forEach((e: Obj, i: number) => { checkEntry(e, `${date} #${i + 1}`); lowRepStrain(e, `${date} #${i + 1}`); });
    for (const w of o.warmup || []) checkName(w, `${date} warm-up`);
    if (o.rpe_cap !== undefined && o.rpe_cap > capLimit) block(`${date}: RPE cap ${o.rpe_cap} is above ${capLimit}.`, true);
  }

  // Lay out the next two weeks: it must build, and nothing the person avoids may reach a session.
  if ((rolling.rotation || []).length && !blocking.length) {
    try {
      const sched = build({
        today, lib, healthProfile: hp, equipment: after.profile.equipment, goals: after.profile.goals, plan,
        sharedRoutines: after.sharedRoutines, workouts: workoutRows(after), checkins: after.checkins,
        recovery: currentRecovery(after, today), pictures: {},
      });
      for (const d of sched.days) {
        const s = d.session;
        if (!s || s.battery) continue;
        for (const v of [s, s.easy, s.anywhere, s.easy?.anywhere].filter(Boolean)) {
          for (const e of v.exercises || []) {
            const ex = lib.get(e.ex);
            const hit = ex ? avoided(ex) : (e.tags || []).filter((t: string) => who.avoid.has(t));
            if (hit.length) block(`${d.date}: ${e.name} would load ${hit.join(", ")}.`, true);
          }
        }
      }
    } catch (err) {
      blocking.push(`The plan doesn't build: ${(err as Error).message}`);
    }
  }
  return { blocking: [...new Set(blocking)], warnings: [...new Set(warnings)], hard: [...new Set(hard)] };
}

/** What a proposal loosens, which the person has to confirm themselves on the card (with their doctor or physio
 *  where it's medical): limits taken away, a higher level cap, a way of doing an exercise that takes an avoided
 *  stress away, a check-in signal's levels or stop rule removed. */
export function confirmations(state: AppState, changes: Change[], lib: ExerciseLibrary): string[] {
  const out: string[] = [];
  const hp = state.profile.health_profile;
  const lim = hp.limits || {};
  const cap = Number(lim.max_level ?? lib.person(hp, state.profile.equipment, state.profile.goals).max_level);
  for (const c of changes) {
    if (c.type === "set_limits") {
      const names: Record<string, string> = { avoid: "never-do list", caution: "handle-with-care list", conditions: "conditions" };
      for (const k of ["avoid", "caution", "conditions"]) {
        if (!(k in c.limits)) continue;
        const gone = (lim[k] || []).filter((x: string) => !(c.limits[k] || []).includes(x));
        if (gone.length) out.push(`Removes from your ${names[k]}: ${gone.join(", ")}.`);
      }
      if (c.limits.max_level !== undefined && Number(c.limits.max_level) > cap) out.push(`Raises your level cap from ${cap} to ${c.limits.max_level}.`);
    }
    if (c.type === "set_adaptations") {
      const avoid = new Set<string>(lim.avoid || []);
      for (const a of c.adaptations) {
        const freed = (a.removes || []).filter((x: string) => avoid.has(x));
        const known = (hp.adaptations || []).some((b: Obj) => JSON.stringify(b) === JSON.stringify(a));
        if (freed.length && !known) out.push(`"${a.how}" takes away ${freed.join(", ")}, which you otherwise never do.`);
      }
    }
    if (c.type === "set_signals") {
      for (const old of hp.signals || []) {
        const now = c.signals.find((x: Obj) => x.key === old.key);
        if (!now) { out.push(`Removes your "${old.label}" check-in signal.`); continue; }
        const lost = Object.keys(old.levels || {}).filter(l => !(now.levels || {})[l]);
        if (lost.length) out.push(`Removes level ${lost.join(", ")} of "${old.label}".`);
        if (old.stop && !now.stop) out.push(`Removes the stop rule of "${old.label}".`);
      }
    }
  }
  return out;
}

/** Check a proposal. What it would newly break blocks; what was already wrong before is a warning, so an unrelated
 *  change isn't held up, except for the hard rules (avoided stresses, clearance, condition guidance, effort caps),
 *  which block until they're fixed. */
export function checkChanges(state: AppState, changes: Change[], lib: ExerciseLibrary, today: string): Findings & { after: AppState; confirm: string[] } {
  const after = applyChanges(state, changes);
  const before = state.plan ? checkPlan(state, lib, today) : { blocking: [] as string[], warnings: [] as string[], hard: [] as string[] };
  const now = checkPlan(after, lib, today);
  const old = new Set(before.blocking), hard = new Set(now.hard || []);
  const warnings = [...now.blocking.filter(b => old.has(b) && !hard.has(b)).map(b => `Already in the plan: ${b}`), ...now.warnings];
  for (const c of changes) {
    if (c.type === "set_adaptations" && c.adaptations.some(a => unconfirmed(a) && (a.removes || []).length)) {
      warnings.push("Adaptations marked \"(confirm)\" don't take any stress away in the safety checks until the person confirms them.");
    }
  }
  return { after, confirm: confirmations(state, changes, lib), blocking: now.blocking.filter(b => !old.has(b) || hard.has(b)), warnings };
}
