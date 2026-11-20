// Rolling 14-day plan: the next two weeks, rebuilt from what actually happened.
// A line-for-line port of coach/rolling.py (read its docstring for the rules). Everything it reads from the
// data folder is passed in as one object, so the phone and the tests run the same code; tests/parity checks
// that both versions lay out the same days.

import { needsClearance } from "./clearance.ts";
import { ExerciseLibrary } from "./library.ts";
import { levelActions, personal } from "./signals.ts";
import type { CheckinRow, Entry, Exercise, Obj, Person, PlanDoc, Recovery, Routine, Slot, WorkoutRow } from "./types.ts";
import { DAYS, addDays, daysBetween, deepEqual, floorDiv, g, num, nums, pyRound, repRange, sortedStrings, step, weekday } from "./util.ts";

export const HORIZON = 14;
// The desktop says "Plan finished: run /coach review"; on the phone the review happens in the Coach tab.
export const REVIEW_TITLE = "Plan finished: time for a review";
export const GATE_TITLE = "First, a doctor's go-ahead";
export const RULES = {
  hard_rpe: 9, easy_rpe: 7, pain_stop: 3,
  easy_day: { sets_minus: 1, load_steps_down: 1, rpe_cap: 7 },
  deload: { sets_pct: 60 },
  progress_rpe: 8, regress_rpe: 9.5,
};
type Rules = typeof RULES & Obj;
const UNIT_REPS: Record<string, string> = { reps: "8–12", s: "20–40", m: "20–30", min: "10–20" };

export interface BuildInput {
  today: string;
  lib: ExerciseLibrary;
  healthProfile: Obj;
  equipment: Obj;
  goals: Obj;
  plan: PlanDoc;
  sharedRoutines?: Record<string, Routine>;  // plans/routines on the desktop (plan routines win)
  workouts: WorkoutRow[];
  checkins: CheckinRow[];
  recovery: Recovery | null;
  pictures?: Record<string, { name?: string }>; // the picture catalogue, for old-style "lib" entries
  generated?: string;
}

interface Logged { routine: string | null; title: string; rows: WorkoutRow[] }
type History = Record<string, Logged[]>;

export class Plan {
  readonly doc: PlanDoc;
  readonly cfg: Obj;
  readonly rules: Rules;
  readonly routines: Record<string, Routine>;
  readonly rotation: string[];
  readonly weekdays: string[];
  readonly start: string | null;

  constructor(doc: PlanDoc, shared: Record<string, Routine> = {}) {
    this.doc = doc;
    this.cfg = doc.rolling || {};
    this.rules = { ...RULES, ...(this.cfg.rules || {}) } as Rules;
    this.routines = {};
    for (const src of [doc.routines || {}, shared]) {
      for (const k of sortedStrings(Object.keys(src))) if (!(k in this.routines)) this.routines[k] = src[k];
    }
    this.rotation = (this.cfg.rotation || []).filter((r: string) => r in this.routines);
    this.weekdays = (this.cfg.weekdays || ["mon", "wed", "fri"]).map((d: string) => d.slice(0, 3).toLowerCase());
    this.start = this.cfg.start || null;
  }

  phase(day: string): Obj {
    if (!this.start || day < this.start) return { name: "Before start", weeks: 0 };
    let week = floorDiv(daysBetween(this.start, day), 7);
    const phases: Obj[] = this.cfg.phases || [];
    for (let i = 0; i < phases.length; i++) {
      const w = phases[i].weeks || 0;
      if (week < w) return { ...phases[i], week: week + 1, index: i };
      week -= w;
    }
    return { name: "Plan finished: time for a review", done: true };
  }

  byTitle(title: string): string | null {
    const t = (title || "").trim().toLowerCase();
    return Object.keys(this.routines).find(k => (this.routines[k].title || "").trim().toLowerCase() === t) ?? null;
  }
}

