// The person's data folder, read into the phone's AppState (shared/model.ts) and written back in the desktop's own
// formats, so the Python app (daily pulls, the local form, the phone page) and this server work on the same files.
// Every write goes through here.

import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { Change } from "../../shared/changes.ts";
import { BASE_KEYS, personal } from "../../shared/engine/signals.ts";
import { build } from "../../shared/engine/rolling.ts";
import type { Schedule } from "../../shared/engine/rolling.ts";
import type { CheckinRow, DailyRow, Obj, PlanDoc, Recovery, Routine } from "../../shared/engine/types.ts";
import { addDays } from "../../shared/engine/util.ts";
import { needsClearance } from "../../shared/engine/clearance.ts";
import type { AppState, ChangeLogEntry, ExportDoc } from "../../shared/model.ts";
import { EXPORT_FORMAT, currentRecovery, fromExport, workoutRows } from "../../shared/model.ts";
import type { Catalog } from "./catalog.ts";
import { parseCsv, writeCsv } from "./csv.ts";
import type { Row } from "./csv.ts";
import { SCHEMA, layout } from "./paths.ts";
import type { Paths } from "./paths.ts";

export const WORKOUT_FIELDS = ["date", "session", "duration_min", "exercise", "sets", "reps", "load_kg", "rpe", "pain", "notes"];
const WEARABLE_DAYS = 400; // as `sylvester.py export`: a year for baselines and trends

export const DEFAULT_SETTINGS: Obj = {
  schema: 0, python: "", phone_url: "", units: "metric", pull_time: "11:00",
  sources: { oura: false, polar: false, whoop: false, withings: false, apple_health: false }, active_plan: "",
};

/** Plan folder names and routine keys become file names: keep them to plain ids. */
export const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "plan";

const pad = (n: number) => String(n).padStart(2, "0");
/** Local time without a zone, as Python's datetime.now().isoformat(timespec="seconds"). */
export function localStamp(d = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function readJson<T = Obj>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, "")) ?? fallback; } catch { return fallback; }
}

/** Atomic, like paths.write_json: indent 2, non-ASCII kept. */
export function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  renameSync(tmp, path);
}

function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, path);
}

const jsonFiles = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith(".json")).sort() : []);

export class DataFolder {
  readonly p: Paths;
  readonly cat: Catalog;

  constructor(root: string, cat: Catalog) {
    this.p = layout(root);
    this.cat = cat;
  }

  exists(): boolean { return existsSync(this.p.data); }

  settings(): Obj { return { ...DEFAULT_SETTINGS, ...readJson(this.p.settings, {}) }; }

  saveSettings(patch: Obj): void { writeJson(this.p.settings, { ...this.settings(), ...patch }); }

