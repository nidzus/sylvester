// The library and recovery rules, as tests/test_plan.py checks them on the desktop, plus the app-only parts.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { batteryDoc, mergeCatalogue } from "../src/engine/calibration.ts";
import { ExerciseLibrary } from "../src/engine/library.ts";
import { recovery } from "../src/engine/recovery.ts";
import { useExercise } from "../src/engine/rolling.ts";
import { levelActions } from "../src/engine/signals.ts";
import type { DailyRow, Library } from "../src/engine/types.ts";
import { addDays, pyRound, repRange, step, weekday } from "../src/engine/util.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const read = (p: string) => JSON.parse(readFileSync(join(REPO, p), "utf8"));
const data = read("coach/library.json") as Library;
const lib = new ExerciseLibrary(data);
const beginner = JSON.parse(readFileSync(join(HERE, "fixtures", "scenarios.json"), "utf8")).scenarios[0];
const who = lib.person(beginner.health_profile, beginner.equipment, beginner.goals);

test("every library entry is complete", () => {
  const patterns = new Set(Object.keys(data.patterns)), stresses = new Set(Object.keys(data.stresses));
  const ids = data.exercises.map(e => e.id);
  assert.equal(ids.length, new Set(ids).size);
  for (const ex of data.exercises) {
    assert.ok(patterns.has(ex.pattern), ex.id);
    assert.ok(ex.level >= 1 && ex.level <= 5, ex.id);
    assert.ok(ex.purposes.length, ex.id);
    for (const s of ex.stresses) assert.ok(stresses.has(s), `${ex.id}: ${s}`);
  }
});

test("substitute respects limits", () => {
  const alt = lib.substitute("crunch", who.equipment, who.avoid, who.max_level, who.caution);
  assert.ok(alt);
  assert.ok(!alt.stresses.some(s => who.avoid.has(s)));
});

test("household-only candidates need no gear", () => {
  for (const pattern of ["squat", "push_h", "pull_h", "hinge"]) {
    const got = lib.candidates(pattern, who.household, [], 5);
    assert.ok(got.length, pattern);
    for (const ex of got) assert.ok(lib.hasEquipment(ex, who.household), ex.id);
  }
});

test("equipment never counts in fit", () => {
  const bench = { ...lib.get("db_bench_press")!, id: "x" };
  const floor = { ...bench, equipment: [], styles: ["wall_floor"] };
  assert.equal(lib.fit(floor, who), lib.fit(bench, who));
});

test("rotation follows fit, not the alphabet", () => {
  const slot = { pattern: "pull_h", purpose: "posture" };
  const first = lib.pick(slot, 0, who.equipment, who.avoid, who.max_level, who.caution, who)!;
  const best = Math.max(...lib.candidates("pull_h", who.equipment, who.avoid, who.max_level, null, null, who.caution, null, who)
    .map(e => lib.fit(e, who, slot)));
  assert.equal(lib.fit(first, who, slot), best);
});

test("named choices take turns and may carry a caution stress", () => {
  const slot = { pattern: "squat", from: ["goblet_squat", "wall_sit"] };
  const picks = new Set([0, 1].map(b => lib.pick(slot, b, who.equipment, who.avoid, who.max_level, who.caution, who)!.id));
  assert.deepEqual(picks, new Set(["goblet_squat", "wall_sit"]));
});

test("an adaptation changes stresses only with its gear", () => {
  const way = { match: { families: ["push_up"] }, how: "Hands on handles", removes: ["wrist_ext"], needs: ["dumbbell"] };
  const w = { ...who, adaptations: [way] };
  const push = lib.get("push_up")!;
  assert.ok(!lib.stresses(push, w, new Set(["dumbbell"])).has("wrist_ext"));
  assert.ok(lib.stresses(push, w, new Set(["wall"])).has("wrist_ext"));
  const e = useExercise(lib, { ex: "push_up" }, push, false, w, new Set(["dumbbell"]));
  assert.equal(e.cues[0], "Your way: Hands on handles");
});

test("equipment words match whole words", () => {
  const got = lib.equipmentOwned({ items: [{ name: "Polar H10 heart-rate strap" }, { name: "Adjustable dumbbells" }] });
  assert.deepEqual(got, new Set(["dumbbell"]));
});

test("signal levels: the highest level reached applies; a bare day word works", () => {
  const sig = { key: "k", label: "K", lo: 0, hi: 3, levels: { "1": "easy", "3": { day: "recovery", note: "n" } } };
  assert.deepEqual(levelActions(sig, "2"), { day: "easy" });
  assert.deepEqual(levelActions(sig, 3), { day: "recovery", note: "n" });
  assert.equal(levelActions(sig, ""), null);
  assert.equal(levelActions(sig, 0), null);
});