/** Logged sessions: {date: [{routine, title, rows}]} from the workout log. */
export function history(plan: Plan, workouts: WorkoutRow[]): History {
  const out: Record<string, Map<string, Logged>> = {};
  for (const r of workouts) {
    const day = (out[r.date] ||= new Map());
    let s = day.get(r.session);
    if (!s) { s = { routine: plan.byTitle(r.session), title: r.session, rows: [] }; day.set(r.session, s); }
    s.rows.push(r);
  }
  return Object.fromEntries(Object.entries(out).map(([d, m]) => [d, [...m.values()]]));
}

function sessionStrain(rows: WorkoutRow[], rules: Rules): "hard" | "easy" | "normal" {
  const rpes = rows.map(r => num(r.rpe)).filter((x): x is number => x !== null);
  const pains = rows.map(r => num(r.pain)).filter((x): x is number => x !== null);
  if ((rpes.length && Math.max(...rpes) >= rules.hard_rpe) || (pains.length && Math.max(...pains) >= rules.pain_stop)) return "hard";
  if (rpes.length && Math.max(...rpes) <= rules.easy_rpe && !(pains.length && Math.max(...pains) > 0)) return "easy";
  return "normal";
}

export interface TodayState {
  day: string | null; reasons: string[]; avoid_tags: Set<string>; add_routines: string[]; rpe_cap: number | null;
  back_from: string | null; // back from Oura Rest Mode: the first BACK_SESSIONS sessions from this day are easy
}

// Returning after illness (coach/knowledge/recovery.md): after Oura Rest Mode, the first sessions are easy at RPE <= 6.
export const BACK_SESSIONS = 2, BACK_RPE = 6;

/** What today's recovery data and check-in say: {day: null | "easy" | "recovery" | "rest", ...}. */
export function todayState(today: string, healthProfile: Obj, checkins: CheckinRow[], rec: Recovery | null): TodayState {
  const st: TodayState = { day: null, reasons: [], avoid_tags: new Set(), add_routines: [], rpe_cap: null, back_from: null };
  const order: Record<string, number> = { easy: 1, recovery: 2, rest: 3 };
  const apply = (day: string | null | undefined, reason: string) => {
    if ((order[day || ""] || 0) > (order[st.day || ""] || 0)) st.day = day!;
    st.reasons.push(reason);
  };
  const fresh = rec?.latest_date && daysBetween(rec.latest_date, today) <= 1;
  const rm = rec?.rest_mode || null;
  st.back_from = fresh && rm?.on ? today : rm?.ended || null;
  if (rec && fresh) {
    if (rm?.on) apply("rest", `Oura rest mode is on (since ${rm.since})`);
    else if ((rec.temperature_deviation || 0) >= 0.5) apply("rest", `body temperature +${rec.temperature_deviation} °C`);
    else if (rec.status === "red") apply("recovery", "recovery is red");
    else if (rec.status === "amber") apply("easy", "recovery is amber");
  }
  const yesterday = addDays(today, -1);
  const ci = [...checkins].reverse().find(r => r.date === today || r.date === yesterday);
  if (ci) {
    const pain = num(ci.pain);
    if (pain !== null && pain >= 6) apply("recovery", `pain ${g(pain)}/10 in the check-in`);
    else if (pain !== null && pain >= 4) apply("easy", `pain ${g(pain)}/10 in the check-in`);
    const energy = num(ci.energy);
    if (energy !== null && energy <= 1) apply("easy", "energy 1/5");
    for (const sig of personal(healthProfile)) {
      const act = levelActions(sig, ci[sig.key]);
      if (!act) continue;
      apply(act.day, act.note || `${sig.label} ${ci[sig.key] ?? ""}`);
      for (const t of act.avoid_tags || []) st.avoid_tags.add(t);
      if (act.add_routine) st.add_routines.push(act.add_routine);
      if (act.rpe_cap) st.rpe_cap = Math.min(st.rpe_cap || 10, act.rpe_cap);
    }
  }
  return st;
}