  /** The folder of the plan in use: settings.active_plan, else the most recently changed plan with a program.md. */
  activePlanDir(): string | null {
    const name = this.settings().active_plan;
    if (name && existsSync(join(this.p.plans, name)) && statSync(join(this.p.plans, name)).isDirectory()) return join(this.p.plans, name);
    if (!existsSync(this.p.plans)) return null;
    const progs = readdirSync(this.p.plans).map(d => join(this.p.plans, d, "program.md")).filter(existsSync)
      .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);
    return progs.length ? dirname(progs[progs.length - 1]) : null;
  }

  rows(path: string, since?: string): Row[] {
    if (!existsSync(path)) return [];
    const rows = parseCsv(readFileSync(path, "utf8"));
    return since ? rows.filter(r => (r.date || "") >= since) : rows;
  }

  profileDoc(name: "health_profile" | "equipment" | "goals"): Obj { return readJson(join(this.p.profile, `${name}.json`), {}); }

  /** Everything in the folder as the phone's export document (what `sylvester.py export` writes), then as AppState. */
  load(today: string): AppState {
    const since = addDays(today, -WEARABLE_DAYS);
    const dir = this.activePlanDir();
    let plan: PlanDoc | null = null;
    if (dir) {
      const name = dir.split(/[\\/]/).pop()!;
      const program = join(dir, "program.md");
      plan = {
        name,
        program: existsSync(program) ? readFileSync(program, "utf8") : "",
        rolling: readJson(join(dir, "rolling.json"), {}),
        routines: Object.fromEntries(jsonFiles(join(dir, "routines")).map(f => [f.slice(0, -5), readJson(join(dir, "routines", f), {})])),
        overrides: Object.fromEntries(jsonFiles(join(dir, "overrides")).filter(f => f.slice(0, -5) >= addDays(today, -1))
          .map(f => [f.slice(0, -5), readJson(join(dir, "overrides", f), {})])),
      } as PlanDoc;
    }
    const shared = join(this.p.plans, "routines");
    const clean = (r: Row) => Object.fromEntries(Object.entries(r).filter(([, v]) => v !== "" && v != null)) as DailyRow;
    const apple = this.rows(join(this.p.sources, "apple_daily.csv"), since).map(r => {
      const x: Obj = clean(r);
      if (x.hrv_sdnn_elitehrv) x.avg_hrv = x.hrv_sdnn_elitehrv;
      if (x.resting_hr_elitehrv) x.lowest_hr = x.resting_hr_elitehrv;
      return x as DailyRow;
    });
    const daily: Record<string, DailyRow[]> = {
      Oura: this.rows(join(this.p.sources, "oura_daily.csv"), since).map(clean),
      WHOOP: this.rows(join(this.p.sources, "whoop_daily.csv"), since).map(clean),
      "Apple Health": apple,
    };
    const doc: ExportDoc = {
      format: EXPORT_FORMAT, version: 1, exported: localStamp(), source: "desktop",
      profile: { health_profile: this.profileDoc("health_profile"), equipment: this.profileDoc("equipment"), goals: this.profileDoc("goals") },
      plan,
      shared_routines: Object.fromEntries(jsonFiles(shared).map(f => [f.slice(0, -5), readJson<Routine>(join(shared, f), { title: f.slice(0, -5), exercises: [] })])),
      calibration: readJson(join(this.p.plans, "calibration.json"), {}),
      workouts: this.rows(join(this.p.records, "workout_log.csv")) as never,
      checkins: this.rows(join(this.p.records, "checkins.csv")) as CheckinRow[],
      assessment_rows: this.rows(join(this.p.records, "assessments.csv")),
      daily: Object.fromEntries(Object.entries(daily).filter(([, v]) => v.length)),
    };
    const state = fromExport(doc);
    state.changeLog = this.changeLog(50);
    return state;
  }

  /** The recovery the plan uses: the daily task's snapshot when it ran today (exactly what coach/rolling.py reads),
   *  otherwise worked out from the wearable rows. */
  recovery(state: AppState, today: string): Recovery | null {
    const snap = readJson<Obj>(join(this.p.records, "snapshot.json"), {});
    if (String(snap.generated || "").startsWith(today) && snap.recovery) return snap.recovery as Recovery;
    return currentRecovery(state, today);
  }

  /** The next 14 days; null without a plan, or while a needed doctor's go-ahead isn't recorded. */
  schedule(state: AppState, today: string): Schedule | null {
    if (!state.plan || !(state.plan.rolling.rotation || []).length) return null;
    if (needsClearance(state.profile.health_profile).length) return null;
    return build({
      today, lib: this.cat.lib, healthProfile: state.profile.health_profile, equipment: state.profile.equipment, goals: state.profile.goals,
      plan: state.plan, sharedRoutines: state.sharedRoutines, workouts: workoutRows(state), checkins: state.checkins,
      recovery: this.recovery(state, today), pictures: this.cat.pictures,
    });
  }

  /** Lay out the 14 days again and write <plan>/schedule.json and schedule.md, as coach/rolling.py does. */
  rebuild(today: string): Schedule | null {
    const state = this.load(today);
    const dir = this.activePlanDir();
    let sched: Schedule | null = null;
    try { sched = this.schedule(state, today); } catch { sched = null; }
    if (!sched || !dir) return sched;
    const out = { ...sched, generated: localStamp() };
    writeJson(join(dir, "schedule.json"), out);
    writeText(join(dir, "schedule.md"), scheduleMarkdown(out));
    return out;
  }

  // ---------- profile ----------

  /** Like the local form: the previous version goes to profile/.history/, and the document gets an _updated stamp. */
  writeProfileDoc(name: "health_profile" | "equipment" | "goals", data: Obj): void {
    const path = join(this.p.profile, `${name}.json`);
    if (existsSync(path)) {
      mkdirSync(this.p.history, { recursive: true });
      const stamp = localStamp().replace(/[-:]/g, "").replace("T", "-");
      copyFileSync(path, join(this.p.history, `${name}-${stamp}.json`));
    }
    writeJson(path, { ...data, _updated: localStamp() });
  }

  // ---------- logs ----------

  /** Common scales plus this person's signals, keeping any column an older file already has (core/signals.py). */
  checkinFields(hp: Obj, existing: Row[]): string[] {
    const fields = ["date", ...BASE_KEYS, "pain_where", ...personal(hp).map(s => s.key), "bp", "notes"];
    for (const k of Object.keys(existing[0] || {})) if (!fields.includes(k)) fields.push(k);
    return fields;
  }

  saveCheckin(row: Obj): void {
    const path = join(this.p.records, "checkins.csv");
    const rows = this.rows(path).filter(r => r.date !== row.date);
    const fields = this.checkinFields(this.profileDoc("health_profile"), rows);
    rows.push(Object.fromEntries(fields.map(k => [k, row[k] ?? ""])));
    writeText(path, writeCsv(fields, rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))));
  }

  /** Replace every row of this date and session; an empty exercise list deletes the session (app/server.py). */
  saveWorkout(w: { date: string; session: string; duration_min?: unknown; exercises: Obj[] }): void {
    const path = join(this.p.records, "workout_log.csv");
    const rows: Obj[] = this.rows(path).filter(r => !(r.date === w.date && r.session === w.session));
    for (const e of w.exercises) {
      if (String(e.exercise || "").trim()) {
        rows.push({ date: w.date, session: w.session, duration_min: w.duration_min ?? "",
          ...Object.fromEntries(WORKOUT_FIELDS.slice(3).map(k => [k, e[k] ?? ""])) });
      }
    }
    writeText(path, writeCsv(WORKOUT_FIELDS, rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))));
  }

  // ---------- plan changes ----------

  /** Write what `changes` changed, from the state as it is after them (shared/changes.ts applyChanges). */
  writeChanges(after: AppState, changes: Change[]): string[] {
    const written: string[] = [];
    const docs = new Set<"health_profile" | "equipment" | "goals">();
    let dir = this.activePlanDir();
    const planDir = (): string => {
      if (dir) return dir;
      const name = slugify(after.plan?.name || "plan");
      dir = join(this.p.plans, name);
      this.saveSettings({ active_plan: name });
      return dir;
    };
    const put = (path: string, data: unknown) => {
      if (typeof data === "string") writeText(path, data); else writeJson(path, data);
      written.push(path);
    };
    const drop = (path: string) => { if (existsSync(path)) { rmSync(path); written.push(`${path} (removed)`); } };
    for (const c of changes) {
      switch (c.type) {
        case "new_plan": {
          const name = slugify(c.plan.name || "plan");
          dir = join(this.p.plans, name);
          const p = after.plan!;
          put(join(dir, "program.md"), p.program || "");
          put(join(dir, "rolling.json"), p.rolling || {});
          for (const f of jsonFiles(join(dir, "routines"))) if (!(f.slice(0, -5) in (p.routines || {}))) drop(join(dir, "routines", f));
          for (const [k, r] of Object.entries(p.routines || {})) put(join(dir, "routines", `${k}.json`), r);
          for (const [d, o] of Object.entries(p.overrides || {})) put(join(dir, "overrides", `${d}.json`), o);
          this.saveSettings({ active_plan: name });
          break;
        }
        case "set_rolling": put(join(planDir(), "rolling.json"), after.plan!.rolling); break;
        case "set_routine": put(join(planDir(), "routines", `${c.key}.json`), after.plan!.routines[c.key]); break;
        case "remove_routine": drop(join(planDir(), "routines", `${c.key}.json`)); break;
        case "set_override": put(join(planDir(), "overrides", `${c.date}.json`), after.plan!.overrides[c.date]); break;
        case "clear_override": drop(join(planDir(), "overrides", `${c.date}.json`)); break;
        case "set_program": put(join(planDir(), "program.md"), after.plan!.program); break;
        case "set_limits": case "set_coaching": case "set_adaptations": case "set_signals": docs.add("health_profile"); break;
        case "set_goals": docs.add("goals"); break;
        case "set_load_steps": docs.add("equipment"); break;
        case "set_calibration": put(join(this.p.plans, "calibration.json"), after.calibration); break;
      }
    }
    for (const d of docs) {
      this.writeProfileDoc(d, after.profile[d]);
      written.push(join(this.p.profile, `${d}.json`));
    }
    return written;
  }

  // ---------- proposals and the change log ----------

  saveProposal(p: Obj): void { writeJson(join(this.p.proposals, `${p.id}.json`), p); }

  proposal(id: string): Obj | null {
    if (!/^p-[a-z0-9-]+$/.test(id)) return null;
    return readJson<Obj | null>(join(this.p.proposals, `${id}.json`), null);
  }

  logChange(entry: ChangeLogEntry & Obj): void {
    mkdirSync(this.p.plans, { recursive: true });
    appendFileSync(this.p.changes, JSON.stringify(entry) + "\n", "utf8");
  }

  changeLog(n: number): ChangeLogEntry[] {
    if (!existsSync(this.p.changes)) return [];
    return readFileSync(this.p.changes, "utf8").split("\n").filter(Boolean).slice(-n)
      .flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });
  }

  // ---------- a new folder ----------

  /** The folders `sylvester.py init` creates, and settings at the current layout version. */
  create(): void {
    for (const d of [this.p.profile, this.p.records, this.p.sources, join(this.p.data, "imports"), join(this.p.data, "secrets"),
      this.p.plans, join(this.p.data, "media"), join(this.p.data, "phone"), this.p.logs]) mkdirSync(d, { recursive: true });
    if (!existsSync(this.p.settings)) writeJson(this.p.settings, { ...DEFAULT_SETTINGS, schema: SCHEMA });
  }
}

