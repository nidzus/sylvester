// The phone's own setup and the starter plan: limits from conditions and aches, load steps, and a starter plan
// that respects them for every kind of equipment.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { checkPlan } from "../src/coach/changes.ts";
import { ExerciseLibrary } from "../src/engine/library.ts";
import type { Library } from "../src/engine/types.ts";
import { emptyState, schedule } from "../src/store/model.ts";
import { needsClearance, recordClearance } from "../src/store/clearance.ts";
import { answersFrom, applySetup, blankAnswers, loadSteps } from "../src/store/setup.ts";
import { starterPlan } from "../src/store/starter.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(readFileSync(join(HERE, "..", "..", "coach", "library.json"), "utf8")) as Library;
const lib = new ExerciseLibrary(data);
const TODAY = "2026-11-04";

function person(over: Partial<ReturnType<typeof blankAnswers>> = {}) {
  return applySetup(emptyState(), { ...blankAnswers(), experience: "beginner (< 1 yr)", ...over }, data, TODAY);
}

test("limits come from conditions and from what makes an ache worse", () => {
  const s = person({ conditions: ["lumbar_disc"], aches: [
    { spot: "Knee", side: "left", status: "recovering", pain: "2", triggers: ["Kneeling", "Squatting"], notes: "" },
    { spot: "Shoulder", side: "right", status: "active — hurts now", pain: "5", triggers: ["Reaching overhead"], notes: "" }] });
  const lim = s.profile.health_profile.limits;
  assert.ok(lim.avoid.includes("spine_flex_loaded") && lim.avoid.includes("overhead"));
  assert.ok(lim.caution.includes("kneeling") && lim.caution.includes("knee_deep"));
  assert.ok(!lim.caution.includes("overhead"), "an avoided stress isn't also a caution");
  assert.equal(s.profile.health_profile.onboarding.completed, TODAY);
});

test("load steps follow the equipment", () => {
  const a = { ...blankAnswers(), gear: ["dumbbells", "barbell"], dumbbell_max_kg: "10", dumbbell_step_kg: "2.5", barbell_bar_kg: "20", barbell_max_kg: "40" };
  assert.deepEqual(loadSteps(a), { dumbbell: [2.5, 5, 7.5, 10], barbell: [20, 25, 30, 35, 40] });
});

for (const [name, over] of [
  ["no equipment, back problem", { conditions: ["lumbar_disc"] }],
  ["dumbbells and bench, high blood pressure", { gear: ["dumbbells", "bench"], dumbbell_max_kg: "20", conditions: ["hypertension"] }],
  ["full home gym, knee arthritis", { gear: ["dumbbells", "barbell", "rack", "bench", "pullup", "bands"], dumbbell_max_kg: "24", barbell_max_kg: "100", conditions: ["knee_oa"] }],
] as const) {
  test(`the starter plan respects limits: ${name}`, () => {
    const s0 = person(over as never);
    const s = { ...s0, plan: starterPlan(lib, s0.profile.health_profile, s0.profile.equipment, s0.profile.goals, TODAY)! };
    const who = lib.person(s.profile.health_profile, s.profile.equipment, s.profile.goals);
    assert.deepEqual(checkPlan(s, lib, TODAY).blocking, []);
    const sched = schedule(s, lib, "2026-11-09", {})!;
    const sessions = sched.days.filter(d => d.session);
    assert.ok(sessions.length >= 4);
    for (const d of sessions) {
      assert.ok(d.session!.exercises.length >= 4, `${d.date} has exercises`);
      for (const e of d.session!.exercises) {
        assert.ok(!(e.tags || []).some((t: string) => who.avoid.has(t) || who.caution.has(t)), `${e.name}: ${e.tags}`);
        assert.ok(!(e.tags || []).some((t: string) => t === "impact" || t === "ballistic"), `${e.name}: no jumping in the starter`);
      }
      for (const w of d.session!.warmup) assert.ok(!/cat-cow|bridge/i.test(w), "warm-ups name no exercise that bypasses the limits");
    }
  });
}

test("chest pain, fainting, supervision, a heart condition or pregnancy: no plan until a doctor's go-ahead is recorded", () => {
  for (const over of [{ screening: { chest: "yes" } }, { screening: { dizzy: "yes" } }, { screening: { supervised: "yes" } },
    { conditions: ["heart"] }, { conditions: ["pregnancy"] }, { screening: { heart: "yes" } }]) {
    const s = person(over as never);
    assert.equal(starterPlan(lib, s.profile.health_profile, s.profile.equipment, s.profile.goals, TODAY), null, JSON.stringify(over));
    const withPlan = { ...s, plan: starterPlan(lib, person().profile.health_profile, s.profile.equipment, s.profile.goals, TODAY)! };
    assert.equal(schedule(withPlan, lib, TODAY, {}), null, "no sessions either");
    assert.ok(checkPlan(withPlan, lib, TODAY).blocking.some(b => b.includes("go-ahead")));
    const cleared = { ...withPlan, profile: { ...withPlan.profile, health_profile: recordClearance(withPlan.profile.health_profile, TODAY, "test") } };
    assert.ok(schedule(cleared, lib, TODAY, {}));
  }
  // high blood pressure only: the heart question's yes doesn't block, but straining under load is avoided
  const bp = person({ screening: { heart: "yes" }, conditions: ["hypertension"] });
  assert.ok(starterPlan(lib, bp.profile.health_profile, bp.profile.equipment, bp.profile.goals, TODAY));
  assert.ok(bp.profile.health_profile.limits.avoid.includes("high_pressure"));
});

