// The Coach's tool loop, proposals and safety review, with a scripted stand-in for Claude (no network, no cost),
// and the store's pure functions.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { newThread, safetyReview, send, transcript } from "../src/coach/agent.ts";
import { applyChanges, checkChanges, needsReview } from "../src/coach/changes.ts";
import { contextMessage, systemPrompt } from "../src/coach/prompts.ts";
import { ExerciseLibrary } from "../src/engine/library.ts";
import type { Library } from "../src/engine/types.ts";
import { collapse, emptyState, fromExport, saveCheckin, saveWorkout, schedule, toExport, todayGate, workoutRows } from "../src/store/model.ts";
import type { AppState } from "../src/store/model.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const lib = new ExerciseLibrary(JSON.parse(readFileSync(join(HERE, "..", "..", "coach", "library.json"), "utf8")) as Library);
const fixture = JSON.parse(readFileSync(join(HERE, "fixtures", "scenarios.json"), "utf8")).scenarios[1];
const sc = fixture; // read-only in tests; person() hands out copies
const TODAY = "2026-11-09";

function person(): AppState {
  const sc = structuredClone(fixture);
  return fromExport({ format: "sylvester-export", version: 1, exported: "", source: "desktop",
    profile: { health_profile: sc.health_profile, equipment: sc.equipment, goals: sc.goals }, plan: sc.plan, workouts: sc.workouts });
}

/** Stands in for the SDK client: returns the scripted replies in order and records each request. */
function fakeClient(replies: object[]) {
  const requests: any[] = [];
  const client = { beta: { messages: { create: async (req: any) => {
    requests.push(structuredClone(req));
    const r = replies.shift();
    if (!r) throw new Error("no more scripted replies");
    return { id: "m", type: "message", role: "assistant", model: req.model, stop_details: null,
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, ...r };
  } } } };
  return { client: client as any, requests };
}
const toolUse = (id: string, name: string, input: object) => ({ stop_reason: "tool_use", content: [{ type: "tool_use", id, name, input }] });
const said = (text: string) => ({ stop_reason: "end_turn", content: [{ type: "text", text }] });

test("the Coach's proposal is checked locally: a blocked one goes back to it, a fixed one reaches the person", async () => {
  const state = person();
  const bad = { type: "set_routine", key: "a", routine: { ...sc.plan.routines.a, exercises: [{ ex: "barbell_back_squat", sets: 3, reps: "5", load_kg: 40 }] } };
  const good = { type: "set_routine", key: "a", routine: { ...sc.plan.routines.a, exercises: [{ ex: "goblet_box_squat", sets: 3, reps: "8–12", load_kg: 14 }] } };
  const { client, requests } = fakeClient([
    toolUse("t1", "find_exercises", { pattern: "squat" }),
    toolUse("t2", "propose_changes", { summary: "Heavier squats", why: "x", changes: [bad] }),
    toolUse("t3", "propose_changes", { summary: "Box squat", why: "Stays upright.", changes: [good] }),
    said("I've proposed a box squat instead."),
  ]);
  const env = { client, system: systemPrompt(lib, {}), state, lib, sched: schedule(state, lib, TODAY, {}), today: TODAY };
  const t = await send(newThread("claude-opus-5-5"), "Can I squat heavier?", env, "medium");

  assert.equal(requests.length, 4);
  assert.deepEqual(requests[0].fallbacks, "default");
  assert.ok(requests[0].betas.includes("server-side-fallback-2026-07-01"));
  assert.ok(requests[0].messages[0].content[0].text.startsWith("<my_data>"));
  const blocked = requests[2].messages.at(-1).content[0];
  assert.equal(blocked.is_error, true);
  assert.match(blocked.content, /spine_axial|avoids/);
  assert.equal(t.proposals.length, 1);
  assert.equal(t.proposals[0].summary, "Box squat");
  assert.equal(t.proposals[0].review, true);
  assert.deepEqual(transcript(t).map(x => x.role), ["user", "tool", "tool", "tool", "coach"]);
});