/** schedule.md, as coach/rolling.py to_markdown writes it. */
export function scheduleMarkdown(s: Schedule): string {
  const L = [`# Next 14 days — ${s.plan} (built ${s.generated.slice(0, 16).replace("T", " ")})`, ""];
  const ph: Obj = s.phase || {};
  if (ph.name) L.push(`Phase: **${ph.name}**` + (ph.week ? `, week ${ph.week}` : "") + "\n");
  if (s.today.adjust) L.push(`Today is adjusted (${s.today.adjust}): ` + s.today.reasons.join("; ") + "\n");
  L.push("| Date | Day | What | Intensity | Why |", "|---|---|---|---|---|");
  const title = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);
  for (const d of s.days) L.push(`| ${d.date} | ${title(d.weekday)} | ${d.title || ""} | ${d.intensity || ""} | ${(d.reasons || []).join("; ")} |`);
  for (const d of s.days) {
    const x = d.session;
    if (!x) continue;
    L.push("", `## ${d.date} · ${x.title} (${x.intensity})`, "");
    if (x.coach_note) L.push(x.coach_note, "");
    if (x.battery) { L.push(`Calibration battery \`${x.battery}\`: the tests are on the phone page.`, ""); continue; }
    L.push("| Exercise | Sets × reps | Load | Note |", "|---|---|---|---|");
    for (const e of x.exercises) {
      L.push(`| ${e.name} | ${e.sets ?? ""} × ${e.reps ?? ""}${e.unit === "s" ? " s" : ""} | ${e.load_kg ? `${e.load_kg} kg` : ""} | ${e.note || ""} |`);
    }
  }
  return L.join("\n") + "\n";
}
