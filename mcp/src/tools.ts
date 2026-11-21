// The coach's tools, grouped by what they're for: status and setup; today and training; recovery, sleep and
// balance; the profile and reference; changing the plan. Reads never change anything. Writes go through
// data.ts in the desktop's own formats, and every plan change passes shared/changes.ts's checks first.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

import { applyChanges, checkChanges, describe, needsReview, shapeErrors } from "../../shared/changes.ts";
import type { Change } from "../../shared/changes.ts";
import { recordClearance } from "../../shared/clearance.ts";
import { mergeCatalogue } from "../../shared/engine/calibration.ts";
import { REASONS, needsClearance } from "../../shared/engine/clearance.ts";
import { recovery as recoveryOf, trendDays } from "../../shared/engine/recovery.ts";
import { BASE, levelActions, personal } from "../../shared/engine/signals.ts";
import type { Obj, Signal } from "../../shared/engine/types.ts";
import { addDays, localToday } from "../../shared/engine/util.ts";
import type { AppState } from "../../shared/model.ts";
import { recoverySource, todayGate, workoutRows } from "../../shared/model.ts";
import { REVIEWER, compactSchedule, readVerdict, reviewDocument } from "../../shared/review.ts";
import { AI_NOTICE, CARDIO, DISCLAIMER, EXPERIENCE, GEAR, GOALS, INJURY_STATUS, SCREEN, SPOTS, TRIGGERS, applySetup, blankAnswers } from "../../shared/setup.ts";
import type { SetupAnswers } from "../../shared/setup.ts";
import { starterPlan } from "../../shared/starter.ts";
import { catalog } from "./catalog.ts";
import { DataFolder, SAFE_ID, localStamp, writeJson } from "./data.ts";
import { POINTER, SCHEMA, dataRoot } from "./paths.ts";

export interface ToolResult { text: string; error?: boolean }
interface Ctx { data: DataFolder; today: string; how: string }
interface Annotations { readOnlyHint: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint: boolean }
export interface Tool {
  name: string; title: string; description: string; inputSchema: Obj; annotations: Annotations;
  run: (input: Obj, ctx: Ctx) => ToolResult;
}

const READ: Annotations = { readOnlyHint: true, openWorldHint: false };
const WRITE: Annotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const REPLACE: Annotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

const ok = (x: unknown): ToolResult => ({ text: typeof x === "string" ? x : JSON.stringify(x) });
const fail = (text: string): ToolResult => ({ text, error: true });
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const KNOWLEDGE = ["medical", "recovery", "training", "exercise_library", "balance"];
const REPORTS = ["snapshot", "trends", "baseline", "analysis", "clinical_summary"];

const notSetUp = (ctx: Ctx) =>
  fail(`No Sylvester data folder at ${ctx.data.p.data}. Call setup_guide to set the person up (or, with the desktop app, \`python sylvester.py init\`).`);

/** Fields a model reads to follow a session; pictures and step-by-step text stay out. */
function slimExercise(e: Obj): Obj {
  const { instructions: _i, images: _im, img: _g, picture: _p, lib: _l, credit: _c, ...rest } = e;
  return rest;
}
function slimSession(s: Obj | undefined): Obj | undefined {
  if (!s) return undefined;
  const out: Obj = { ...s, exercises: (s.exercises || []).map(slimExercise) };
  if (s.easy) out.easy = slimSession(s.easy);
  if (s.anywhere) out.anywhere = slimSession(s.anywhere);
  return out;
}

const scaleFor = (s: Signal) => ({ key: s.key, label: s.label, range: `${s.lo}–${s.hi}`, hint: s.hint || undefined, help: s.help || undefined });

function avg(xs: number[]): number | null { return xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null; }

/** 7-day averages of the check-in scales against the 14 days before, for the balance side. */
function checkinTrend(state: AppState, today: string): Obj {
  const out: Obj = {};
  const recent = state.checkins.filter(c => c.date > addDays(today, -7) && c.date <= today);
  const before = state.checkins.filter(c => c.date > addDays(today, -21) && c.date <= addDays(today, -7));
  for (const s of [...BASE, ...personal(state.profile.health_profile)]) {
    const val = (rows: Obj[]) => rows.map(r => Number(r[s.key])).filter(v => r0(v));
    const a = avg(val(recent)), b = avg(val(before));
    if (a !== null || b !== null) out[s.key] = { last_7d: a, previous_14d: b };
  }
  out.checkins_last_7d = recent.length;
  return out;
}
const r0 = (v: number) => Number.isFinite(v);

function ctxFor(): Ctx {
  const root = dataRoot();
  return { data: new DataFolder(root.path, catalog()), today: localToday(), how: root.how };
}

function lastDate(rows: { date: string }[]): string | null {
  return rows.length ? rows.reduce((m, r) => (r.date > m ? r.date : m), rows[0].date) : null;
}

function openProposals(data: DataFolder): Obj[] {
  if (!existsSync(data.p.proposals)) return [];
  return readdirSync(data.p.proposals).filter(f => /^p-.*\.json$/.test(f) && !f.endsWith(".review.json"))
    .map(f => data.proposal(f.slice(0, -5))).filter((p): p is Obj => !!p && p.status === "pending")
    .map(p => ({ id: p.id, summary: p.summary, created: p.created, review_needed: p.review, has_verdict: !!p.verdict }));
}

// ---------------------------------------------------------------------------------------------------------------