test("a bodyweight ladder never climbs into jumping on its own; a slot keeps its own limits", () => {
  const all = new Set([...who.equipment, ...lib.data.household]);
  let ex = lib.get("reverse_lunge")!;
  for (let i = 0; i < 4; i++) {
    const up = lib.stepRung(ex.id, +1, all, [], 5, [], who);
    if (!up) break;
    assert.ok(!up.stresses.some(s => s === "impact" || s === "ballistic"), up.id);
    ex = up;
  }
  const slot = { pattern: "squat", avoid: ["knee_deep"] };
  for (let b = 0; b < 3; b++) assert.ok(!lib.pick(slot, b, all, [], 5, [], who)!.stresses.includes("knee_deep"));
});

test("helpers behave like Python", () => {
  assert.equal(pyRound(0.25, 1), 0.2);
  assert.equal(pyRound(0.35, 1), 0.3); // 0.35 is just under in binary
  assert.equal(pyRound(2.5), 2);
  assert.deepEqual(repRange("8–12"), [8, 12]);
  assert.equal(repRange("30 m / side"), null);
  assert.equal(step(13, [10, 12.5, 15], 1), 15);
  assert.equal(weekday("2026-11-02"), 0);
  assert.equal(addDays("2026-03-28", 2), "2026-03-30"); // across a clock change
});

function appleRows(n: number, today: string, f: (i: number) => Partial<DailyRow>): DailyRow[] {
  return Array.from({ length: n }, (_, i) => ({ date: addDays(today, -i), total_sleep_h: 7.4, avg_hrv: 45, lowest_hr: 54, ...f(i) }));
}

test("Apple Health recovery: amber while learning, green once there is a baseline, red on two flags", () => {
  const today = "2026-11-20";
  assert.equal(recovery(appleRows(10, today, () => ({})), "Apple Health", today)!.status, "amber");
  assert.equal(recovery(appleRows(40, today, () => ({})), "Apple Health", today)!.status, "green");
  const bad = recovery(appleRows(40, today, i => (i < 7 ? { avg_hrv: 30, lowest_hr: 60 } : {})), "Apple Health", today)!;
  assert.equal(bad.status, "red");
  assert.equal(bad.flags.length, 2);
});

test("a battery becomes a test session without equipment fields", () => {
  const cat = mergeCatalogue(read("coach/assessments.json"), { tests: { bp_rest: { stop: "Mine." } } });
  const doc = batteryDoc(cat, "calibration-1", "2026-11-07")!;
  assert.equal(doc.kind, "assessment");
  assert.ok(doc.tests.length > 5);
  assert.ok(doc.tests.every((t: Record<string, unknown>) => !("needs" in t) && !("implement" in t)));
  assert.equal(batteryDoc(cat, "nope", "2026-11-07"), null);
});

test("Oura: a day's sleep sessions add up; heart rate and HRV come from the night", async () => {
  const { ouraRows } = await import("../src/health/ouraMap.ts");
  const rows = ouraRows({
    daily_readiness: [{ day: "2026-11-12", score: 55, temperature_deviation: 0.6 }],
    daily_spo2: [{ day: "2026-11-12", spo2_percentage: { average: 96.1 }, breathing_disturbance_index: 2 }],
    sleep: [
      { day: "2026-11-12", type: "sleep", total_sleep_duration: 430 },
      { day: "2026-11-12", type: "long_sleep", total_sleep_duration: 21600, deep_sleep_duration: 3600, lowest_heart_rate: 58, average_hrv: 44, latency: 600 },
      { day: "2026-11-12", type: "late_nap", total_sleep_duration: 650 },
      { day: "2026-11-12", type: "rest", total_sleep_duration: 9000 },
    ],
  });
  const r = rows[0];
  assert.deepEqual([r.total_sleep_h, r.night_sleep_h, r.nap_sleep_h, r.sleep_sessions], [6.3, 6, 0.3, 3]);
  assert.deepEqual([r.lowest_hr, r.avg_hrv, r.latency_min, r.spo2_avg], [58, 44, 10, 96.1]);
  assert.equal(r.vo2_max, undefined);
});

test("naps count in the hours, but a short night under them still flags", () => {
  const today = "2026-11-20";
  const r = recovery(appleRows(40, today, i => (i < 7 ? { total_sleep_h: 7.4, night_sleep_h: 5.2 } : {})), "Apple Health", today)!;
  assert.ok(r.flags.some(f => f.startsWith("Averaging 5.2 h of night sleep")), r.flags.join(" | "));
});