test("the starter's program text carries the stop rules, and the plan starts next Monday", () => {
  const s = person({ conditions: ["lumbar_disc", "hypertension"] });
  const plan = starterPlan(lib, s.profile.health_profile, s.profile.equipment, s.profile.goals, TODAY)!;
  assert.match(plan.program!, /chest pain/);
  assert.match(plan.program!, /saddle/);
  assert.match(plan.program!, /160\/100/);
  assert.equal(plan.rolling.start, "2026-11-09");
});

test("triggers map by body part; a high BMI keeps impact out", () => {
  const s = person({ weight_kg: "110", height_cm: "175", aches: [
    { spot: "Shoulder", side: "right", status: "active — hurts now", pain: "6", triggers: ["Pushing"], notes: "" },
    { spot: "Knee", side: "left", status: "recovering", pain: "2", triggers: ["Stairs"], notes: "" }] });
  const lim = s.profile.health_profile.limits;
  assert.ok(["shoulder_end", "wrist_ext", "overhead"].every(x => lim.avoid.includes(x)));
  assert.ok(lim.caution.includes("step") && lim.caution.includes("impact"));
});

test("running setup again keeps what came from the desktop or the Coach", () => {
  const s0 = emptyState();
  s0.profile.health_profile.injuries = [{ area: "Lower back", status: "recovering", triggers: ["Bending forward"], notes: "from the desktop" }];
  s0.profile.health_profile.limits = { avoid: ["spine_axial"], caution: [], max_level: 2 };
  s0.profile.health_profile.adaptations = [{ match: { ids: ["db_bench_press"] }, how: "Feet up", source: "you" }];
  const s1 = applySetup(s0, { ...blankAnswers(), experience: "intermediate (1–3 yrs)", aches: [
    { spot: "Knee", side: "left", status: "recovering", pain: "1", triggers: ["Kneeling"], notes: "" }] }, data, TODAY);
  const s2 = applySetup(s1, answersFrom(s1), data, TODAY);
  const hp = s2.profile.health_profile;
  assert.deepEqual(hp.injuries.map((x: { area: string }) => x.area), ["Lower back", "Knee"]);
  assert.ok(hp.limits.avoid.includes("spine_axial") && hp.limits.caution.includes("kneeling"));
  assert.equal(hp.limits.max_level, 2);
  assert.equal(hp.adaptations[0].how, "Feet up");
});

test("a go-ahead covers what it was given for; a new yes in setup asks for a new one", () => {
  const s0 = person({ conditions: ["pregnancy"] });
  const s1 = { ...s0, profile: { ...s0.profile, health_profile: recordClearance(s0.profile.health_profile, TODAY, "test") } };
  assert.deepEqual(needsClearance(s1.profile.health_profile), []);
  const s2 = applySetup(s1, { ...answersFrom(s1), conditions: ["pregnancy"], screening: { chest: "yes" } }, data, TODAY);
  assert.deepEqual(needsClearance(s2.profile.health_profile), ["chest pain", "pregnancy (your care provider's OK)"]);
  const typed = person({ other_conditions: "Pregnant, 20 weeks" });
  assert.ok(typed.profile.health_profile.limits.conditions.includes("pregnancy"));
  assert.ok(needsClearance(typed.profile.health_profile).length);
});

test("warm-ups that mention a library exercise are checked; low reps under strain block with high blood pressure", () => {
  const s0 = person({ conditions: ["hypertension"], aches: [{ spot: "Knee", side: "left", status: "active — hurts now", pain: "5", triggers: ["Kneeling"], notes: "" }] });
  const plan = starterPlan(lib, s0.profile.health_profile, s0.profile.equipment, s0.profile.goals, TODAY)!;
  plan.routines.a.warmup = ["Cat cows x 8"];
  assert.ok(checkPlan({ ...s0, plan }, lib, TODAY).blocking.some(b => b.includes("Cat-cow")));
  plan.routines.a.warmup = [];
  // As in a profile where high pressure is only handled with caution (a deliberate choice with the Coach):
  const lim = s0.profile.health_profile.limits;
  lim.avoid = lim.avoid.filter((x: string) => x !== "high_pressure");
  lim.caution = [...lim.caution, "high_pressure"];
  const strain = lib.data.exercises.find(e => e.stresses.includes("high_pressure") && (e.unit || "reps") === "reps"
    && !e.stresses.some(x => lim.avoid.includes(x)))!;
  plan.routines.a.exercises.push({ ex: strain.id, sets: 3, reps: "3–5", load_kg: 20 });
  assert.ok(checkPlan({ ...s0, plan }, lib, TODAY).blocking.some(b => b.includes("6 reps or more")), strain.id);
  plan.routines.a.exercises[plan.routines.a.exercises.length - 1].reps = "8–12";
  assert.ok(!checkPlan({ ...s0, plan }, lib, TODAY).blocking.some(b => b.includes("6 reps or more")));
});
