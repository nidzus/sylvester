// Everything one person keeps, as one object, and the pure functions that change it. Nothing here touches the
// phone (storage is in store.ts), so the tests run it under Node.
//
// The shapes are the desktop's: profile files, the plan folder, and the CSV rows. A desktop data folder exported
// with `python sylvester.py export` imports as is, and an app backup has the same format.

import { batteryDoc, mergeCatalogue } from "./engine/calibration.ts";
import type { AssessmentResult, Catalogue } from "./engine/calibration.ts";
import { ExerciseLibrary } from "./engine/library.ts";
import { recovery, trendDays } from "./engine/recovery.ts";
import { levelActions, personal } from "./engine/signals.ts";
import { needsClearance } from "./clearance.ts";
import { build, routineSession } from "./engine/rolling.ts";
import type { Schedule, Session } from "./engine/rolling.ts";
import type { CheckinRow, DailyRow, Obj, PlanDoc, Recovery, Routine, WorkoutRow } from "./engine/types.ts";
import { addDays } from "./engine/util.ts";

export const EXPORT_FORMAT = "sylvester-export";
export const STATE_VERSION = 1;

export type ClaudeMode = "off" | "own_key" | "hosted";

export interface Settings {
  units: "metric";
  claude: { mode: ClaudeMode; model: string; proxyUrl: string };
  sources: { apple_health: boolean; oura: boolean };
  consent: { disclaimer: string; ai: string }; // dates accepted ("" = not yet)
}

export interface WorkoutDoc {
  id: string; date: string; session: string; session_id: string; duration_min: string; notes: string; saved_at: string;
  exercises: { exercise: string; planned: string; sets: string; reps: string; load_kg: string; rpe: string; pain: string; notes: string;
    set_detail?: { reps: string; kg: string; done: boolean }[] }[];
}

export interface AssessmentDoc { date: string; battery: string; title: string; notes: string; results: AssessmentResult[]; saved_at: string }

export interface ChangeLogEntry { at: string; summary: string; verdict: string; changes: string[] }

export interface AppState {
  version: number;
  profile: { health_profile: Obj; equipment: Obj; goals: Obj };
  plan: PlanDoc | null;
  sharedRoutines: Record<string, Routine>;
  calibration: Partial<Catalogue>;
  workouts: WorkoutDoc[];
  checkins: CheckinRow[];
  assessments: AssessmentDoc[];
  daily: Record<string, DailyRow[]>; // by source: "Oura", "WHOOP", "Apple Health"
  settings: Settings;
  changeLog: ChangeLogEntry[];
}

export const DEFAULT_MODEL = "claude-opus-5-5";

export function emptyState(): AppState {
  return {
    version: STATE_VERSION,
    profile: {
      health_profile: { onboarding: { disclaimer_accepted: "", completed: "" }, review: { status: "" }, conditions: [], injuries: [],
        medications: [], restrictions: {}, signals: [], limits: {}, coaching: {}, adaptations: [], training_background: {} },
      equipment: { items: [] },
      goals: { goals: [] },
    },
    plan: null,
    sharedRoutines: {},
    calibration: {},
    workouts: [],
    checkins: [],
    assessments: [],
    daily: {},
    settings: {
      units: "metric",
      claude: { mode: "off", model: DEFAULT_MODEL, proxyUrl: "" },
      sources: { apple_health: false, oura: false },
      consent: { disclaimer: "", ai: "" },
    },
    changeLog: [],
  };
}

// ---------- the workout log ----------

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** One row per logged exercise, as records/workout_log.csv has them (what the plan reads). */
export function workoutRows(state: AppState): WorkoutRow[] {
  const docs = [...state.workouts].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.saved_at < b.saved_at ? -1 : 1));
  return docs.flatMap(w => w.exercises.map(e => ({
    date: w.date, session: w.session, duration_min: w.duration_min, exercise: e.exercise, sets: e.sets, reps: e.reps,
    load_kg: e.load_kg, rpe: e.rpe, pain: e.pain, notes: e.notes,
  })));
}

/** A workout replaces an earlier save of the same session on the same day. */
export function saveWorkout(state: AppState, doc: Omit<WorkoutDoc, "id" | "saved_at">, now = new Date().toISOString()): AppState {
  const id = `${doc.date}__${slug(doc.session)}`;
  return { ...state, workouts: [...state.workouts.filter(w => w.id !== id), { ...doc, id, saved_at: now }] };
}

export function deleteWorkout(state: AppState, id: string): AppState {
  return { ...state, workouts: state.workouts.filter(w => w.id !== id) };
}

