// Shapes shared with the desktop app. Field names match the JSON files the Python side reads and writes,
// so a data folder exported from the desktop imports as is.

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type Obj = Record<string, any>;

export interface Exercise {
  id: string;
  name: string;
  pattern: string;
  family: string;
  level: number;
  equipment?: (string | string[])[];
  styles: string[];
  purposes: string[];
  stresses: string[];
  unit?: string;
  unilateral?: boolean;
  cues?: string[];
  picture?: string | null;
  picture_only?: boolean;
  implement?: string;
}

export interface Library {
  patterns: Obj;
  purposes: Obj;
  stresses: Obj;
  equipment: Record<string, string>;
  household: string[];
  conditions: Record<string, { label?: string; avoid?: string[]; caution?: string[]; prefer?: string[]; notes?: string }>;
  exercises: Exercise[];
  mixes: Obj[];
  by_id?: Record<string, Exercise>;
}

export interface Adaptation {
  match?: { ids?: string[]; families?: string[]; patterns?: string[] };
  how?: string;
  removes?: string[];
  adds?: string[];
  needs?: string[];
  why?: string;
  source?: string;
}

/** library.person(): what the library sees of one person. */
export interface Person {
  limits: Obj;
  avoid: Set<string>;
  caution: Set<string>;
  max_level: number;
  equipment: Set<string>;
  household: Set<string>;
  purposes: Record<string, number>;
  focus: string[];
  emphasis: string[];
  prefer: Set<string>;
  dislike: Set<string>;
  adaptations: Adaptation[];
}

export interface Slot {
  pattern: string;
  purpose?: string;
  every_weeks?: number | "phase";
  from?: string[];
  styles?: string[];
  max_level?: number;
  choices?: number;
  margin?: number;
  avoid?: string[];    // the slot's own limits on top of the person's
  caution?: string[];
}

/** A routine entry or a planned exercise (the phone spec format). */
export type Entry = Obj;

export interface Routine {
  id?: string;
  title: string;
  focus?: string;
  duration?: string;
  coach_note?: string;
  warmup?: string[];
  exercises: Entry[];
  order?: number;
  [k: string]: any;
}

export interface Phase {
  name: string;
  weeks: number;
  rpe_cap?: number;
  deload?: boolean;
  sets_max?: number;
}

export interface RollingConfig {
  start?: string;
  weekdays?: string[];
  rotation?: string[];
  optional?: { routine?: string; weekdays?: string[] };
  rest_day?: { title?: string; note?: string };
  recovery_routine?: string;
  min_rest_days?: number;
  phases?: Phase[];
  rules?: Obj;
  [k: string]: any;
}

/** One plan: the desktop's <data>/plans/<name>/ folder as one object. */
export interface PlanDoc {
  name: string;
  program?: string;                    // program.md
  rolling: RollingConfig;              // rolling.json
  routines: Record<string, Routine>;   // routines/*.json by file stem
  overrides: Record<string, Obj>;      // overrides/YYYY-MM-DD.json by date
}

/** records/workout_log.csv, one row per exercise. */
export interface WorkoutRow {
  date: string;
  session: string;
  duration_min?: string;
  exercise: string;
  sets?: string;
  reps?: string;
  load_kg?: string;
  rpe?: string;
  pain?: string;
  notes?: string;
  [k: string]: unknown;
}

/** records/checkins.csv, one row per day. */
export type CheckinRow = { date: string } & Record<string, unknown>;

/** sources/oura_daily.csv (and the same columns from WHOOP or Apple Health). */
export type DailyRow = { date: string } & Record<string, unknown>;

/** The recovery part of records/snapshot.json. */
export interface Recovery {
  status: "green" | "amber" | "red";
  status_why: string[];
  status_meaning: string;
  source: string;
  latest_date: string;
  readiness_today: number | null;
  temperature_deviation: number | null;
  resilience: string | null;
  stress: string | null;
  last_night: Obj | null;
  metrics: Record<string, { label: string; last_7d: number | null; baseline_60d: number | null; delta_pct: number | null }>;
  flags: string[];
  /** Oura Rest Mode from the rest_mode column; null when the rows don't have it (absent in older snapshots). */
  rest_mode?: { on: boolean; since: string | null; ended: string | null } | null;
}

export interface Signal {
  key: string;
  label: string;
  lo: number;
  hi: number;
  hint?: string;
  help?: string;
  levels?: Record<string, Obj | string>;
  stop?: string;
}

/** Everything one person keeps: the desktop data folder as one document. */
export interface Profile {
  health_profile: Obj;
  equipment: Obj;
  goals: Obj;
}