function lastPerformance(name: string, hist: History, before: string): WorkoutRow | null {
  for (const d of sortedStrings(Object.keys(hist)).reverse()) {
    if (d >= before) continue;
    for (const s of hist[d]) {
      for (const r of s.rows) if (r.exercise.trim().toLowerCase() === name.trim().toLowerCase()) return r;
    }
  }
  return null;
}

const addNote = (e: Entry, text: string) => { e.note = (e.note ? e.note + " " : "") + text; };

/** Fill an exercise entry from a library exercise, or replace it (keeping sets, rest and the plan's intent).
 *  The person's own way of doing it (an adaptation) leads the cues. */
export function useExercise(lib: ExerciseLibrary, e: Entry, ex: Exercise, swapped = false, who?: Partial<Person> | null,
                            equipment?: Set<string>): Entry {
  e.ex = ex.id;
  if (swapped || !e.name) e.name = ex.name;
  if (swapped || !e.lib) {
    delete e.lib;
    if (ex.picture) e.lib = ex.picture;
  }
  if (swapped || !e.cues?.length) {
    delete e.cues;
    if (ex.cues?.length) e.cues = [...ex.cues];
  }
  if (swapped) {
    for (const k of ["load_kg", "implement", "note", "instructions"]) delete e[k];
    if ((ex.unit || "reps") !== (e.unit || "reps")) e.reps = UNIT_REPS[ex.unit || "reps"] ?? e.reps;
    e.tags = sortedStrings(lib.stresses(ex, who, equipment));
  } else {
    e.tags = sortedStrings(new Set([...(e.tags || []), ...lib.stresses(ex, who, equipment)]));
  }
  const ways = lib.adaptationsFor(ex, who, equipment);
  for (const a of ways) {
    const cue = "Your way: " + a.how;
    if (a.how && !(e.cues || []).includes(cue)) e.cues = [cue, ...(e.cues || [])];
  }
  if (ways.length || ex.picture_only) e.instructions = false; // the picture source's step-by-step describes another way of doing it
  if (ex.implement && !e.implement) e.implement = ex.implement;
  if ((ex.unit || "reps") !== "reps") e.unit = ex.unit;
  else delete e.unit;
  return e;
}

function slotBlock(plan: Plan, slot: Slot, day: string): number {
  const every = slot.every_weeks ?? 3;
  if (every === "phase") return plan.phase(day).index ?? 0;
  const weeks = plan.start ? Math.max(0, floorDiv(daysBetween(plan.start, day), 7)) : 0;
  return floorDiv(weeks, Math.max(1, Math.trunc(Number(every))));
}

/** Where this person is on a bodyweight ladder: the family member logged last, moved one rung up or down by how
 *  that session went. */
function ladderNow(lib: ExerciseLibrary, ex: Exercise, e: Entry, hist: History, day: string, rules: Rules, cap: number,
                   who: Person): [Exercise, string] {
  const names = new Map(lib.ladder(ex.id).map(m => [m.name.trim().toLowerCase(), m]));
  names.set(String(e.name || "").trim().toLowerCase(), ex);
  let cur = ex, last: WorkoutRow | null = null;
  outer:
  for (const d of sortedStrings(Object.keys(hist)).reverse()) {
    if (d >= day) continue;
    for (const sess of hist[d]) {
      for (const row of sess.rows) {
        const m = names.get(row.exercise.trim().toLowerCase());
        if (m) { cur = m; last = row; break outer; }
      }
    }
  }
  if (!last) return [cur, ""];
  const reps = nums(last.reps), rpe = num(last.rpe), pain = num(last.pain);
  const rng = repRange(e.reps);
  let move = 0;
  if ((pain !== null && pain >= rules.pain_stop) || (rpe !== null && rpe >= rules.regress_rpe)) move = -1;
  else if (rng && reps.length && reps.length >= Math.max(1, Math.trunc(num(e.sets) || 1)) && Math.min(...reps) >= rng[1]
           && rpe !== null && rpe <= Math.min(rules.progress_rpe, cap)) move = +1; // no RPE logged: hold
  if (move) {
    // earned by performance, so one rung above the level cap (or above what the plan named) is fine, never more;
    // and never onto a rung that adds impact, jumping, high pressure or going upside down (library RISKY)
    const ceiling = Math.max(who.max_level, ex.level) + 1;
    const nxt = lib.stepRung(cur.id, move, who.equipment, who.avoid, Math.min(Math.max(who.max_level, cur.level + 1), ceiling), who.caution, who);
    if (nxt) return [nxt, move > 0 ? "a rung harder: top of the range last time" : "a rung easier: last time was too hard"];
  }
  return [cur, ""];
}