const FORMATS = {
  routine: '{"title", "focus", "duration", "coach_note", "warmup": [..], "exercises": [entry, ...]}',
  entry: '{"ex": "<library id>", "sets": 3, "reps": "8–12", "load_kg": 12, "rest": "90 s", "cues": [..], "anywhere_ex": "<library id>" | "skip", "anywhere_note": "...", "tags": [..]}. Main lifts (2–3 per session) are fixed with "ex" and kept for at least a phase. Everything else rotates as a slot: {"slot": {"pattern": "core_rot", "purpose": "core", "every_weeks": 3, "from": [ids]}, "sets", "reps"}; reps may be by unit, e.g. {"reps": "8–12", "s": "20–30", "m": "30"}. Every loaded exercise needs a starting load_kg.',
  rolling: '{"start": "YYYY-MM-DD" (a Monday), "weekdays": ["mon","wed","fri"], "rotation": ["a","b"], "optional": {"routine", "weekdays"}, "rest_day": {"title","note"}, "recovery_routine": "<key>", "min_rest_days": 1, "phases": [{"name","weeks","rpe_cap","deload","sets_max"}], "rules": {"hard_rpe": 9, "easy_rpe": 7, "pain_stop": 3}}',
  override: 'One day set by hand: a session {"title", "routine": "<the rotation routine it stands in for>", "exercises": [...], "coach_note"} or {"kind": "rest", "title", "note"}.',
  program: "Markdown: goal and target, starting point, every condition and injury by name and exactly how the plan works around it, phases with progression rule and gates, conditioning zones with the HR values used, recovery and balance rules, review dates, a 'Stop and get help' section, and 'Worth buying' as a separate list.",
  profile_parts: 'limits {"avoid", "caution", "max_level": 1–5, "conditions": [library condition ids]}; coaching {"focus", "emphasis", "prefer", "dislike"}; adaptations [{"match": {"ids"|"families"|"patterns": [..]}, "how", "removes", "adds", "needs", "why", "source": "you" | "Coach (confirm)"}]; signals [{"key","label","lo","hi","hint","levels": {"2": {"day": "easy"|"recovery"|"rest", "avoid_tags", "add_routine", "rpe_cap", "note"}}, "stop"}]; goals [{"title","type","target","by","status"}]; load_steps {"dumbbell": [kg...], "barbell": [kg...]}.',
};

