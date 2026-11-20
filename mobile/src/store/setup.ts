// The phone's setup: the same questions as the desktop wizard (app/setup.html), turned into the same profile,
// equipment and goals files. Limits start from the library's condition guidance plus each ache's triggers; the
// Coach refines them with the person afterwards.

import type { Library, Obj } from "../engine/types.ts";
import type { AppState } from "./model.ts";

export const DISCLAIMER = "Sylvester's Coach is a training assistant, not a doctor or a medical device. It works only from what you and your records tell it, and it can be wrong. Share your plan with your doctor or physio, and stop and get help if something feels wrong: chest pain, dizziness, new numbness or weakness.";

export const AI_NOTICE = "When you use the Coach, what it needs to answer goes to Anthropic's Claude: your profile (including the health details you entered), equipment, goals, plan, check-ins, workouts, calibration results and recovery numbers. With an invite code it passes through the Sylvester server, which forwards it and keeps nothing. Everything else stays on this iPhone. You can use the plan, logging and Apple Health without the Coach.";

export const SCREEN: [string, string][] = [
  ["heart", "Has a doctor ever said you have a heart condition or high blood pressure?"],
  ["chest", "Do you get chest pain at rest, in daily life, or when you exercise?"],
  ["dizzy", "In the past year, have you lost your balance because of dizziness, or passed out?"],
  ["chronic", "Do you have another long-term medical condition, like diabetes, asthma or arthritis?"],
  ["meds", "Do you take prescribed medicine for a long-term condition?"],
  ["joints", "Do you have a bone, joint or muscle problem that more activity could make worse?"],
  ["supervised", "Has a doctor said you should only exercise under medical supervision?"],
];
export const SERIOUS = ["chest", "dizzy", "supervised"];

export const EXPERIENCE = ["none", "beginner (< 1 yr)", "returning after a long break", "intermediate (1–3 yrs)", "advanced (3+ yrs)"];

export const GEAR: [string, string][] = [
  ["dumbbells", "Dumbbells"], ["kettlebells", "Kettlebells"], ["barbell", "Barbell & plates"], ["rack", "Rack or squat stands"],
  ["bench", "Bench"], ["pullup", "Pull-up bar"], ["bands", "Resistance bands"], ["rings", "Rings or TRX"], ["cable", "Cable machine"],
  ["box", "Box or step"], ["recovery", "Mat & foam roller"], ["dip", "Dip station"], ["vest", "Weight vest"], ["ball", "Medicine ball"],
  ["landmine", "Landmine"],
];
export const CARDIO = ["Bike", "Rower", "Treadmill", "Elliptical", "Air bike", "Jump rope"];

export const GOALS: [string, string, string][] = [
  ["strength", "Get stronger", "strength"], ["muscle", "Build muscle", "muscle"], ["fat", "Lose fat", "fat loss"],
  ["cardio", "Better stamina", "endurance / cardio"], ["pain", "Move without pain", "rehab / pain-free (back, injury)"],
  ["mobility", "Mobility & flexibility", "mobility"], ["balance", "Balance & stability", "balance / stability"],
  ["health", "Stay healthy & energetic", "general health, blood pressure"],
];

export const SPOTS = ["Neck", "Shoulder", "Elbow", "Wrist or hand", "Upper back", "Lower back", "Hip", "Knee", "Ankle or foot"];
export const INJURY_STATUS: [string, string][] = [["active — hurts now", "Hurts now"], ["recovering", "Getting better"],
  ["healed, with limits", "Healed, with limits"], ["fully healed", "Fully healed"]];

/** Movements that make an ache worse (the list the person picks from). */
export const TRIGGERS = ["Squatting", "Stairs", "Running", "Jumping", "Reaching overhead", "Pushing", "Pulling", "Bending forward",
  "Lifting from the floor", "Twisting", "Kneeling", "Sitting long", "Standing long", "Gripping", "Lying on it", "Arching back", "Hanging"];