test("a refusal and a cut-off answer leave a notice", async () => {
  const state = person();
  const { client } = fakeClient([{ stop_reason: "refusal", content: [] }]);
  const env = { client, system: "s", state, lib, sched: null, today: TODAY };
  const t = await send(newThread("claude-haiku-5-5"), "?", env);
  assert.match(t.notice || "", /couldn't answer/);
});

test("Haiku requests carry no fallback", async () => {
  const { client, requests } = fakeClient([said("ok")]);
  await send(newThread("claude-haiku-5-5"), "hi", { client, system: "s", state: person(), lib, sched: null, today: TODAY });
  assert.equal(requests[0].fallbacks, undefined);
});

test("the safety review blocks what the local checks block without asking the model, and parses its verdict", async () => {
  const state = person();
  const p: any = { id: "p", summary: "s", why: "w", lines: [], local: { blocking: [], warnings: [] }, review: true, status: "pending",
    changes: [{ type: "set_override", date: TODAY, override: { title: "X", exercises: [{ ex: "crunch", sets: 2, reps: "10" }] } }] };
  const none = fakeClient([]);
  const v1 = await safetyReview(none.client, "claude-opus-5-5", state, p, lib, TODAY, "medical");
  assert.equal(v1.verdict, "BLOCK");
  assert.equal(none.requests.length, 0);

  p.changes = [{ type: "set_override", date: TODAY, override: { title: "Short", exercises: [{ ex: "bird_dog", sets: 2, reps: "6" }] } }];
  const ok = fakeClient([said(JSON.stringify({ verdict: "PASS WITH WARNINGS", blocking: [], warnings: ["Add a stop rule."], missing_information: [] }))]);
  const v2 = await safetyReview(ok.client, "claude-opus-5-5", state, p, lib, TODAY, "medical");
  assert.equal(v2.verdict, "PASS WITH WARNINGS");
  assert.ok(v2.warnings.includes("Add a stop rule."));
  assert.equal(ok.requests[0].output_config.format.type, "json_schema");
});

test("checks block only what a change introduces, except the hard rules", () => {
  const state = person();
  state.plan!.rolling.rotation = ["a", "b", "gone"]; // already wrong, not a safety rule
  const r = checkChanges(state, [{ type: "set_coaching", coaching: { focus: ["balance", "core"] } }], lib, TODAY);
  assert.deepEqual(r.blocking, []);
  assert.ok(r.warnings.some(w => w.startsWith("Already in the plan:")));
  state.plan!.rolling.rotation = ["a", "b"];
  state.plan!.routines.b.exercises.push({ ex: "barbell_back_squat", sets: 3, reps: "5", load_kg: 40 }); // never trained: the engine swaps it
  const r2 = checkChanges(state, [{ type: "set_coaching", coaching: { focus: ["core"] } }], lib, TODAY);
  assert.deepEqual(r2.blocking, []);
  assert.ok(r2.warnings.some(w => w.includes("Already in the plan") && w.includes("spine_axial")));
  state.plan!.routines.b.warmup = ["Crunch × 10"]; // read and done as written: stays blocking
  const r3 = checkChanges(state, [{ type: "set_coaching", coaching: { focus: ["core"] } }], lib, TODAY);
  assert.ok(r3.blocking.some(b => b.includes("Crunch")), JSON.stringify(r3.blocking));
  assert.equal(needsReview([{ type: "clear_override", date: TODAY }]), false);
  assert.equal(needsReview([{ type: "set_override", date: TODAY, override: { kind: "rest" } }]), false);
  assert.equal(needsReview([{ type: "set_goals", goals: [] }]), true);
});

test("a missing or too-high effort cap blocks; blood pressure caps at 8", () => {
  const state = person(); // hypertension in this profile
  const phases = (cap?: number) => ({ type: "set_rolling" as const, rolling: { ...sc.plan.rolling, phases: [{ name: "P", weeks: 4, ...(cap ? { rpe_cap: cap } : {}) }] } });
  assert.ok(checkChanges(state, [phases()], lib, TODAY).blocking.some(b => b.includes("needs an rpe_cap")));
  assert.ok(checkChanges(state, [phases(9)], lib, TODAY).blocking.some(b => b.includes("above 8")));
  assert.deepEqual(checkChanges(state, [phases(8)], lib, TODAY).blocking, []);
});

test("loosening limits needs the person's own confirmation; a Coach adaptation can't free an avoided stress", () => {
  const state = person();
  const lim = state.profile.health_profile.limits;
  const loosen = checkChanges(state, [{ type: "set_limits", limits: { avoid: lim.avoid.filter((x: string) => x !== "impact"), max_level: 5 } }], lib, TODAY);
  assert.ok(loosen.confirm.some(c => c.includes("impact")) && loosen.confirm.some(c => c.includes("level cap")));
  const merged = applyChanges(state, [{ type: "set_limits", limits: { max_level: 2 } }]);
  assert.deepEqual(merged.profile.health_profile.limits.avoid, lim.avoid, "set_limits merges");
  const sneaky = [{ type: "set_adaptations" as const, adaptations: [...state.profile.health_profile.adaptations,
    { match: { ids: ["trap_bar_deadlift"] }, how: "From blocks", removes: ["floor_lift", "spine_axial"], source: "Coach (confirm)" }] },
    { type: "set_routine" as const, key: "b", routine: { ...sc.plan.routines.b, exercises: [{ ex: "trap_bar_deadlift", sets: 3, reps: "5", load_kg: 40 }] } }];
  const r = checkChanges(state, sneaky, lib, TODAY);
  assert.ok(r.blocking.some(b => /trap/i.test(b)), JSON.stringify(r.blocking));
  assert.ok(r.confirm.some(c => c.includes("From blocks")));
});

test("a condition's own guidance can't drop out of the limits", () => {
  const state = person();
  const r = checkChanges(state, [{ type: "set_limits", limits: { conditions: [...state.profile.health_profile.limits.conditions, "pregnancy"] } }], lib, TODAY);
  assert.ok(r.blocking.some(b => b.includes("prone")), JSON.stringify(r.blocking));
});

test("a health-check yes without clearance blocks any plan", () => {
  const state = person();
  state.profile.health_profile.screening = { answers: { chest: "yes" } };
  const r = checkChanges(state, [{ type: "set_rolling", rolling: { ...sc.plan.rolling } }], lib, TODAY);
  assert.ok(r.blocking.some(b => b.includes("go-ahead")));
});

test("new_plan replaces the plan; the plan then builds", () => {
  const s = applyChanges(emptyState(), [{ type: "new_plan", plan: sc.plan }]);
  assert.equal(s.plan!.name, "strength");
  assert.ok(schedule(s, lib, TODAY, {})!.days.length === 14);
});

test("the context message carries the person's data, the system prompt doesn't", () => {
  const state = person();
  const sys = systemPrompt(lib, { medical: "MEDICAL", training: "TRAINING", other: "NOT INCLUDED" });
  assert.ok(sys.includes("MEDICAL") && sys.includes("TRAINING") && !sys.includes("NOT INCLUDED"));
  assert.ok(!sys.includes("Back care") && !sys.includes("Leg sensation"));
  const ctx = contextMessage(state, schedule(state, lib, TODAY, {}), TODAY);
  assert.ok(ctx.includes("Leg sensation") && ctx.includes("next_14_days"));
});

test("workouts replace the same session's earlier save, and become plan rows", () => {
  let s = person();
  const doc = { date: TODAY, session: "Strength B", session_id: "day-x", duration_min: "45", notes: "",
    exercises: [{ exercise: "Chest-supported dumbbell row", planned: "3 × 10–15", sets: "3", reps: collapse(["12", "12", "11"]), load_kg: collapse([12, 12, 12]), rpe: "8", pain: "", notes: "" }] };
  s = saveWorkout(s, doc, "2026-11-09T10:00:00");
  s = saveWorkout(s, { ...doc, duration_min: "50" }, "2026-11-09T11:00:00");
  const rows = workoutRows(s).filter(r => r.date === TODAY);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].reps, "12/12/11");
  assert.equal(rows[0].load_kg, "12");
  assert.equal(rows[0].duration_min, "50");
});