export const TOOLS: Tool[] = [
  // ---------- status and setup ----------
  {
    name: "status",
    title: "Where things stand",
    description: "Start here. Whether the person is set up, their plan and phase, which wearables have data and how fresh, the last check-in and workout, open proposals, a doctor's go-ahead if one is needed, and the one next step.",
    inputSchema: { type: "object", properties: {} },
    annotations: READ,
    run: (_i, ctx) => {
      const { data, today } = ctx;
      if (!data.exists()) {
        return ok({ data_folder: data.p.data, set_up: false,
          next: "Not set up on this computer. Call setup_guide and follow it. (With the desktop app instead: `python sylvester.py init`, then its setup wizard.)" });
      }
      const s = data.settings();
      if (Number(s.schema || 0) > SCHEMA) return ok({ data_folder: data.p.data, next: "This data folder is newer than this copy of Sylvester: update the app (or the extension) first." });
      const state = data.load(today);
      const hp = state.profile.health_profile;
      const ob = hp.onboarding || {};
      const clearance = needsClearance(hp);
      let sched = null;
      try { sched = data.schedule(state, today); } catch { sched = null; }
      const src = recoverySource(state);
      const snap = join(data.p.records, "snapshot.json");
      const next = !ob.completed ? "Setup isn't finished: call setup_guide and complete it."
        : clearance.length ? `A doctor's go-ahead is needed before any plan (${clearance.map(k => REASONS[k] || k).join(", ")}). Help them prepare for it; record_clearance once they have it.`
        : !state.plan ? "Set up, no plan yet. Offer the calibration (on the phone page or the iPhone app), then a plan written for them (new_plan), or a starter plan now (setup_profile with starter_plan)."
        : "Ready. today gives today's session.";
      return ok({
        data_folder: data.p.data, found_by: ctx.how, set_up: !!ob.completed, onboarding: ob,
        plan: state.plan ? { name: state.plan.name, phase: sched?.phase || null, routines: Object.keys(state.plan.routines || {}) } : null,
        doctor_go_ahead_needed: clearance.map(k => REASONS[k] || k),
        wearables: { connected: s.sources, recovery_source: src?.[0] || null, latest_day: src ? lastDate(src[1]) : null,
          daily_update: existsSync(snap) ? (JSON.parse(readFileSync(snap, "utf8")).generated || null) : null },
        last_checkin: lastDate(state.checkins), checked_in_today: state.checkins.some(c => c.date === today),
        last_workout: lastDate(state.workouts), open_proposals: openProposals(data), today, next,
      });
    },
  },
  {
    name: "setup_guide",
    title: "How to set someone up",
    description: "Everything first-time setup needs: the disclaimer and data notice to show first, the health-check questions, and the choices for experience, aches, equipment and goals, with the answer format setup_profile takes.",
    inputSchema: { type: "object", properties: {} },
    annotations: READ,
    run: (_i, ctx) => ok({
      data_folder: ctx.data.p.data, exists: ctx.data.exists(),
      steps: [
        "1. Show the disclaimer and the data notice in plain words and get a clear yes. Nothing else until then.",
        "2. The health check: ask the screening questions exactly as written, yes or no each. A yes to chest, dizzy or supervised, a heart condition or pregnancy means no plan until a doctor's go-ahead: say so kindly and carry on with setup.",
        "3. Conditions (from the list, plus anything else in their words), medications, aches (spot, side, status, pain 0–10, what makes it worse from the triggers), experience, days per week and minutes per session.",
        "4. Equipment (gear kinds, cardio machines, dumbbell and barbell weights), then goals in priority order with a target if they have one.",
        "5. Read the answers back in one short summary, then setup_profile with accept_disclaimer true. Offer the starter plan (starter_plan: true) unless a go-ahead is needed.",
        "Ask in a few grouped messages, not one question at a time.",
      ],
      disclaimer: DISCLAIMER,
      data_notice: AI_NOTICE.replace(/With an invite code[^.]*\. /, "").replace("Everything else stays on this iPhone.", "Everything is kept in the data folder on this computer.")
        .replace(" You can use the plan, logging and Apple Health without the Coach.", ""),
      screening: Object.fromEntries(SCREEN),
      conditions: Object.fromEntries(Object.entries(ctx.data.cat.lib.data.conditions).map(([k, v]) => [k, (v as Obj).label || k])),
      experience: EXPERIENCE, injury_status: INJURY_STATUS.map(x => x[0]), spots: SPOTS, triggers: TRIGGERS,
      gear: Object.fromEntries(GEAR), cardio: CARDIO, goals: Object.fromEntries(GOALS.map(g => [g[0], g[1]])),
      answers_format: { ...blankAnswers(), screening: { heart: "no", chest: "no", "...": "every key of screening, yes or no" },
        aches: [{ spot: "Knee", side: "right", status: "recovering", pain: "2", triggers: ["Squatting"], notes: "" }],
        goal_targets: { strength: "optional target in their words" } },
    }),
  },
  {
    name: "setup_profile",
    title: "Save the setup answers",
    description: "Create the data folder if needed and save the setup answers as the health profile, equipment and goals; limits start from the library's condition guidance and the aches' triggers. Optionally lays out a starter plan (not while a doctor's go-ahead is needed). Running it again replaces only what setup wrote before. Only after the person has accepted the disclaimer.",
    inputSchema: {
      type: "object",
      properties: {
        accept_disclaimer: { type: "boolean", description: "True only if the person said yes to the disclaimer and data notice in this conversation." },
        answers: { type: "object", description: "The answers, in setup_guide's answers_format." },
        starter_plan: { type: "boolean", description: "Also lay out the starter plan when there is no plan yet." },
      },
      required: ["accept_disclaimer", "answers"],
    },
    annotations: WRITE,
    run: (input, ctx) => {
      if (input.accept_disclaimer !== true) return fail("The person has to accept the disclaimer first: show it (setup_guide) and ask.");
      const { data, today } = ctx;
      const a = { ...blankAnswers(), ...(input.answers || {}) } as SetupAnswers;
      for (const k of ["conditions", "aches", "gear", "cardio", "goals"] as const) if (!Array.isArray(a[k])) (a as Obj)[k] = [];
      if (typeof a.screening !== "object" || !a.screening) a.screening = {};
      a.days_per_week = Number(a.days_per_week) || 3;
      a.session_minutes = Number(a.session_minutes) || 45;
      for (const k of ["weight_kg", "height_cm", "dumbbell_max_kg", "dumbbell_step_kg", "barbell_bar_kg", "barbell_max_kg"] as const) a[k] = String(a[k] ?? "");
      const unknown = a.conditions.filter(c => !data.cat.lib.data.conditions[c]);
      if (unknown.length) return fail(`Unknown condition ids: ${unknown.join(", ")}. Use setup_guide's conditions, and put anything else in other_conditions.`);
      const created = !data.exists();
      data.create();
      if (ctx.how === "default" && !existsSync(POINTER())) writeJson(POINTER(), { data: data.p.data });
      const state = data.load(today);
      state.settings.consent.disclaimer ||= state.profile.health_profile.onboarding?.disclaimer_accepted || today;
      const after = applySetup(state, a, data.cat.lib.data, today);
      const hp = after.profile.health_profile;
      hp.onboarding = { ...hp.onboarding, wizard_completed: hp.onboarding?.wizard_completed || today, source: "chat" };
      data.writeProfileDoc("health_profile", hp);
      data.writeProfileDoc("equipment", after.profile.equipment);
      data.writeProfileDoc("goals", after.profile.goals);
      const clearance = needsClearance(hp);
      let plan = "none";
      if (input.starter_plan && !data.activePlanDir()) {
        if (clearance.length) plan = "not laid out: a doctor's go-ahead is needed first";
        else {
          const doc = starterPlan(data.cat.lib, hp, after.profile.equipment, after.profile.goals, today);
          const fresh = data.load(today);
          const changes: Change[] = doc ? [{ type: "new_plan", plan: doc }] : [];
          const check = doc ? checkChanges(fresh, changes, data.cat.lib, today) : null;
          if (!doc || !check) plan = "not laid out";
          else if (check.blocking.length) plan = `not laid out: ${check.blocking.join(" ")}`;
          else {
            data.writeChanges(check.after, changes);
            data.rebuild(today);
            data.logChange({ at: localStamp(), summary: "Starter plan", verdict: "starter plan (generated from the library, local checks only)", changes: changes.map(describe) });
            plan = "starter plan laid out";
          }
        }
      }
      return ok({
        saved: data.p.data, new_folder: created, limits: hp.limits, conditions: (hp.conditions || []).map((c: Obj) => c.name),
        doctor_go_ahead_needed: clearance.map(k => REASONS[k] || k), plan,
        next: clearance.length ? "Explain the go-ahead and help them prepare for it; record_clearance once they have it."
          : plan === "starter plan laid out" ? "Show today's session (today). Suggest the calibration soon, then a plan written for them."
          : "Offer a starter plan, or a plan written for them after the calibration.",
      });
    },
  },
  {
    name: "record_clearance",
    title: "Record a doctor's go-ahead",
    description: "Record that a doctor (or the supervising professional) has cleared the person to train, covering everything that currently needs it. Only when the person tells you so themselves.",
    inputSchema: {
      type: "object",
      properties: {
        by: { type: "string", description: "Who gave it, as the person said (\"my GP\", \"cardiologist\")." },
        date: { type: "string", description: "YYYY-MM-DD; default today." },
      },
      required: ["by"],
    },
    annotations: WRITE,
    run: (input, ctx) => {
      const { data, today } = ctx;
      if (!data.exists()) return notSetUp(ctx);
      const hp = data.profileDoc("health_profile");
      const needed = needsClearance(hp);
      if (!needed.length) return ok("Nothing needs a go-ahead right now; nothing recorded.");
      const date = DATE.test(String(input.date || "")) ? String(input.date) : today;
      data.writeProfileDoc("health_profile", recordClearance(hp, date, String(input.by || "their doctor").slice(0, 120)));
      data.rebuild(today);
      return ok({ recorded: { date, by: input.by, covers: needed.map(k => REASONS[k] || k) }, next: "Plans can be written now. status shows the next step." });
    },
  },

  // ---------- today and training ----------
  {
    name: "today",
    title: "Today (or any day)",
    description: "One day in full: the session with exercises, sets, reps and loads (plus its easier and no-equipment versions), or why it's a recovery or rest day; today's gate (what may be opened after the check-in); the recovery picture; and the check-in, or its scales if they haven't checked in.",
    inputSchema: { type: "object", properties: { date: { type: "string", description: "YYYY-MM-DD within the next 14 days; default today." } } },
    annotations: READ,
    run: (input, ctx) => {
      const { data, today } = ctx;
      if (!data.exists()) return notSetUp(ctx);
      const state = data.load(today);
      const date = DATE.test(String(input.date || "")) ? String(input.date) : today;
      const hp = state.profile.health_profile;
      const clearance = needsClearance(hp);
      if (clearance.length) return ok({ today, doctor_go_ahead_needed: clearance.map(k => REASONS[k] || k), note: "No training plan until it's recorded (record_clearance)." });
      if (!state.plan) return ok({ today, plan: null, note: "No plan yet: status has the next step." });
      const sched = data.schedule(state, today);
      const day = sched?.days.find(d => d.date === date);
      const rec = data.recovery(state, today);
      const checkin = state.checkins.find(c => c.date === date) || null;
      const signals = personal(hp);
      return ok({
        date, today, plan: state.plan.name, phase: sched?.phase,
        adjusted_today: sched?.today.adjust ? { how: sched.today.adjust, reasons: sched.today.reasons } : null,
        day: day ? { ...day, session: slimSession(day.session) } : `No day ${date} in the next 14 days.`,
        gate: date === today ? todayGate(state, sched, today) : undefined,
        signal_actions: checkin ? signals.map(s => ({ signal: s.label, value: checkin[s.key], action: levelActions(s, checkin[s.key]) })).filter(x => x.action) : undefined,
        recovery: rec && { status: rec.status, why: rec.status_why, source: rec.source, latest: rec.latest_date, readiness: rec.readiness_today,
          last_night: rec.last_night, flags: rec.flags, rest_mode: rec.rest_mode },
        checkin: checkin || (date === today ? { missing: true, scales: [...BASE, ...signals].map(scaleFor), also: "pain_where, bp (e.g. 128/82), notes" } : null),
      });
    },
  },
  {
    name: "get_schedule",
    title: "The next days",
    description: "The rolling plan as the engine lays it out (after recovery, check-ins, signals, the log and overrides): one line per exercise with sets, reps and loads, and why each day is what it is.",
    inputSchema: { type: "object", properties: { days: { type: "integer", description: "1–14, default 14." } } },
    annotations: READ,
    run: (input, ctx) => {
      const { data, today } = ctx;
      if (!data.exists()) return notSetUp(ctx);
      const n = Math.max(1, Math.min(14, Number(input.days) || 14));
      const c = compactSchedule(data.schedule(data.load(today), today));
      return ok(c ? { ...c, days: c.days.slice(0, n) } : "No plan laid out (no plan, or a doctor's go-ahead is needed: see status).");
    },
  },
  {
    name: "get_plan",
    title: "The plan as written",
    description: "The plan's direction: program text, schedule settings (rolling), routines, upcoming overrides, the shared routines and personal calibration tests, recent changes, and the formats propose_changes takes.",
    inputSchema: { type: "object", properties: {} },
    annotations: READ,
    run: (_i, ctx) => {
      const { data, today } = ctx;
      if (!data.exists()) return notSetUp(ctx);
      const state = data.load(today);
      return ok({
        plan: state.plan, shared_routines: Object.keys(state.sharedRoutines),
        calibration: { personal: state.calibration, batteries: Object.keys(mergeCatalogue(data.cat.assessments, state.calibration).batteries || {}) },
        recent_changes: state.changeLog.slice(-10), formats: FORMATS,
      });
    },
  },
  {
    name: "find_exercises",
    title: "Find exercises",
    description: "Library exercises this person can do for a movement pattern, best fit first (goals, baseline focus, emphasis, their conditions' preferred exercises, their own adaptations, level; never equipment). Shows each one's level, fit score, what it loads the way they do it, and whether their equipment allows it. Set include_caution to also list exercises with a caution stress (a plan may name those in a slot's \"from\" list).",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "A library pattern, e.g. push_h, hinge, core_rot." },
        purpose: { type: "string", description: "Optional purpose to rank for, e.g. strength, posture, rehab." },
        include_caution: { type: "boolean" },
        no_equipment: { type: "boolean", description: "Only what works with household items." },
      },
      required: ["pattern"],
    },
    annotations: READ,
    run: (input, ctx) => {
      const { data, today } = ctx;
      const lib = data.cat.lib;
      if (!lib.data.patterns[input.pattern]) return fail(`Unknown pattern "${input.pattern}". Patterns: ${Object.keys(lib.data.patterns).join(", ")}`);
      const state = data.exists() ? data.load(today) : null;
      const who = lib.person(state?.profile.health_profile || {}, state?.profile.equipment || {}, state?.profile.goals || {});
      const gear = input.no_equipment ? who.household : who.equipment;
      const slot = input.purpose ? { purpose: input.purpose } : {};
      const list = lib.data.exercises.filter(e => e.pattern === input.pattern)
        .filter(e => lib.usable(e, gear, who.avoid, 5, input.include_caution ? [] : who.caution, who))
        .map(e => ({ id: e.id, name: e.name, level: e.level, family: e.family, fit: lib.fit(e, who, slot),
          loads: [...lib.stresses(e, who, gear)], caution: [...lib.stresses(e, who, gear)].filter(s => who.caution.has(s)),
          above_level_cap: e.level > who.max_level, has_their_adaptation: lib.adaptationsFor(e, who).length > 0, unit: e.unit || "reps" }))
        .sort((a, b) => b.fit - a.fit || a.level - b.level).slice(0, 20);
      return ok({ pattern: input.pattern, level_cap: who.max_level, exercises: list });
    },
  },
  {
    name: "get_exercise",
    title: "One exercise",
    description: "One library exercise in full: cues, stresses, equipment, unit, its progression ladder (family), and this person's adaptations for it.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    annotations: READ,
    run: (input, ctx) => {
      const { data, today } = ctx;
      const lib = data.cat.lib;
      const ex = lib.get(input.id);
      if (!ex) return fail(`No exercise "${input.id}" in the library. find_exercises lists them by pattern.`);
      const state = data.exists() ? data.load(today) : null;
      const who = lib.person(state?.profile.health_profile || {}, state?.profile.equipment || {}, state?.profile.goals || {});
      return ok({ ...ex, loads_their_way: [...lib.stresses(ex, who, who.equipment)], their_adaptations: lib.adaptationsFor(ex, who),
        usable_with_their_equipment: lib.hasEquipment(ex, who.equipment), ladder: lib.ladder(ex.id).map(e => `${e.id} (L${e.level})`) });
    },
  },
  {
    name: "log_workout",
    title: "Log a session",
    description: "Record a session: one entry per exercise. The next loads, ladders and the rotation follow from it, so use the session title and exercise names as today or get_schedule show them. Saving the same date and session again replaces it; an empty exercise list deletes it.",
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "YYYY-MM-DD; default today." },
        session: { type: "string", description: "The session's title as laid out (e.g. \"Full body A\"), or a name for anything else (\"Easy walk\")." },
        duration_min: { type: "number" },
        exercises: {
          type: "array",
          items: {
            type: "object",
            properties: {
              exercise: { type: "string", description: "The exercise name as laid out." },
              sets: { type: "string", description: "Number of sets, e.g. \"3\"." },
              reps: { type: "string", description: "Per set, e.g. \"12/12/11\" (or one number if all the same); seconds for holds." },
              load_kg: { type: "string", description: "Per hand for dumbbells; \"\" for bodyweight." },
              rpe: { type: "string", description: "Effort 1–10 of the hardest set." },
              pain: { type: "string", description: "Pain 0–10 during or after, if any." },
              notes: { type: "string" },
            },
            required: ["exercise"],
          },
        },
      },
      required: ["session", "exercises"],
    },
    annotations: WRITE,
    run: (input, ctx) => {
      const { data, today } = ctx;
      if (!data.exists()) return notSetUp(ctx);
      const date = DATE.test(String(input.date || "")) ? String(input.date) : today;
      if (date > today) return fail("That date is in the future: log a session once it's done.");
      if (!String(input.session || "").trim()) return fail("session is required.");
      if (!Array.isArray(input.exercises)) return fail("exercises must be a list.");
      const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));
      const exercises = input.exercises.map((e: Obj) => ({ exercise: str(e.exercise).trim(), sets: str(e.sets), reps: str(e.reps), load_kg: str(e.load_kg),
        rpe: str(e.rpe), pain: str(e.pain), notes: str(e.notes) }));
      data.saveWorkout({ date, session: String(input.session).trim(), duration_min: str(input.duration_min), exercises });
      const sched = data.rebuild(today);
      const next = sched?.days.find(d => d.date > date && d.session);
      const pain = exercises.filter((e: Obj) => Number(e.pain) >= 4).map((e: Obj) => e.exercise);
      return ok({ saved: { date, session: input.session, exercises: exercises.filter((e: Obj) => e.exercise).length },
        next_session: next ? { date: next.date, title: next.title, intensity: next.intensity, reasons: next.reasons } : null,
        note: pain.length ? `Pain 4+ logged for ${pain.join(", ")}: ask how it is now, and consider knowledge("medical").` : undefined });
    },
  },

  // ---------- recovery, sleep and balance ----------
  {
    name: "recovery",
    title: "Recovery and sleep",
    description: "The recovery picture: green, amber or red and why; readiness, HRV, resting heart rate and sleep against their usual; last night; Oura Rest Mode; a day-by-day trend; and the check-in scales' 7-day averages against the two weeks before.",
    inputSchema: { type: "object", properties: { days: { type: "integer", description: "Days of trend, 7–60, default 14." } } },
    annotations: READ,
    run: (input, ctx) => {
      const { data, today } = ctx;
      if (!data.exists()) return notSetUp(ctx);
      const state = data.load(today);
      const n = Math.max(7, Math.min(60, Number(input.days) || 14));
      const src = recoverySource(state);
      const rec = data.recovery(state, today) || (src ? recoveryOf(src[1], src[0], today) : null);
      return ok({ today, recovery: rec, trend: src ? { source: src[0], days: trendDays(src[1], today, n) } : null,
        checkins: checkinTrend(state, today),
        note: src ? undefined : "No wearable data. Recovery rests on the check-ins alone." });
    },
  },
  {
    name: "save_checkin",
    title: "Save a check-in",
    description: "Save the daily check-in: the common scales (mood, energy, stress, motivation, soreness 1–5; pain 0–10) and the person's own signals (keys and ranges in today's checkin.scales). Values given again for the same day replace the earlier ones; the rest are kept. Returns what it changes about today.",
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "YYYY-MM-DD; default today." },
        values: { type: "object", description: "Scale key → number, e.g. {\"mood\": 4, \"stress\": 2, \"pain\": 1}.", additionalProperties: { type: "number" } },
        pain_where: { type: "string" },
        bp: { type: "string", description: "Home blood pressure, e.g. \"128/82\"." },
        notes: { type: "string" },
      },
      required: ["values"],
    },
    annotations: WRITE,
    run: (input, ctx) => {
      const { data, today } = ctx;
      if (!data.exists()) return notSetUp(ctx);
      const date = DATE.test(String(input.date || "")) ? String(input.date) : today;
      if (date > today) return fail("A check-in is for today or an earlier day.");
      const hp = data.profileDoc("health_profile");
      const scales = [...BASE, ...personal(hp)];
      const values = (input.values && typeof input.values === "object") ? input.values as Obj : {};
      const errs: string[] = [];
      for (const [k, v] of Object.entries(values)) {
        const s = scales.find(x => x.key === k);
        if (!s) { errs.push(`"${k}" isn't a scale (${scales.map(x => x.key).join(", ")})`); continue; }
        const n = Number(v);
        if (!Number.isFinite(n) || n < s.lo || n > s.hi) errs.push(`${k} must be ${s.lo}–${s.hi}`);
      }
      if (input.bp && !/^\d{2,3}\s*\/\s*\d{2,3}$/.test(String(input.bp))) errs.push("bp must look like 128/82");
      if (errs.length) return fail("Not saved: " + errs.join("; ") + ".");
      const old = data.rows(join(data.p.records, "checkins.csv")).find(r => r.date === date) || {};
      const row: Obj = { ...old, date };
      for (const [k, v] of Object.entries(values)) row[k] = String(Number(v));
      if (input.pain_where !== undefined) row.pain_where = String(input.pain_where);
      if (input.bp !== undefined) row.bp = String(input.bp).replace(/\s/g, "");
      if (input.notes !== undefined) row.notes = String(input.notes);
      data.saveCheckin(row);
      const sched = data.rebuild(today);
      const state = data.load(today);
      const day = sched?.days.find(d => d.date === date);
      const actions = personal(hp).map(s => ({ signal: s.label, value: row[s.key], action: levelActions(s, row[s.key]), stop: s.stop })).filter(x => x.action);
      return ok({
        saved: row,
        today: date === today && sched ? { adjusted: sched.today.adjust, reasons: sched.today.reasons, day: day && { kind: day.kind, title: day.title, intensity: day.intensity, reasons: day.reasons } } : undefined,
        gate: date === today ? todayGate(state, sched, today) : undefined,
        signal_actions: actions.length ? actions : undefined,
        note: Number(row.pain) >= 6 ? "Pain 6+ makes today a recovery day. Ask where and what kind; check knowledge(\"medical\") for red flags." : undefined,
      });
    },
  },
  {
    name: "get_history",
    title: "Logs",
    description: "Logged data: workouts (one row per exercise), check-ins, calibration results, the wearable's daily rows, or the plan's change log.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["workouts", "checkins", "calibration", "wearable", "changes"] },
        days: { type: "integer", description: "How far back, default 42." },
      },
      required: ["kind"],
    },
    annotations: READ,
    run: (input, ctx) => {
      const { data, today } = ctx;
      if (!data.exists()) return notSetUp(ctx);
      const state = data.load(today);
      const since = addDays(today, -(Number(input.days) || 42));
      switch (input.kind) {
        case "workouts": return ok(workoutRows(state).filter(r => r.date >= since));
        case "checkins": return ok(state.checkins.filter(c => c.date >= since));
        case "calibration": return ok(state.assessments);
        case "wearable": return ok(Object.fromEntries(Object.entries(state.daily).map(([k, v]) => [k, v.filter(r => r.date >= since)])));
        case "changes": return ok(data.changeLog(50).filter(c => c.at.slice(0, 10) >= since));
      }
      return fail(`Unknown kind "${input.kind}".`);
    },
  },
  {
    name: "read_report",
    title: "Read a report",
    description: "One of the longer reports the desktop app writes: snapshot (today's numbers), trends, baseline (the calibration's measured starting point), analysis (the multi-month analysis), clinical_summary (the medical records summary from Apple Health). Missing ones say so.",
    inputSchema: { type: "object", properties: { name: { type: "string", enum: REPORTS } }, required: ["name"] },
    annotations: READ,
    run: (input, ctx) => {
      const { data } = ctx;
      if (!data.exists()) return notSetUp(ctx);
      if (!REPORTS.includes(input.name)) return fail(`Reports: ${REPORTS.join(", ")}.`);
      const path = join(data.p.records, `${input.name}.md`);
      return existsSync(path) ? ok(readFileSync(path, "utf8")) : ok(`No ${input.name} report yet (the desktop app writes it: \`python sylvester.py daily\`, the calibration, or the health-analyst).`);
    },
  },

  // ---------- profile and reference ----------
  {
    name: "get_profile",
    title: "Health profile, equipment, goals",
    description: "The person's health profile (conditions, injuries, medications, restrictions, screening, signals, limits, coaching focus, their own ways of doing exercises, preferences), equipment with the loads it allows, and goals.",
    inputSchema: { type: "object", properties: {} },
    annotations: READ,
    run: (_i, ctx) => {
      const { data } = ctx;
      if (!data.exists()) return notSetUp(ctx);
      return ok({ health_profile: data.profileDoc("health_profile"), equipment: data.profileDoc("equipment"), goals: data.profileDoc("goals") });
    },
  },
  {
    name: "knowledge",
    title: "Coaching reference",
    description: "A reference module: medical (conditions, medications, injuries, red flags), recovery (signals, deloads, sleep), training (program design, progression, HR zones), exercise_library (choosing, mixing and progressing exercises), balance (stress, mood, motivation, sustainability).",
    inputSchema: { type: "object", properties: { module: { type: "string", enum: KNOWLEDGE } }, required: ["module"] },
    annotations: READ,
    run: (input, ctx) => {
      const k = ctx.data.cat.knowledge[input.module];
      return k ? ok(k.replace(/`?<data>\/([^\s`]*)`?/g, "their $1 (in the data folder)")) : fail(`Modules: ${KNOWLEDGE.join(", ")}.`);
    },
  },

  // ---------- changing the plan ----------
  {
    name: "propose_changes",
    title: "Propose plan changes",
    description: "Propose changes to the plan or profile. Local checks run at once; if they block, nothing is saved and this returns what to fix. Otherwise it returns a proposal id, whether a safety review is needed (anything but a rest day or going back to the regular plan), and anything the person must confirm themselves. Change types: new_plan {plan: {name, program, rolling, routines, overrides}}, set_rolling {rolling}, set_routine {key, routine}, remove_routine {key}, set_override {date, override}, clear_override {date}, set_program {program}, set_limits {limits}, set_coaching {coaching}, set_adaptations {adaptations} (the full list), set_signals {signals} (the full list), set_goals {goals} (the full list), set_load_steps {load_steps}, set_calibration {calibration: {tests, batteries}}. Formats: get_plan.",
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "One line: what changes." },
        why: { type: "string", description: "Two or three sentences: what changes and the data behind it." },
        changes: { type: "array", items: { type: "object" }, description: "Each {type, ...fields}." },
      },
      required: ["summary", "why", "changes"],
    },
    annotations: WRITE,
    run: (input, ctx) => {
      const { data, today } = ctx;
      if (!data.exists()) return notSetUp(ctx);
      const errs = shapeErrors(input.changes);
      if (!errs.length) {
        (input.changes as Obj[]).forEach((c, i) => {
          if ((c.type === "set_routine" || c.type === "remove_routine") && !SAFE_ID.test(c.key)) errs.push(`changes[${i}]: routine key "${c.key}" must be letters, digits, - or _`);
          if (c.type === "new_plan") for (const k of Object.keys(c.plan?.routines || {})) if (!SAFE_ID.test(k)) errs.push(`changes[${i}]: routine key "${k}" must be letters, digits, - or _`);
          if (c.type === "new_plan") for (const d of Object.keys(c.plan?.overrides || {})) if (!DATE.test(d)) errs.push(`changes[${i}]: override "${d}" must be a YYYY-MM-DD date`);
        });
      }
      if (errs.length) return fail("Not saved. Fix the format:\n- " + errs.join("\n- "));
      const changes = input.changes as Change[];
      const state = data.load(today);
      const { blocking, warnings, confirm } = checkChanges(state, changes, data.cat.lib, today);
      if (blocking.length) {
        return fail("Not saved: the local checks block it. Fix these and propose again:\n- " + blocking.join("\n- ")
          + (warnings.length ? "\nAlso (warnings):\n- " + warnings.join("\n- ") : ""));
      }
      const p = {
        id: `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, created: localStamp(),
        summary: String(input.summary || "Changes"), why: String(input.why || ""), changes, lines: changes.map(describe),
        review: needsReview(changes), confirm, warnings, status: "pending",
      };
      data.saveProposal(p);
      return ok({
        id: p.id, changes: p.lines, review_needed: p.review, warnings: warnings.length ? warnings : undefined,
        person_must_confirm: confirm.length ? confirm : undefined,
        next: [
          p.review ? "Call review_brief, do the safety review as a separate step, then apply_proposal with the verdict." : "No safety review needed: apply_proposal once the person agrees.",
          confirm.length ? "It loosens their limits: show them the person_must_confirm lines and apply with confirmed: true only after they say yes themselves." : "",
          "Tell the person in two or three sentences what changes and why; don't paste the whole proposal.",
        ].filter(Boolean),
      });
    },
  },
  {
    name: "review_brief",
    title: "Safety review brief",
    description: "Everything the independent safety review of a proposal needs: the reviewer's instructions, the medical module, and the document (profile, current plan, the proposal, the plan after it, the library entries it uses, what each slot could pick, the next 14 days after it, recovery and check-ins). It is also saved as a file, so a separate reviewer (the safety-reviewer agent in Claude Code) can read it: there, pass file_only and give the agent the file.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        file_only: { type: "boolean", description: "Return only where the brief is saved and what it covers, not the brief itself (for a separate reviewer)." },
      },
      required: ["id"],
    },
    annotations: { ...READ, readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    run: (input, ctx) => {
      const { data, today } = ctx;
      if (!data.exists()) return notSetUp(ctx);
      const p = data.proposal(String(input.id));
      if (!p) return fail(`No proposal "${input.id}".`);
      if (p.status !== "pending") return fail(`Proposal ${p.id} is ${p.status}.`);
      const r = reviewDocument(data.load(today), p as never, data.cat.lib, today);
      if ("blocked" in r) return fail("The local checks block it now (the data has moved on):\n- " + r.blocked.blocking.join("\n- "));
      const file = join(data.p.proposals, `${p.id}.review.json`);
      const brief = { proposal: p.id, instructions: REVIEWER, answer_format: { verdict: "PASS | PASS WITH WARNINGS | BLOCK", blocking: ["..."], warnings: ["..."], missing_information: ["..."] },
        knowledge_medical: data.cat.knowledge.medical || "", document: r.doc };
      writeJson(file, brief);
      if (input.file_only === true) return ok({ proposal: p.id, file, summary: p.summary, changes: p.lines,
        warnings: r.warnings, how: "Give the file to the safety-reviewer agent with the data folder, then call apply_proposal with id and its review {verdict, blocking, warnings, missing_information, reviewer}." });
      return ok({ ...brief, file, how: "Review it as a cautious reviewer who didn't write it, then call apply_proposal with id and review {verdict, blocking, warnings, missing_information, reviewer}. In Claude Code, give the file to the safety-reviewer agent and pass its verdict." });
    },
  },
  {
    name: "apply_proposal",
    title: "Apply a proposal",
    description: "Apply a proposal the person has agreed to: writes the plan and profile files, lays out the 14 days again and logs the change. Needs the safety review's verdict when the proposal needs one (a BLOCK is never applied), and confirmed: true when it loosens their limits and they said yes themselves. The checks run again first, against the data as it is now.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        review: {
          type: "object",
          description: "The safety review's answer.",
          properties: {
            verdict: { type: "string", enum: ["PASS", "PASS WITH WARNINGS", "BLOCK"] },
            blocking: { type: "array", items: { type: "string" } },
            warnings: { type: "array", items: { type: "string" } },
            missing_information: { type: "array", items: { type: "string" } },
            reviewer: { type: "string", description: "Who reviewed: \"safety-reviewer agent\" or \"in conversation\"." },
          },
          required: ["verdict"],
        },
        confirmed: { type: "boolean", description: "The person confirmed what the proposal loosens, themselves, in this conversation." },
      },
      required: ["id"],
    },
    annotations: REPLACE,
    run: (input, ctx) => {
      const { data, today } = ctx;
      if (!data.exists()) return notSetUp(ctx);
      const p = data.proposal(String(input.id));
      if (!p) return fail(`No proposal "${input.id}".`);
      if (p.status !== "pending") return fail(`Proposal ${p.id} is ${p.status}; propose again if it's still wanted.`);
      let verdict = input.review ? readVerdict(input.review) : null;
      if (input.review && !verdict) return fail("review.verdict must be PASS, PASS WITH WARNINGS or BLOCK.");
      if (p.review && !verdict) return fail("This proposal needs the safety review first: review_brief, then apply_proposal with its verdict.");
      if (verdict?.verdict === "BLOCK") {
        data.saveProposal({ ...p, status: "blocked", verdict: { ...verdict, reviewer: input.review?.reviewer || "" } });
        return fail("Blocked by the safety review; not applied:\n- " + (verdict.blocking.length ? verdict.blocking.join("\n- ") : "(no reason given)")
          + "\nTell the person why, fix it and propose again.");
      }
      if ((p.confirm || []).length && input.confirmed !== true) {
        return fail("It loosens their limits. Show the person these and apply with confirmed: true only after they say yes themselves:\n- " + p.confirm.join("\n- "));
      }
      const state = data.load(today);
      const { blocking } = checkChanges(state, p.changes, data.cat.lib, today);
      if (blocking.length) {
        data.saveProposal({ ...p, status: "blocked", verdict: { verdict: "BLOCK", blocking, warnings: [], missing_information: [] } });
        return fail("The checks block it now (the data has moved on); not applied:\n- " + blocking.join("\n- "));
      }
      // What the person confirmed is theirs now: their confirmed ways of doing exercises count in every check.
      const changes: Change[] = input.confirmed ? (p.changes as Change[]).map(c => c.type !== "set_adaptations" ? c : { ...c, adaptations: c.adaptations.map(a =>
        /confirm/i.test(String(a.source || "")) && p.confirm.some((line: string) => a.how && line.includes(`"${a.how}"`))
          && !(state.profile.health_profile.adaptations || []).some((b: object) => JSON.stringify(b) === JSON.stringify(a))
          ? { ...a, source: `you (confirmed ${today})` } : a) }) : p.changes;
      const after = applyChanges(state, changes);
      const written = data.writeChanges(after, changes);
      const sched = data.rebuild(today);
      const v = verdict ? { ...verdict, reviewer: input.review?.reviewer || "" } : null;
      data.logChange({ at: localStamp(), summary: p.summary, verdict: v ? `${v.verdict}${v.reviewer ? ` (${v.reviewer})` : ""}` : "no review needed", changes: p.lines, proposal: p.id });
      data.saveProposal({ ...p, status: "applied", applied: localStamp(), verdict: v });
      const day = sched?.days.find(d => d.date === today);
      return ok({
        applied: p.summary, files: written.map(f => relative(data.p.data, f.replace(/ \(removed\)$/, "")) + (f.endsWith("(removed)") ? " (removed)" : "")),
        today: day ? { title: day.title, kind: day.kind, intensity: day.intensity } : null,
        warnings: [...(p.warnings || []), ...(v?.warnings || [])],
        note: "The phone page picks this up at the next daily update (or a sync from the desktop app).",
      });
    },
  },
];

export function callTool(name: string, input: Obj): ToolResult {
  const t = TOOLS.find(x => x.name === name);
  if (!t) return fail(`Unknown tool ${name}.`);
  try {
    return t.run(input || {}, ctxFor());
  } catch (e) {
    return fail(`The tool failed: ${(e as Error).message}`);
  }
}
