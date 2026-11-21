// The MCP server end to end: the protocol, setup, check-ins, the log, and proposing, reviewing and applying changes,
// against throwaway data folders of made-up people (mobile/test/fixtures/scenarios.json). The Python app must read
// what the server writes: coach/rolling.py lays out the same 14 days from it.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { ExerciseLibrary } from "../../shared/engine/library.ts";
import type { Library } from "../../shared/engine/types.ts";
import { localToday } from "../../shared/engine/util.ts";
import { parseCsv } from "../src/csv.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const SERVER = join(HERE, "..", "src", "server.ts");
const SCENARIOS = JSON.parse(readFileSync(join(REPO, "mobile", "test", "fixtures", "scenarios.json"), "utf8")).scenarios;
const lib = new ExerciseLibrary(JSON.parse(readFileSync(join(REPO, "coach", "library.json"), "utf8")) as Library);
const TODAY = localToday();

const servers: ChildProcessWithoutNullStreams[] = [];
after(() => servers.forEach(s => s.kill()));

/** A running server on its own data folder (and its own home folder, so nothing touches the real one). */
function server(data: string) {
  const home = mkdtempSync(join(tmpdir(), "sylvester-home-"));
  const p = spawn(process.execPath, [SERVER], { env: { ...process.env, SYLVESTER_DATA: data, HOME: home, USERPROFILE: home } });
  servers.push(p);
  let buf = "", next = 1;
  const waiting = new Map<number, (m: any) => void>();
  p.stdout.setEncoding("utf8");
  p.stdout.on("data", (chunk: string) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      const m = JSON.parse(line);
      waiting.get(m.id)?.(m);
    }
  });
  const rpc = (method: string, params: object = {}): Promise<any> => new Promise(res => {
    const id = next++;
    waiting.set(id, res);
    p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const call = async (name: string, args: object = {}) => {
    const r = await rpc("tools/call", { name, arguments: args });
    const text = r.result.content[0].text as string;
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* plain text */ }
    return { error: r.result.isError as boolean, text, json };
  };
  return { rpc, call, raw: (line: string) => p.stdin.write(line + "\n"), data, home };
}

const fresh = () => join(mkdtempSync(join(tmpdir(), "sylvester-mcp-")), "data");

/** A desktop data folder for one of the parity scenarios, as `sylvester.py init` and the Coach would leave it. */
function scenarioFolder(id: string): string {
  const sc = SCENARIOS.find((s: any) => s.id === id);
  const data = fresh();
  const w = (rel: string, x: unknown) => { const p = join(data, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, typeof x === "string" ? x : JSON.stringify(x, null, 2)); };
  w("settings.json", { schema: 1, active_plan: "main" });
  w("profile/health_profile.json", { ...sc.health_profile, onboarding: { disclaimer_accepted: "2026-01-01", wizard_completed: "2026-01-01", completed: "2026-01-01" } });
  w("profile/equipment.json", sc.equipment);
  w("profile/goals.json", sc.goals || { goals: [] });
  w("plans/main/program.md", sc.plan.program || "# Plan\n\n## Stop and get help\n\nStop for chest pain.\n");
  w("plans/main/rolling.json", { ...sc.plan.rolling, start: sc.plan.rolling.start });
  for (const [k, r] of Object.entries(sc.plan.routines)) w(`plans/main/routines/${k}.json`, r);
  return data;
}

const SETUP = {
  name: "Test Person", weight_kg: "80", height_cm: "180", experience: "beginner (< 1 yr)", days_per_week: 3, session_minutes: 45,
  screening: { heart: "no", chest: "no", dizzy: "no", chronic: "no", meds: "no", joints: "yes", supervised: "no" },
  aches: [{ spot: "Knee", side: "right", status: "recovering", pain: "2", triggers: ["Squatting"], notes: "" }],
  gear: ["dumbbells", "bench"], dumbbell_max_kg: "20", goals: ["strength", "health"],
};

