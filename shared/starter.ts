// A starter plan that needs no Coach: two full-body routines and a mobility routine from the library's session
// mixes. Exercises are picked by the engine through the person's own limits, equipment and level cap (a slot never
// picks an avoided or caution stress), plus each mix's own limits, and never anything with impact or jumping. A mix's
// fixed exercise (the McGill big three, the blood-pressure wall sit) is used only where it carries none of the
// person's avoid or caution stresses; otherwise it becomes a slot like the rest. Main lifts hold for the whole plan, so
// they're learned before they're loaded. It's generic: the Coach (or the calibration) replaces it.
//
// Not offered at all until a needed doctor's go-ahead is recorded (clearance.ts).

import type { ExerciseLibrary } from "./engine/library.ts";
import type { Obj, PlanDoc, Routine } from "./engine/types.ts";
import { addDays, weekday } from "./engine/util.ts";
import { needsClearance } from "./clearance.ts";

const REPS = { reps: "8–12", s: "20–30", m: "20–30", min: "10–15" };
const CORE = { reps: "6–10", s: "20–30", m: "20–30", min: "5" };
const EASY_PACE = "Easy pace: breathing harder, but you can still talk in sentences. Finish with 5 minutes of slow walking.";
const STARTER_AVOID = ["impact", "ballistic"]; // no jumping or running before a plan written for them
const WEEKDAYS: Record<number, string[]> = { 2: ["mon", "thu"], 3: ["mon", "wed", "fri"], 4: ["mon", "tue", "thu", "fri"] };
const MAIN_WEEKS = 12; // the whole starter plan: learned before they're loaded, never changed mid-plan

const RED_FLAGS = [
  "## Stop and get help",
  "",
  "Stop the session and get medical help for chest pain or pressure, pain spreading to the arm or jaw, breathlessness out of proportion to the effort, palpitations or an irregular heartbeat, dizziness or fainting, a sudden severe headache, weakness or numbness on one side or slurred speech, or calf pain with swelling. Chest pain, fainting or stroke signs: call emergency services.",
  "",
  "Stop an exercise that causes sharp pain, new joint pain or swelling, or that sends symptoms down an arm or leg. Don't hold your breath: breathe out on every effort.",
];

function conditionLines(hp: Obj): string[] {
  const conds: string[] = hp.limits?.conditions || [];
  const meds = (hp.medications || []).map((m: Obj) => String(m.name || "")).join(" ").toLowerCase();
  const out: string[] = [];
  if (conds.some(c => c.startsWith("lumbar"))) out.push("- Back: stop anything that sends symptoms further down the leg. New leg numbness or weakness: stop and get it checked. Numbness in the groin or saddle area, or a new bladder or bowel change: emergency department, now.");
  if (conds.includes("hypertension") || conds.includes("heart")) out.push("- Blood pressure: if you measure at home, train as planned under 160/100; at 160–179 / 100–109 only easy walking and mobility; at 180/110 or higher no exercise, and contact your doctor. Effort stays at 8 out of 10 or less, and cool down for 5–10 minutes.");
  if (conds.includes("pregnancy")) out.push("- Pregnancy: stop for vaginal bleeding, fluid leaking, regular painful contractions, dizziness, headache, chest pain, calf pain or swelling, or reduced baby movements, and contact your care provider.");
  if (/olol\b|beta.?block/.test(meds)) out.push("- Your medicine may blunt your heart rate: go by effort (talk test), not heart-rate zones.");
  if (/insulin|glipizide|glimepiride|glyburide|glibenclamide|gliclazide|sulfonyl/.test(meds)) out.push("- Low blood sugar risk: keep fast carbohydrate at hand, check your glucose before training, and don't train hard fasted.");
  if (/pril\b|sartan\b/.test(meds)) out.push("- Get up slowly from the floor and benches; your medicine can make you light-headed.");
  for (const x of hp.injuries || []) {
    if (x.status === "active — hurts now" || Number(x.pain_now) >= 4) out.push(`- Your ${String(x.area || "ache").toLowerCase()} hurts now: the plan works around it, but get it assessed if it isn't being treated. Any exercise near it may cause at most 3/10 pain, settled by the next morning; otherwise stop it.`);
  }
  return out;
}