/** The library stresses behind a trigger, for that part of the body. */
export function triggerStresses(trigger: string, spot: string): string[] {
  const back = spot === "Lower back" || spot === "Upper back", foot = spot === "Ankle or foot";
  switch (trigger) {
    case "Squatting": return ["knee_deep", "hip_deep"];
    case "Stairs": return ["knee_deep", "step"];
    case "Running": return ["impact", "plantar"];
    case "Jumping": return ["impact", "ballistic", "plantar"];
    case "Reaching overhead": return ["overhead", "hanging", "shoulder_end"];
    case "Pushing": return spot === "Shoulder" ? ["shoulder_end", "wrist_ext", "overhead"] : ["shoulder_end", "wrist_ext"];
    case "Pulling": return back ? ["hanging", "grip_heavy", "spine_shear"] : ["hanging", "grip_heavy"];
    case "Bending forward": return ["spine_flex_loaded", "spine_flex_end", "spine_shear"];
    case "Lifting from the floor": return ["floor_lift"];
    case "Twisting": return ["spine_rot_loaded"];
    case "Kneeling": return ["kneeling"];
    case "Sitting long": return ["spine_flex_end", "hip_deep"];
    case "Standing long": return foot ? ["plantar"] : back ? ["spine_ext_end"] : [];
    case "Gripping": return ["grip_heavy", "wrist_ext"];
    case "Lying on it": return ["supine", "prone", "side_lying"];
    case "Arching back": return ["spine_ext_end"];
    case "Hanging": return ["hanging"];
  }
  return [];
}

export interface Ache { spot: string; side: string; status: string; pain: string; triggers: string[]; notes: string }

export interface SetupAnswers {
  name: string;
  weight_kg: string;
  height_cm: string;
  experience: string;
  days_per_week: number;
  session_minutes: number;
  screening: Record<string, "yes" | "no" | "">;
  conditions: string[];           // library condition ids
  other_conditions: string;
  medications: string;
  aches: Ache[];
  gear: string[];                 // GEAR kinds
  cardio: string[];
  dumbbell_max_kg: string;
  dumbbell_step_kg: string;
  barbell_bar_kg: string;
  barbell_max_kg: string;
  goals: string[];                // GOALS ids, in priority order
  goal_targets: Record<string, string>;
}

export function blankAnswers(): SetupAnswers {
  return { name: "", weight_kg: "", height_cm: "", experience: "", days_per_week: 3, session_minutes: 45, screening: {}, conditions: [], other_conditions: "",
    medications: "", aches: [], gear: [], cardio: [], dumbbell_max_kg: "", dumbbell_step_kg: "2.5", barbell_bar_kg: "20",
    barbell_max_kg: "", goals: [], goal_targets: {} };
}

/** Loads the equipment allows: dumbbells per hand from the step up to the heaviest; barbell totals in 5 kg steps. */
export function loadSteps(a: SetupAnswers): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  const dmax = Number(a.dumbbell_max_kg), dstep = Number(a.dumbbell_step_kg) || 2.5;
  if (a.gear.includes("dumbbells") && dmax > 0) {
    out.dumbbell = [];
    for (let w = dstep; w <= dmax + 1e-9 && out.dumbbell.length < 80; w += dstep) out.dumbbell.push(Math.round(w * 10) / 10);
  }
  const bar = Number(a.barbell_bar_kg) || 20, bmax = Number(a.barbell_max_kg);
  if (a.gear.includes("barbell") && bmax > bar) {
    out.barbell = [];
    for (let w = bar; w <= bmax + 1e-9 && out.barbell.length < 80; w += 5) out.barbell.push(w);
  }
  return out;
}