function python(): string | null {
  for (const exe of [process.env.PYTHON, "python", "python3"].filter(Boolean) as string[]) {
    const r = spawnSync(exe, ["--version"], { encoding: "utf8" });
    if (r.status === 0) return exe;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------

test("protocol: initialize, tools with annotations, prompts, errors", async () => {
  const s = server(fresh());
  const init = await s.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.equal(init.result.serverInfo.name, "sylvester");
  assert.match(init.result.instructions, /one coach/i);
  const old = await s.rpc("initialize", { protocolVersion: "1999-01-01" });
  assert.equal(old.result.protocolVersion, "2025-06-18");
  const { result: { tools } } = await s.rpc("tools/list");
  assert.ok(tools.length >= 15);
  for (const t of tools) {
    assert.equal(t.inputSchema.type, "object", t.name);
    assert.equal(typeof t.annotations.readOnlyHint, "boolean", t.name);
    assert.equal(t.annotations.openWorldHint, false, t.name);
  }
  const writes = tools.filter((t: any) => !t.annotations.readOnlyHint).map((t: any) => t.name).sort();
  assert.deepEqual(writes, ["apply_proposal", "log_workout", "propose_changes", "record_clearance", "review_brief", "save_checkin", "setup_profile"]);
  const { result: { prompts } } = await s.rpc("prompts/list");
  assert.ok(prompts.some((p: any) => p.name === "wind_down"));
  const got = await s.rpc("prompts/get", { name: "log_session", arguments: { what: "squats" } });
  assert.match(got.result.messages[0].content.text, /squats/);
  assert.equal((await s.rpc("nope")).error.code, -32601);
  assert.equal((await s.rpc("prompts/get", { name: "nope" })).error.code, -32602);
  assert.equal((await s.call("status")).json.set_up, false);
});

test("the extension's manifest lists every tool and prompt, at the server's version", async () => {
  const manifest = JSON.parse(readFileSync(join(HERE, "..", "extension", "manifest.json"), "utf8"));
  const s = server(fresh());
  const { result: { tools } } = await s.rpc("tools/list");
  const { result: { prompts } } = await s.rpc("prompts/list");
  const init = await s.rpc("initialize", {});
  assert.deepEqual(manifest.tools.map((t: any) => t.name).sort(), tools.map((t: any) => t.name).sort());
  assert.deepEqual(manifest.prompts.map((p: any) => p.name).sort(), prompts.map((p: any) => p.name).sort());
  assert.equal(manifest.version, init.result.serverInfo.version);
  for (const [k, v] of Object.entries<any>(manifest.user_config || {})) {
    assert.notEqual(v.required, true, `${k}: Claude Desktop leaves an extension off while a required setting is empty`);
    assert.equal(v.default, undefined, `${k}: a default doesn't count as filled in`);
  }
});

test("setup from chat: disclaimer first, profile files, a starter plan, then today", async () => {
  const data = fresh();
  const s = server(data);
  assert.equal((await s.call("setup_profile", { accept_disclaimer: false, answers: SETUP })).error, true);
  assert.ok(!existsSync(data), "nothing written before the disclaimer");
  assert.equal((await s.call("setup_profile", { accept_disclaimer: true, answers: { ...SETUP, conditions: ["made_up"] } })).error, true);
  const r = await s.call("setup_profile", { accept_disclaimer: true, answers: SETUP, starter_plan: true });
  assert.equal(r.error, false, r.text);
  assert.equal(r.json.plan, "starter plan laid out");
  assert.ok(r.json.limits.caution.includes("knee_deep"), "the knee's trigger is handled with care");
  const hp = JSON.parse(readFileSync(join(data, "profile", "health_profile.json"), "utf8"));
  assert.ok(hp.onboarding.completed && hp.onboarding.wizard_completed && hp._updated);
  assert.ok(existsSync(join(data, "plans", "starter", "schedule.json")));
  assert.ok(existsSync(join(data, "plans", "starter", "schedule.md")));
  assert.equal(JSON.parse(readFileSync(join(data, "settings.json"), "utf8")).active_plan, "starter");
  assert.ok(!existsSync(join(s.home, ".sylvester.json")), "the folder came from SYLVESTER_DATA, so no pointer is written");
  const st = (await s.call("status")).json;
  assert.equal(st.set_up, true);
  assert.equal(st.plan.name, "starter");
  const t = (await s.call("today")).json;
  assert.equal(t.plan, "starter");
  assert.equal(t.checkin.missing, true);
  assert.ok(t.checkin.scales.some((x: any) => x.key === "pain"));
  // Running setup again keeps the plan and replaces only what setup wrote.
  const again = await s.call("setup_profile", { accept_disclaimer: true, answers: { ...SETUP, gear: ["dumbbells"] }, starter_plan: true });
  assert.equal(again.json.plan, "none");
  const eq = JSON.parse(readFileSync(join(data, "profile", "equipment.json"), "utf8"));
  assert.deepEqual(eq.items.map((i: any) => i.kind), ["dumbbells"]);
  assert.ok(existsSync(join(data, "profile", ".history")), "the previous version is kept");
});

test("a health-check yes: no plan until the go-ahead is recorded", async () => {
  const data = fresh();
  const s = server(data);
  const r = await s.call("setup_profile", { accept_disclaimer: true, answers: { ...SETUP, screening: { ...SETUP.screening, chest: "yes" } }, starter_plan: true });
  assert.match(r.json.plan, /go-ahead/);
  assert.ok(r.json.doctor_go_ahead_needed.length);
  assert.ok((await s.call("today")).json.doctor_go_ahead_needed.length);
  assert.match((await s.call("status")).json.next, /go-ahead/);
  const c = await s.call("record_clearance", { by: "their GP" });
  assert.equal(c.error, false, c.text);
  assert.equal((await s.call("status")).json.doctor_go_ahead_needed.length, 0);
});

test("check-ins: validated, merged per day, written as the desktop's CSV, and they change today", async () => {
  const data = scenarioFolder("beginner");
  const s = server(data);
  assert.equal((await s.call("save_checkin", { values: { mood: 9 } })).error, true);
  assert.equal((await s.call("save_checkin", { values: { happiness: 3 } })).error, true);
  assert.equal((await s.call("save_checkin", { values: { mood: 4 }, bp: "high" })).error, true);
  let r = await s.call("save_checkin", { values: { mood: 4, energy: 3, stress: 2 }, notes: "slept badly, ok now" });
  assert.equal(r.error, false, r.text);
  r = await s.call("save_checkin", { values: { pain: 7 }, pain_where: "lower back" });
  assert.equal(r.json.today.adjusted, "recovery");
  assert.match(r.json.note, /recovery day/);
  const rows = parseCsv(readFileSync(join(data, "records", "checkins.csv"), "utf8"));
  assert.equal(rows.length, 1);
  assert.deepEqual({ mood: rows[0].mood, pain: rows[0].pain, notes: rows[0].notes }, { mood: "4", pain: "7", notes: "slept badly, ok now" });
  assert.deepEqual(Object.keys(rows[0]).slice(0, 8), ["date", "mood", "energy", "stress", "motivation", "soreness", "pain", "pain_where"]);
  assert.equal((await s.call("today")).json.adjusted_today.how, "recovery");
  const rec = (await s.call("recovery")).json;
  assert.equal(rec.checkins.mood.last_7d, 4);
});

test("the workout log: one row per exercise, replaced per session, read by the plan", async () => {
  const data = scenarioFolder("beginner");
  const s = server(data);
  const day = (await s.call("get_schedule")).json.days.find((d: any) => d.session);
  assert.ok(day, "the plan lays out a session");
  assert.equal((await s.call("log_workout", { date: "2999-01-01", session: "x", exercises: [] })).error, true);
  const ex = [{ exercise: "Goblet squat", sets: "3", reps: "12/12/12", load_kg: "12", rpe: "7" }, { exercise: "Wall push-up", sets: 2, reps: 10, rpe: 6, pain: 5 }];
  let r = await s.call("log_workout", { session: day.title, duration_min: 40, exercises: ex });
  assert.equal(r.error, false, r.text);
  assert.match(r.json.note, /Wall push-up/);
  r = await s.call("log_workout", { session: day.title, exercises: ex.slice(0, 1) });
  const rows = parseCsv(readFileSync(join(data, "records", "workout_log.csv"), "utf8"));
  assert.equal(rows.length, 1, "saving the same session again replaces it");
  assert.deepEqual(rows[0], { date: TODAY, session: day.title, duration_min: "", exercise: "Goblet squat", sets: "3", reps: "12/12/12", load_kg: "12", rpe: "7", pain: "", notes: "" });
  const hist = (await s.call("get_history", { kind: "workouts" })).json;
  assert.equal(hist.length, 1);
});

test("changes: blocked by the local checks, reviewed, confirmed, applied and logged", async () => {
  const data = scenarioFolder("home-gym");
  const s = server(data);
  const plan = (await s.call("get_plan")).json.plan;
  const hp = JSON.parse(readFileSync(join(data, "profile", "health_profile.json"), "utf8"));
  const who = lib.person(hp, JSON.parse(readFileSync(join(data, "profile", "equipment.json"), "utf8")), {});
  const avoided = lib.data.exercises.find(e => [...lib.stresses(e, who, who.equipment)].some(x => who.avoid.has(x)))!;
  assert.ok(avoided, "the scenario avoids something");

  // An exercise they avoid never gets as far as a proposal.
  const routine = { ...plan.routines.a, exercises: [...plan.routines.a.exercises, { ex: avoided.id, sets: 3, reps: "8–12" }] };
  let r = await s.call("propose_changes", { summary: "Add", why: "test", changes: [{ type: "set_routine", key: "a", routine }] });
  assert.equal(r.error, true);
  assert.match(r.text, /avoids/);
  r = await s.call("propose_changes", { summary: "Bad key", why: "test", changes: [{ type: "set_routine", key: "../x", routine: plan.routines.a }] });
  assert.equal(r.error, true);

  // A rest day needs no review.
  const tomorrow = new Date(Date.now() + 86400000);
  const d = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}`;
  r = await s.call("propose_changes", { summary: "Rest tomorrow", why: "travel", changes: [{ type: "set_override", date: d, override: { kind: "rest", title: "Travel day", note: "walk" } }] });
  assert.equal(r.json.review_needed, false);
  r = await s.call("apply_proposal", { id: r.json.id });
  assert.equal(r.error, false, r.text);
  assert.ok(existsSync(join(data, "plans", "main", "overrides", `${d}.json`)));
  assert.equal((await s.call("get_schedule")).json.days.find((x: any) => x.date === d).title, "Travel day");
  assert.equal((await s.call("apply_proposal", { id: JSON.parse(readFileSync(join(data, "plans", "changes.jsonl"), "utf8").trim()).proposal })).error, true, "applied once only");

  // Changing a routine needs the safety review; a BLOCK is never applied.
  const easier = { ...plan.routines.a, coach_note: "Changed by the test" };
  r = await s.call("propose_changes", { summary: "Note", why: "test", changes: [{ type: "set_routine", key: "a", routine: easier }] });
  assert.equal(r.json.review_needed, true);
  const id = r.json.id;
  assert.match((await s.call("apply_proposal", { id })).text, /safety review first/);
  const brief = (await s.call("review_brief", { id })).json;
  assert.match(brief.instructions, /sports-medicine reviewer/);
  assert.ok(brief.document.plan_after_changes && brief.document.slot_candidates);
  assert.ok(existsSync(brief.file), "saved for a separate reviewer");
  const short = (await s.call("review_brief", { id, file_only: true })).json;
  assert.equal(short.file, brief.file);
  assert.ok(!("document" in short) && !("instructions" in short), "file_only leaves the brief in its file");
  assert.ok(short.changes.length > 0);
  r = await s.call("apply_proposal", { id, review: { verdict: "BLOCK", blocking: ["made-up reason"] } });
  assert.equal(r.error, true);
  assert.match(r.text, /made-up reason/);
  assert.equal(JSON.parse(readFileSync(join(data, "plans", "main", "routines", "a.json"), "utf8")).coach_note, plan.routines.a.coach_note);
  assert.match((await s.call("apply_proposal", { id, review: { verdict: "PASS" } })).text, /blocked/, "a blocked proposal stays blocked");

  r = await s.call("propose_changes", { summary: "Note", why: "test", changes: [{ type: "set_routine", key: "a", routine: easier }] });
  r = await s.call("apply_proposal", { id: r.json.id, review: { verdict: "PASS", reviewer: "in conversation" } });
  assert.equal(r.error, false, r.text);
  assert.equal(JSON.parse(readFileSync(join(data, "plans", "main", "routines", "a.json"), "utf8")).coach_note, "Changed by the test");
  const log = (await s.call("get_history", { kind: "changes" })).json;
  assert.equal(log.length, 2);
  assert.match(log[1].verdict, /PASS \(in conversation\)/);

  // Loosening a limit waits for the person's own yes.
  const removed = [...who.avoid][0];
  r = await s.call("propose_changes", { summary: "Loosen", why: "test", changes: [{ type: "set_limits", limits: { ...hp.limits, avoid: hp.limits.avoid.filter((x: string) => x !== removed), caution: [...(hp.limits.caution || []), removed] } }] });
  assert.equal(r.error, false, r.text); // moved to caution, which the condition guidance allows
  assert.match(r.json.person_must_confirm.join(" "), new RegExp(removed));
  const lid = r.json.id;
  assert.match((await s.call("apply_proposal", { id: lid, review: { verdict: "PASS" } })).text, /loosens/);
  r = await s.call("apply_proposal", { id: lid, review: { verdict: "PASS" }, confirmed: true });
  assert.equal(r.error, false, r.text);
  assert.ok(!JSON.parse(readFileSync(join(data, "profile", "health_profile.json"), "utf8")).limits.avoid.includes(removed));
  assert.ok(existsSync(join(data, "profile", ".history")), "the previous profile is kept");
});

test("what the server writes, the Python app reads: rolling.py lays out the same days", { skip: !python() && "Python not found" }, async () => {
  const data = scenarioFolder("home-gym");
  const s = server(data);
  const day = (await s.call("get_schedule")).json.days.find((d: any) => d.session);
  await s.call("save_checkin", { values: { mood: 3, energy: 2, pain: 2 } });
  await s.call("log_workout", { date: TODAY, session: day.title, exercises: [{ exercise: "Goblet squat", sets: "3", reps: "10", load_kg: "16", rpe: "9" }] });
  const tomorrow = new Date(Date.now() + 86400000);
  const d = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}`;
  const p = await s.call("propose_changes", { summary: "Rest", why: "test", changes: [{ type: "set_override", date: d, override: { kind: "rest", title: "Travel day", note: "" } }] });
  await s.call("apply_proposal", { id: p.json.id });
  const ours = JSON.parse(readFileSync(join(data, "plans", "main", "schedule.json"), "utf8"));
  const r = spawnSync(python()!, [join(REPO, "coach", "rolling.py")], { env: { ...process.env, SYLVESTER_DATA: data, PYTHONIOENCODING: "utf-8" }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const theirs = JSON.parse(readFileSync(join(data, "plans", "main", "schedule.json"), "utf8"));
  const strip = (x: any) => { const { generated: _, ...rest } = x; return rest; };
  assert.equal(theirs.days.length, 14);
  assert.ok(theirs.days.some((x: any) => x.title === "Travel day"));
  for (let i = 0; i < theirs.days.length; i++) assert.deepEqual(ours.days[i], theirs.days[i], `day ${theirs.days[i].date}`);
  assert.deepEqual(strip(ours), strip(theirs));
});