export interface Session {
  id: string; routine: string; title: string; date: string; intensity: string; rpe_cap: number;
  focus: string; duration: string; coach_note: string; warmup: string[]; exercises: Entry[];
  easy?: Obj; anywhere?: Obj; [k: string]: any;
}

interface Ctx { plan: Plan; lib: ExerciseLibrary; hist: History; steps: Record<string, number[]>; who: Person; pictures: Record<string, { name?: string }> }

/** One dated session from a routine: loads progressed from the log, adjusted for intensity.
 *  anywhere=true rebuilds it from household items only (the "No equipment" version). */
export function planSession(ctx: Ctx, key: string, day: string, intensity: string, extra: Partial<TodayState>, anywhere = false): Session {
  const { plan, lib, hist, steps, who } = ctx;
  const r = plan.routines[key];
  const rules = plan.rules, ph = plan.phase(day);
  const equipment = anywhere ? who.household : who.equipment;
  const avoid = new Set([...who.avoid, ...(extra.avoid_tags || [])]);
  const cap = Math.min(...[ph.rpe_cap, extra.rpe_cap, intensity === "easy" ? rules.easy_day.rpe_cap : null, 10].filter(x => x) as number[]);
  const exercises: Entry[] = [], notes: string[] = [];
  for (const src of r.exercises || []) {
    const e: Entry = { ...src };
    let ex: Exercise | null = null;
    let ownAvoid: string[] = []; // a slot's own limits also hold for whatever stands in for its pick
    if (e.slot) {
      const slot: Slot = e.slot;
      ownAvoid = slot.avoid || [];
      delete e.slot;
      // picked against standing limits only, so a bad day swaps the pick rather than reshuffling the rotation
      ex = lib.pick(slot, slotBlock(plan, slot, day), equipment, who.avoid, who.max_level, who.caution, who);
      if (!ex) { notes.push(`Nothing for the ${slot.pattern || ""} slot fits today.`); continue; }
      useExercise(lib, e, ex, false, who, equipment);
      const unit = ex.unit || "reps";
      if (e.reps && typeof e.reps === "object") e.reps = e.reps[unit] || UNIT_REPS[unit];
      else if (unit !== "reps") e.reps = UNIT_REPS[unit] ?? e.reps;
    } else if (e.ex) {
      ex = lib.get(e.ex) || null;
      if (ex) useExercise(lib, e, ex, false, who, equipment);
    }
    let name: string = e.name || ctx.pictures[e.lib || ""]?.name || e.lib || "";
    e.name = name;
    let why = "", rung = "";
    // Bodyweight ladders: move along the family from what the log shows.
    if (ex && !e.implement && (e.ladder ?? true) && (e.unit ?? "reps") === "reps") {
      let cur: Exercise;
      [cur, rung] = ladderNow(lib, ex, e, hist, day, rules, cap, who);
      if (cur.id !== ex.id) { ex = cur; useExercise(lib, e, ex, true, who, equipment); }
      if (intensity === "easy") {
        const easier = lib.stepRung(ex.id, -1, equipment, avoid, who.max_level, who.caution, who);
        if (easier) { ex = easier; rung = "a rung easier today"; useExercise(lib, e, ex, true, who, equipment); }
      }
      name = e.name;
    }
    const standInId = e.anywhere_ex || "", anywhereNote = e.anywhere_note || "";
    delete e.anywhere_ex; delete e.anywhere_note;
    if (anywhere && standInId === "skip") { notes.push(`Without equipment: ${name} is left out.`); continue; }
    if (anywhere && anywhereNote) addNote(e, anywhereNote);
    const standIn = lib.get(standInId);
    if (anywhere && standIn && standIn.id !== ex?.id) {
      notes.push(`Without equipment: ${name} → ${standIn.name}.`);
      ex = standIn;
      useExercise(lib, e, ex, true, who, equipment);
      name = e.name;
    }
    // Ruled out today (a signal's avoid_tags, the person's limits) or impossible without equipment: swap, don't drop.
    const blocked = (e.tags || []).filter((t: string) => avoid.has(t) || ownAvoid.includes(t));
    const mine = blocked.length > 0 && blocked.every((t: string) => who.avoid.has(t)); // the person's standing limits
    const missing = anywhere && ((ex && !lib.hasEquipment(ex, equipment)) || (!ex && e.implement));
    if (blocked.length || missing) {
      const alt = ex ? lib.substitute(ex.id, equipment, [...avoid, ...ownAvoid], who.max_level, who.caution, null, who) : null;
      if (alt && ex) {
        notes.push(`${mine ? "Swapped for your limits" : blocked.length ? "Swapped today" : "Without equipment"}: ${name} → ${alt.name}.`);
        const sameTool = alt.family === ex.family && alt.implement && alt.implement === e.implement;
        const kept = sameTool ? e.load_kg : undefined; // same family, same tool: the weight carries over
        ex = alt;
        useExercise(lib, e, ex, true, who, equipment);
        if (kept !== undefined && kept !== null) e.load_kg = kept;
        name = e.name;
      } else {
        notes.push(`Left out today: ${name}.`);
        continue;
      }
    }
    if (anywhere && ex) {
      // Kept because a household item can stand in (a backpack for the dumbbells, a chair for the bench): say which,
      // and drop a weight that belonged to the real implement.
      for (const group of ex.equipment || []) {
        if (Array.isArray(group) && group.length && !equipment.has(group[0])) {
          const use = group.find(x => equipment.has(x));
          if (use) addNote(e, `Use a ${use} for the ${group[0]}.`);
        }
      }
      if (e.implement && !equipment.has(e.implement)) { delete e.implement; delete e.load_kg; }
    }
    let load = num(e.load_kg);
    const st = steps[e.implement || ""] || [];
    const rng = e.unit !== "s" ? repRange(e.reps) : null;
    const last = lastPerformance(name, hist, day);
    if (last && load === null && e.implement && nums(last.load_kg).length) {
      load = Math.max(...nums(last.load_kg)); // a swapped-in or rotated exercise picks up where it was last time
    }
    if (last && load !== null) {
      const done = nums(last.load_kg);
      load = done.length ? Math.max(...done) : load;
      const reps = nums(last.reps), rpe = num(last.rpe), pain = num(last.pain);
      const want = Math.trunc(num(e.sets) || 0);
      const topped = rng && reps.length && reps.length >= Math.max(1, want) && Math.min(...reps) >= rng[1];
      if (pain !== null && pain >= rules.pain_stop) { load = step(load, st, -1); why = `down a step: pain ${g(pain)} last time`; }
      else if (rpe !== null && rpe >= rules.regress_rpe) why = `same load: RPE ${g(rpe)} last time`;
      else if (topped && rpe === null) why = "same load: log the RPE so the plan can move it up";
      else if (topped && rpe !== null && rpe <= Math.min(rules.progress_rpe, cap)) { load = step(load, st, +1); why = "up a step: top of the range last time"; }
      else if (rng && reps.length && Math.min(...reps) < rng[0]) why = "same load: reps below the range last time";
    }
    if (intensity === "easy") {
      e.sets = Math.max(1, Math.trunc(num(e.sets) || 1) - rules.easy_day.sets_minus);
      if (load !== null && st.length) load = step(load, st, -rules.easy_day.load_steps_down);
    }
    if (intensity === "deload") e.sets = Math.max(1, pyRound((num(e.sets) || 1) * rules.deload.sets_pct / 100));
    if (ph.sets_max && num(e.sets)) e.sets = Math.min(Math.trunc(num(e.sets)!), Math.trunc(ph.sets_max));
    if (load !== null) e.load_kg = Number.isInteger(load) ? load : pyRound(load, 1);
    else if (e.implement) why = why || "not set yet: pick one that leaves 2–3 reps (or a few metres) in reserve, and log it";
    if (why) addNote(e, `Load ${why}.`);
    if (rung) addNote(e, `${rung[0].toUpperCase()}${rung.slice(1)}.`);
    exercises.push(e);
  }
  const warmup = [...(r.warmup || [])];
  for (const add of extra.add_routines || []) {
    if (add in plan.routines) warmup.unshift(`First: your ${plan.routines[add].title} routine`);
  }
  let note = r.coach_note || "";
  const lead = ({ easy: `Easier today (RPE ≤ ${g(cap)}, one set fewer, lighter).`, deload: "Deload week: fewer sets, same technique." } as Obj)[intensity];
  if (lead) note = lead + (note ? " " + note : "");
  if (notes.length) note = notes.join(" ") + (note ? " " + note : "");
  if (anywhere) note = "No-equipment version. " + note;
  return {
    id: `day-${day}`, routine: key, title: r.title, date: day, intensity, rpe_cap: cap, focus: r.focus || "",
    duration: r.duration || "", coach_note: note, warmup, exercises,
  };
}