/** Answers prefilled from what setup wrote before (for "Run setup again"). */
export function answersFrom(state: AppState): SetupAnswers {
  const hp = state.profile.health_profile, a = blankAnswers();
  const mine = (xs: unknown) => (Array.isArray(xs) ? xs : []).filter((x: Obj) => x?.source === "setup");
  a.name = hp.name || "";
  a.weight_kg = hp.basics?.weight_kg ? String(hp.basics.weight_kg) : "";
  a.height_cm = hp.basics?.height_cm ? String(hp.basics.height_cm) : "";
  a.experience = hp.training_background?.experience || "";
  a.days_per_week = Number(hp.lifestyle?.days_per_week) || 3;
  a.session_minutes = Number(hp.lifestyle?.session_minutes) || 45;
  a.screening = hp.screening?.answers || {};
  a.conditions = mine(hp.conditions).map((c: Obj) => c.id).filter(Boolean);
  a.other_conditions = mine(hp.conditions).filter((c: Obj) => !c.id).map((c: Obj) => c.name).join(", ");
  a.medications = mine(hp.medications).map((m: Obj) => m.name).join(", ");
  a.aches = mine(hp.injuries).map((x: Obj) => ({ spot: x.area, side: x.side || "", status: x.status || "",
    pain: x.pain_now == null ? "" : String(x.pain_now), triggers: x.triggers || [], notes: x.notes || "" }));
  const items = mine(state.profile.equipment.items);
  a.gear = items.filter((i: Obj) => i.kind !== "cardio").map((i: Obj) => i.kind);
  a.cardio = items.filter((i: Obj) => i.kind === "cardio").map((i: Obj) => i.name);
  const steps = state.profile.equipment.load_steps || {};
  if (steps.dumbbell?.length) { a.dumbbell_max_kg = String(Math.max(...steps.dumbbell)); a.dumbbell_step_kg = String(steps.dumbbell[0]); }
  if (steps.barbell?.length) { a.barbell_bar_kg = String(steps.barbell[0]); a.barbell_max_kg = String(Math.max(...steps.barbell)); }
  const goals = mine(state.profile.goals.goals);
  a.goals = goals.map((g: Obj) => GOALS.find(x => x[1] === g.title)?.[0]).filter(Boolean) as string[];
  a.goal_targets = Object.fromEntries(goals.map((g: Obj) => [GOALS.find(x => x[1] === g.title)?.[0] || "", g.target || ""]));
  return a;
}