test("an app backup imports back to the same state", () => {
  let s = person();
  s = saveCheckin(s, { date: TODAY, pain: "2", leg: "1" });
  const back = fromExport(JSON.parse(JSON.stringify(toExport(s))));
  assert.deepEqual(back.profile, s.profile);
  assert.deepEqual(back.plan, s.plan);
  assert.deepEqual(back.checkins, s.checkins);
  assert.deepEqual(workoutRows(back), workoutRows(s));
  assert.throws(() => fromExport({ format: "something-else" }), /isn't a Sylvester export/);
});

test("today's gate: a signal level postpones calibration; its stop text shows on a recovery day", () => {
  let s = person();
  s = saveCheckin(s, { date: TODAY, leg: "0" });
  assert.equal(todayGate(s, schedule(s, lib, TODAY, {}), TODAY).signal, false);
  s = saveCheckin(s, { date: TODAY, leg: "1" });
  const easy = todayGate(s, schedule(s, lib, TODAY, {}), TODAY);
  assert.equal(easy.signal, true);
  assert.equal(easy.recovery, false);
  assert.deepEqual(easy.stops, []);
  s = saveCheckin(s, { date: TODAY, leg: "3" });
  const rec = todayGate(s, schedule(s, lib, TODAY, {}), TODAY);
  assert.equal(rec.recovery, true);
  assert.deepEqual(rec.stops, ["New weakness or numbness: see a doctor."]);
});