export interface DayEntry {
  date: string; weekday: string; phase?: string; reasons: string[]; kind?: string; title?: string; note?: string;
  intensity?: string; session?: Session;
}
export interface Schedule {
  generated: string; plan: string; today: { date: string; adjust: string | null; reasons: string[] }; phase: Obj; days: DayEntry[];
}

export function loadSteps(equipment: Obj): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const [k, v] of Object.entries(equipment?.load_steps || {})) {
    if (Array.isArray(v)) out[k] = v.map(Number).sort((a, b) => a - b);
  }
  return out;
}

function context(input: BuildInput, plan: Plan): Ctx {
  return { plan, lib: input.lib, hist: history(plan, input.workouts), steps: loadSteps(input.equipment),
    who: input.lib.person(input.healthProfile, input.equipment, input.goals), pictures: input.pictures || {} };
}

/** A session plus its easier and no-equipment versions, for the phone to switch between. */
function variantsFor(ctx: Ctx, key: string, day: string, intensity: string, extra: Partial<TodayState>): Session {
  const sess = planSession(ctx, key, day, intensity, extra);
  const keep = (s: Session) => ({ rpe_cap: s.rpe_cap, coach_note: s.coach_note, exercises: s.exercises });
  if (intensity === "normal") { // the phone switches to this if the morning check-in says so
    const easy = planSession(ctx, key, day, "easy", extra);
    sess.easy = keep(easy);
    const easyAny = planSession(ctx, key, day, "easy", extra, true);
    if (!deepEqual(easyAny.exercises, easy.exercises)) sess.easy.anywhere = keep(easyAny);
  }
  const anyw = planSession(ctx, key, day, intensity, extra, true);
  if (!deepEqual(anyw.exercises, sess.exercises)) sess.anywhere = keep(anyw);
  return sess;
}