/** "12", "12", "11" -> "12/12/11"; all the same -> "12". */
export function collapse(values: (string | number | null | undefined)[]): string {
  const v = values.filter(x => x !== "" && x != null).map(String);
  if (!v.length) return "";
  return v.every(x => x === v[0]) ? v[0] : v.join("/");
}

// ---------- check-ins and calibration ----------

export function saveCheckin(state: AppState, row: CheckinRow): AppState {
  return { ...state, checkins: [...state.checkins.filter(c => c.date !== row.date), row].sort((a, b) => (a.date < b.date ? -1 : 1)) };
}

export function saveAssessment(state: AppState, doc: Omit<AssessmentDoc, "saved_at">, now = new Date().toISOString()): AppState {
  const keep = state.assessments.filter(a => !(a.date === doc.date && a.battery === doc.battery));
  return { ...state, assessments: [...keep, { ...doc, saved_at: now }] };
}

// ---------- wearables ----------

/** Merge daily rows from one source: a newer row for a date replaces the older one, field by field. */
export function mergeDaily(state: AppState, source: string, rows: DailyRow[]): AppState {
  const by = new Map((state.daily[source] || []).map(r => [r.date, r]));
  for (const r of rows) by.set(r.date, { ...(by.get(r.date) || {}), ...r });
  const merged = [...by.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  return { ...state, daily: { ...state.daily, [source]: merged } };
}

/** The recovery wearable with the most recent data: Oura or WHOOP first (they have a readiness score),
 *  Apple Health when neither has anything. */
export function recoverySource(state: AppState): [string, DailyRow[]] | null {
  let best: [string, DailyRow[]] | null = null;
  for (const name of ["Oura", "WHOOP"]) {
    const rows = state.daily[name] || [];
    if (rows.length && (!best || rows[rows.length - 1].date > best[1][best[1].length - 1].date)) best = [name, rows];
  }
  if (!best && state.daily["Apple Health"]?.length) best = ["Apple Health", state.daily["Apple Health"]];
  return best;
}

export function currentRecovery(state: AppState, today: string): Recovery | null {
  const src = recoverySource(state);
  return src ? recovery(src[1].filter(r => r.date <= today), src[0], today) : null;
}

export function status(state: AppState, today: string) {
  const src = recoverySource(state);
  const rec = currentRecovery(state, today);
  const weekAgo = addDays(today, -6);
  return {
    recovery: rec,
    days: src ? trendDays(src[1], today) : [],
    logged7d: state.workouts.filter(w => w.date >= weekAgo && w.date <= today).length,
    checkin: state.checkins.find(c => c.date === today) || null,
  };
}

// ---------- the plan ----------

/** The next 14 days; none at all while a needed doctor's go-ahead isn't recorded (clearance.ts). */
export function schedule(state: AppState, lib: ExerciseLibrary, today: string, pictures: Record<string, { name?: string }>): Schedule | null {
  if (!state.plan || !(state.plan.rolling.rotation || []).length) return null;
  if (needsClearance(state.profile.health_profile).length) return null;
  return build({
    today, lib, healthProfile: state.profile.health_profile, equipment: state.profile.equipment, goals: state.profile.goals,
    plan: state.plan, sharedRoutines: state.sharedRoutines, workouts: workoutRows(state), checkins: state.checkins,
    recovery: currentRecovery(state, today), pictures,
  });
}

export function routine(state: AppState, lib: ExerciseLibrary, key: string, today: string, pictures: Record<string, { name?: string }>): Session | null {
  if (!state.plan || needsClearance(state.profile.health_profile).length) return null;
  return routineSession({
    today, lib, healthProfile: state.profile.health_profile, equipment: state.profile.equipment, goals: state.profile.goals,
    plan: state.plan, sharedRoutines: state.sharedRoutines, workouts: workoutRows(state), checkins: state.checkins,
    recovery: currentRecovery(state, today), pictures,
  }, key);
}

/** Today's limits on what may be opened: on a recovery or rest day no lifting at all (only the recovery routine);
 *  a personal signal at any level postpones a calibration (a baseline needs a normal day). Mirrors app/phone.html. */
export function todayGate(state: AppState, sched: Schedule | null, today: string) {
  const day = sched?.days.find(d => d.date === today);
  const recovery = sched?.today.adjust === "recovery" || sched?.today.adjust === "rest";
  const ci = state.checkins.find(c => c.date === today);
  const acts = ci ? personal(state.profile.health_profile).map(sg => [sg, levelActions(sg, ci[sg.key])] as const).filter(([, a]) => a) : [];
  const signal = acts.length > 0;
  const stops = acts.filter(([sg, a]) => (a!.day === "recovery" || a!.day === "rest") && sg.stop).map(([sg]) => sg.stop as string);
  return { recovery, signal, reasons: sched?.today.reasons || [], recoveryRoutine: state.plan?.rolling.recovery_routine || null,
    note: day?.note || "", stops };
}

export function catalogue(state: AppState, shared: Catalogue): Catalogue {
  return mergeCatalogue(shared, state.calibration);
}

export function battery(state: AppState, shared: Catalogue, id: string, date: string) {
  return batteryDoc(catalogue(state, shared), id, date);
}

// ---------- export and import ----------

export interface ExportDoc {
  format: typeof EXPORT_FORMAT;
  version: number;
  exported: string;
  source: "desktop" | "app";
  profile: AppState["profile"];
  plan: PlanDoc | null;
  shared_routines?: Record<string, Routine>;
  calibration?: Partial<Catalogue>;
  workouts?: WorkoutRow[];
  workout_docs?: WorkoutDoc[];
  checkins?: CheckinRow[];
  assessments?: AssessmentDoc[];
  assessment_rows?: Obj[];
  daily?: Record<string, DailyRow[]>;
}

export function toExport(state: AppState, now = new Date().toISOString()): ExportDoc {
  return {
    format: EXPORT_FORMAT, version: 1, exported: now, source: "app",
    profile: state.profile, plan: state.plan, shared_routines: state.sharedRoutines, calibration: state.calibration,
    workouts: workoutRows(state), workout_docs: state.workouts, checkins: state.checkins, assessments: state.assessments,
    daily: state.daily,
  };
}

/** Workout CSV rows back into one saved session per date and session name. */
function docsFromRows(rows: WorkoutRow[], now: string): WorkoutDoc[] {
  const by = new Map<string, WorkoutDoc>();
  for (const r of rows) {
    const id = `${r.date}__${slug(r.session)}`;
    let d = by.get(id);
    if (!d) {
      d = { id, date: r.date, session: r.session, session_id: "", duration_min: String(r.duration_min ?? ""), notes: "", saved_at: now, exercises: [] };
      by.set(id, d);
    }
    d.exercises.push({ exercise: r.exercise, planned: "", sets: String(r.sets ?? ""), reps: String(r.reps ?? ""),
      load_kg: String(r.load_kg ?? ""), rpe: String(r.rpe ?? ""), pain: String(r.pain ?? ""), notes: String(r.notes ?? "") });
  }
  return [...by.values()];
}

/** assessments.csv rows (one per test and side) back into one save per date and battery. */
function assessmentDocs(rows: Obj[], now: string): AssessmentDoc[] {
  const by = new Map<string, AssessmentDoc>();
  for (const r of rows) {
    const key = `${r.date}__${r.battery || ""}`;
    let d = by.get(key);
    if (!d) { d = { date: r.date, battery: r.battery || "", title: r.battery || "", notes: "", results: [], saved_at: now }; by.set(key, d); }
    d.results.push({ test: r.test, name: r.name || r.test, side: r.side || "", value: String(r.value ?? ""), unit: r.unit || "",
      load_kg: String(r.load_kg ?? ""), rpe: String(r.rpe ?? ""), pain: String(r.pain ?? ""),
      flags: r.flags ? String(r.flags).split(/[;|]/).filter(Boolean) : [], note: r.note || "" });
  }
  return [...by.values()];
}

export function fromExport(doc: unknown, base: AppState = emptyState(), now = new Date().toISOString()): AppState {
  const d = doc as ExportDoc;
  if (!d || d.format !== EXPORT_FORMAT) throw new Error("This isn't a Sylvester export file.");
  if (d.version > 1) throw new Error("This export comes from a newer Sylvester. Update the app first.");
  if (!d.profile?.health_profile) throw new Error("The export has no profile.");
  return {
    ...base,
    profile: { health_profile: d.profile.health_profile || {}, equipment: d.profile.equipment || { items: [] }, goals: d.profile.goals || { goals: [] } },
    plan: d.plan || null,
    sharedRoutines: d.shared_routines || {},
    calibration: d.calibration || {},
    workouts: d.workout_docs?.length ? d.workout_docs : docsFromRows(d.workouts || [], now),
    checkins: d.checkins || [],
    assessments: d.assessments?.length ? d.assessments : assessmentDocs(d.assessment_rows || [], now),
    daily: d.daily || {},
    settings: {
      ...base.settings,
      sources: { ...base.settings.sources, oura: base.settings.sources.oura || !!d.daily?.Oura?.length },
      consent: { ...base.settings.consent, disclaimer: base.settings.consent.disclaimer || d.profile.health_profile.onboarding?.disclaimer_accepted || "" },
    },
  };
}

export function isOnboarded(state: AppState): boolean {
  return !!state.settings.consent.disclaimer && !!state.profile.health_profile.onboarding?.completed;
}