export function applySetup(state: AppState, a: SetupAnswers, library: Library, today: string): AppState {
  const hp: Obj = JSON.parse(JSON.stringify(state.profile.health_profile));
  const avoid = new Set<string>(hp.limits?.avoid || []), caution = new Set<string>(hp.limits?.caution || []);
  // Conditions typed rather than ticked still count where they matter most.
  const typed = `${a.other_conditions} ${a.medications}`.toLowerCase();
  const conditions = [...a.conditions];
  const typedAs = (id: string, re: RegExp) => { if (re.test(typed) && !conditions.includes(id)) conditions.push(id); };
  typedAs("pregnancy", /pregnan|expecting a baby/);
  typedAs("heart", /angina|heart failure|atrial|\baf\b|afib|arrhythm|cardiomyopath|heart attack|infarct|\bstent|bypass|pacemaker|valve|nitroglycerin|isosorbide|\bgtn\b/);
  typedAs("hypertension", /blood pressure|hypertens|amlodipine|nifedipine|\w+pril\b|\w+sartan\b|metoprolol|bisoprolol|atenolol|nebivolol|hydrochlorothiazide|chlorthalidone|indapamide/);
  typedAs("diabetes", /diabet/);
  a = { ...a, conditions };
  for (const c of a.conditions) {
    const g = library.conditions[c];
    for (const s of g?.avoid || []) avoid.add(s);
    for (const s of g?.caution || []) caution.add(s);
  }
  for (const ache of a.aches) {
    const hurts = ache.status === "active — hurts now" || Number(ache.pain) >= 4;
    for (const tr of ache.triggers) for (const s of triggerStresses(tr, ache.spot)) (hurts ? avoid : caution).add(s);
  }
  // The health-check heart question also covers high blood pressure: no straining under load either way, and the
  // heart condition's own guidance unless they said it's blood pressure only.
  if (a.screening.heart === "yes") {
    avoid.add("high_pressure");
    if (!a.conditions.includes("hypertension")) for (const s of library.conditions.heart?.caution || []) caution.add(s);
  }
  // Ground impact scales with bodyweight (coach/knowledge/medical.md): BMI 30 or more keeps jumping and running out of picks.
  const kg = Number(a.weight_kg), m = Number(a.height_cm) / 100;
  if (kg > 0 && m > 0 && kg / (m * m) >= 30) { caution.add("impact"); caution.add("ballistic"); }
  for (const s of avoid) caution.delete(s);
  hp.name = a.name || hp.name || "";
  hp.basics = { ...(hp.basics || {}), ...(a.weight_kg ? { weight_kg: Number(a.weight_kg) } : {}), ...(a.height_cm ? { height_cm: Number(a.height_cm) } : {}) };
  hp.onboarding = { ...(hp.onboarding || {}), disclaimer_accepted: state.settings.consent.disclaimer || today, completed: today, source: "app" };
  const before = hp.screening?.answers || {};
  if (["chest", "dizzy", "supervised"].some(k => a.screening[k] === "yes" && before[k] !== "yes") && hp.restrictions) {
    const { cleared_on: _o, cleared_for: _f, cleared_by: _b, ...rest } = hp.restrictions;
    hp.restrictions = rest;
  }
  hp.screening = { answers: a.screening, source: "setup" };
  // Setup replaces only what setup wrote; anything from the desktop or the Coach stays.
  const kept = (xs: unknown) => (Array.isArray(xs) ? xs : []).filter((x: Obj) => x && x.source !== "setup");
  hp.conditions = [...kept(hp.conditions),
    ...a.conditions.map(c => ({ name: library.conditions[c]?.label || c, id: c, source: "setup" })),
    ...a.other_conditions.split(/[,;\n]/).map(s => s.trim()).filter(Boolean).map(name => ({ name, source: "setup" })),
  ];
  hp.medications = [...kept(hp.medications), ...a.medications.split(/[,;\n]/).map(s => s.trim()).filter(Boolean).map(name => ({ name, source: "setup" }))];
  hp.injuries = [...kept(hp.injuries), ...a.aches.map(x => ({ area: x.spot, side: x.side, status: x.status, pain_now: x.pain ? Number(x.pain) : null,
    triggers: x.triggers, notes: x.notes, source: "setup" }))];
  hp.training_background = { ...(hp.training_background || {}), experience: a.experience };
  hp.lifestyle = { ...(hp.lifestyle || {}), days_per_week: a.days_per_week, session_minutes: a.session_minutes };
  hp.limits = { ...(hp.limits || {}), avoid: [...avoid].sort(), caution: [...caution].sort(),
    conditions: [...new Set([...(hp.limits?.conditions || []), ...a.conditions])] };
  hp.restrictions = hp.restrictions || {};
  const items: Obj[] = a.gear.map(kind => ({ name: GEAR.find(g => g[0] === kind)?.[1] || kind, kind, source: "setup",
    spec: kind === "dumbbells" && a.dumbbell_max_kg ? `up to ${a.dumbbell_max_kg} kg per hand` : kind === "barbell" && a.barbell_max_kg ? `${a.barbell_bar_kg || 20} kg bar, up to ${a.barbell_max_kg} kg` : "" }));
  for (const c of a.cardio) items.push({ name: c, kind: "cardio", spec: "", source: "setup" });
  const goals = a.goals.map((g, i) => {
    const def = GOALS.find(x => x[0] === g)!;
    return { title: def[1], type: def[2], target: a.goal_targets[g] || "", status: "active", priority: i + 1, source: "setup" };
  });
  return {
    ...state,
    profile: {
      health_profile: hp,
      equipment: { ...state.profile.equipment, items: [...(state.profile.equipment.items || []).filter((i: Obj) => i.source !== "setup"), ...items], load_steps: loadSteps(a) },
      goals: { ...state.profile.goals, goals: [...(state.profile.goals.goals || []).filter((g: Obj) => g.source !== "setup"), ...goals] },
    },
    settings: { ...state.settings, consent: { ...state.settings.consent, disclaimer: state.settings.consent.disclaimer || today } },
  };
}