/** A routine opened by hand (the recovery routine, an extra session): today's version of it, with its variants. */
export function routineSession(input: BuildInput, key: string): Session | null {
  const plan = new Plan(input.plan, input.sharedRoutines);
  if (!plan.routines[key]) return null;
  const s = variantsFor(context(input, plan), key, input.today, "normal", {});
  return { ...s, id: `routine-${key}` };
}

export function build(input: BuildInput): Schedule {
  const { today } = input;
  const plan = new Plan(input.plan, input.sharedRoutines);
  if (!plan.rotation.length) throw new Error("The plan's rotation names no routine.");
  const ctx = context(input, plan);
  const rules = plan.rules, hist = ctx.hist;
  const variants = (key: string, day: string, intensity: string, extra: Partial<TodayState>) => variantsFor(ctx, key, day, intensity, extra);

  // Where the rotation stands, and the last main session (logged).
  const mainDates = sortedStrings(Object.keys(hist).filter(d => hist[d].some(s => s.routine !== null && plan.rotation.includes(s.routine)) && d <= today));
  let nxt = 0;
  if (mainDates.length) {
    const ls = hist[mainDates[mainDates.length - 1]].filter(s => s.routine !== null && plan.rotation.includes(s.routine));
    nxt = (plan.rotation.indexOf(ls[ls.length - 1].routine!) + 1) % plan.rotation.length;
  }
  let lastMain: string | null = mainDates.length ? mainDates[mainDates.length - 1] : null;

  const recent = mainDates.filter(d => d >= addDays(today, -7)).map(d => [d, sessionStrain(hist[d].flatMap(s => s.rows), rules)] as const);
  const hard = recent.filter(([, k]) => k === "hard").map(([d]) => d);
  let carryEasy = (recent.length > 0 && recent[recent.length - 1][1] === "hard") || hard.length >= 2;
  const extraRest = hard.filter(d => d >= addDays(today, -4)).length >= 2;
  let easyStreak = recent.length >= 2 && recent.slice(-2).every(([, k]) => k === "easy");

  const now = todayState(today, input.healthProfile, input.checkins, input.recovery);
  const back = now.back_from;
  let backLeft = back ? Math.max(0, BACK_SESSIONS - mainDates.filter(d => d >= back).length) : 0;
  const gate = needsClearance(input.healthProfile);
  const gap = Math.trunc(Number(plan.cfg.min_rest_days ?? 1));
  const opt: Obj = plan.cfg.optional || {};
  const days: DayEntry[] = [];
  let owed = false;
  for (const k of [1, 2]) { // a training day in the last two days that wasn't done is still owed
    const d = addDays(today, -k);
    if (plan.weekdays.includes(DAYS[weekday(d)]) && (!plan.start || d >= plan.start) && (lastMain === null || lastMain < d)) owed = true;
  }
  for (let i = 0; i < HORIZON; i++) {
    const day = addDays(today, i);
    const wd = DAYS[weekday(day)];
    const ph = plan.phase(day);
    const entry: DayEntry = { date: day, weekday: wd, phase: ph.name, reasons: [] };
    const logged = i === 0 ? hist[day] : undefined;
    if (logged) {
      Object.assign(entry, { kind: "done", title: logged.map(s => s.title).join(" + ") });
      days.push(entry);
      if (logged.some(s => s.routine !== null && plan.rotation.includes(s.routine))) lastMain = day;
      continue;
    }
    if (gate.length) {
      Object.assign(entry, { kind: "rest", title: GATE_TITLE, note: `Because of ${gate.join(", ")}: talk to your doctor before training. `
        + "No sessions until the go-ahead is recorded." });
      days.push(entry);
      continue;
    }
    if (ph.done) {
      Object.assign(entry, { kind: "review", title: REVIEW_TITLE });
      days.push(entry);
      continue;
    }
    const override = input.plan.overrides?.[day];
    if (override) { // the Coach fixed this day by hand: use it as written
      const kind = override.kind || "session";
      Object.assign(entry, { kind, title: override.title || "", note: override.note || "", reasons: ["set by the Coach"],
        intensity: override.intensity || "normal" });
      if (kind === "session" || kind === "optional") entry.session = { ...override, id: `day-${day}`, date: day, intensity: entry.intensity } as Session;
      if (plan.rotation.includes(override.routine)) {
        nxt = (plan.rotation.indexOf(override.routine) + 1) % plan.rotation.length; lastMain = day; owed = false;
        backLeft = Math.max(0, backLeft - 1); // the Coach's own return session counts as one
      }
      days.push(entry);
      continue;
    }
    const restNeeded = gap + (extraRest && i <= 2 ? 1 : 0);
    const free = lastMain === null || daysBetween(lastMain, day) > restNeeded;
    const want = plan.weekdays.includes(wd) || owed;
    const blocked = i === 0 && (now.day === "recovery" || now.day === "rest");
    if (free && want && !blocked && (!plan.start || day >= plan.start)) {
      const key = plan.rotation[nxt];
      let intensity = ph.deload ? "deload" : "normal";
      if (i === 0 && now.day === "easy") {
        intensity = "easy"; entry.reasons = now.reasons;
        carryEasy = false; // one easy session also absorbs a hard last session
      } else if (carryEasy && intensity === "normal") {
        intensity = "easy";
        entry.reasons.push(hard.length >= 2 ? "the last sessions were hard" : "last session was hard");
        carryEasy = false;
      } else if (easyStreak && intensity === "normal") {
        entry.reasons.push("the last two sessions were easy: go for the top of the ranges");
        easyStreak = false;
      }
      let extra: Partial<TodayState> = i === 0 ? now : {};
      if (backLeft) {
        intensity = "easy";
        entry.reasons = [...entry.reasons, `back after Oura rest mode: session ${BACK_SESSIONS - backLeft + 1} of ${BACK_SESSIONS} easy, RPE ≤ ${BACK_RPE}`];
        extra = { ...extra, rpe_cap: Math.min(extra.rpe_cap || 10, BACK_RPE) };
        backLeft--;
      }
      const sess = variants(key, day, intensity, extra);
      Object.assign(entry, { kind: "session", intensity, title: plan.routines[key].title, session: sess });
      nxt = (nxt + 1) % plan.rotation.length; lastMain = day; owed = false;
    } else {
      if (plan.weekdays.includes(wd) && (blocked || !free) && (!plan.start || day >= plan.start)) owed = true; // moves, not skipped
      const optDays: string[] = (opt.weekdays || []).map((d: string) => d.slice(0, 3).toLowerCase());
      if (i === 0 && (now.day === "recovery" || now.day === "rest")) {
        const rr = plan.cfg.recovery_routine;
        Object.assign(entry, { kind: now.day, title: now.day === "rest" ? "Rest" : "Recovery day", reasons: now.reasons,
          note: rr && rr in plan.routines ? `Easy walk and your ${plan.routines[rr].title} routine.` : "Easy walk, mobility, or rest." });
      } else if (opt.routine && opt.routine in plan.routines && optDays.includes(wd) && (lastMain === null || day !== lastMain)) {
        Object.assign(entry, { kind: "optional", intensity: "normal", title: plan.routines[opt.routine].title,
          session: variants(opt.routine, day, "normal", i === 0 ? now : {}) });
      } else {
        const rd: Obj = plan.cfg.rest_day || {};
        Object.assign(entry, { kind: "rest", title: rd.title || "Rest or easy walk", note: rd.note || "" });
      }
    }
    days.push(entry);
  }
  return {
    generated: input.generated || new Date().toISOString().slice(0, 19),
    plan: input.plan.name,
    today: { date: today, adjust: now.day, reasons: now.reasons },
    phase: plan.phase(today),
    days,
  };
}