function routineFromMix(lib: ExerciseLibrary, mix: Obj, title: string, who: ReturnType<ExerciseLibrary["person"]>): Routine {
  const mixAvoid = [...new Set([...(mix.avoid || []), ...STARTER_AVOID])];
  const exercises = mix.slots.map((s: Obj) => {
    const sets = s.role === "main" ? 3 : 2;
    const reps = s.pattern.startsWith("core") || s.purpose === "core" ? CORE : REPS;
    const fixed = s.exercise ? lib.get(s.exercise) : undefined;
    if (fixed) {
      const loads = lib.stresses(fixed, who, who.equipment);
      const safe = lib.usable(fixed, who.equipment, [...who.avoid, ...mixAvoid], who.max_level, who.caution, who)
        && ![...loads].some(x => who.caution.has(x));
      if (safe) {
        const bp = s.purpose === "bp";
        return { ex: fixed.id, sets: bp ? 4 : sets, reps: bp ? "60–120" : (fixed.unit === "s" ? reps.s : fixed.unit === "min" ? reps.min : reps.reps),
          rest: bp ? "2 min" : "60 s", ...(bp ? { note: "Hard but steady; build towards 2 minutes. Breathe throughout." } : {}),
          ...(s.pattern === "conditioning" ? { note: EASY_PACE } : {}) };
      }
    }
    const conditioning = s.pattern === "conditioning";
    return {
      slot: { pattern: s.pattern, purpose: s.purpose, every_weeks: s.role === "main" ? MAIN_WEEKS : 3, avoid: mixAvoid,
        ...(mix.caution ? { caution: mix.caution } : {}), ...(conditioning ? { max_level: 2 } : {}) },
      sets, reps, rest: s.role === "main" ? "90 s" : "60 s", ...(conditioning ? { note: EASY_PACE } : {}),
    };
  });
  return {
    title, focus: mix.title, duration: `${mix.minutes || 45} min`,
    coach_note: "Starter plan: every set stops with 2–3 reps in reserve. Breathe out on every effort; never hold your breath.",
    warmup: ["5–8 min easy walking, cycling or marching on the spot", "A light first set of each of the first two exercises"],
    exercises,
  };
}

export function starterPlan(lib: ExerciseLibrary, healthProfile: Obj, equipment: Obj, goals: Obj, today: string): PlanDoc | null {
  if (needsClearance(healthProfile).length) return null;
  const mixes: Obj[] = lib.data.mixes;
  const mix = (id: string) => mixes.find(m => m.id === id)!;
  const who = lib.person(healthProfile, equipment, goals);
  const conditions: string[] = healthProfile.limits?.conditions || [];
  const back = conditions.some(c => c.startsWith("lumbar"));
  const bp = conditions.includes("hypertension") || conditions.includes("heart");
  const days = Math.min(4, Math.max(2, Number(healthProfile.lifestyle?.days_per_week) || 3));
  const monday = addDays(today, (7 - weekday(today)) % 7);
  const routines: Record<string, Routine> = {
    a: routineFromMix(lib, mix(back ? "back_friendly" : "full_body_strength"), "Full body A", who),
    b: routineFromMix(lib, mix(bp ? "bp_friendly" : "upper_lower_lower"), "Full body B", who),
    mobility: { ...routineFromMix(lib, mix("mobility_reset"), "Mobility reset", who), coach_note: "Easy, unhurried, pain-free ranges only." },
  };
  return {
    name: "starter",
    program: [
      "# Starter plan",
      "",
      "A general plan to start with while there's no plan written for you. Every exercise is picked from the library by your limits, your equipment and your level, and the accessories rotate every few weeks. Nothing with jumping or running.",
      "",
      `- ${days} sessions a week, full body, alternating A and B.`,
      "- Weeks 1–4: learn the movements, two sets each, effort up to 7 out of 10. Weeks 5–7: build, up to 8 out of 10. Week 8 is lighter. The main lifts stay the same throughout.",
      "- A load goes up one step only after you reach the top of the rep range on every set with the effort you logged within that phase's limit; with pain or a very hard set it stays or comes down.",
      ...conditionLines(healthProfile),
      "",
      ...RED_FLAGS,
      "",
      "Do the calibration (Plan tab), then ask the Coach for a plan written for you.",
    ].join("\n"),
    rolling: {
      start: monday,
      weekdays: WEEKDAYS[days],
      rotation: ["a", "b"],
      rest_day: { title: "Rest or easy walk", note: "20–40 min easy walk" },
      recovery_routine: "mobility",
      min_rest_days: 1,
      phases: [
        { name: "Learn", weeks: 4, rpe_cap: 7, sets_max: 2 },
        { name: "Build", weeks: 3, rpe_cap: 8 },
        { name: "Deload", weeks: 1, deload: true, rpe_cap: 6 },
        { name: "Build 2", weeks: 3, rpe_cap: 8 },
        { name: "Deload and review", weeks: 1, deload: true, rpe_cap: 6 },
      ],
      rules: { hard_rpe: 9, easy_rpe: 7, pain_stop: 3 },
    },
    routines,
    overrides: {},
  };
}

export { RED_FLAGS };
