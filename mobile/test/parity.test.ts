// The phone's plan engine must lay out exactly the days the desktop's does.
// Runs tools/parity.py (the Python engine) on test/fixtures/scenarios.json and the TypeScript engine on the
// same inputs, then compares every case. Needs Python 3 on the PATH (or PYTHON=...).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { ExerciseLibrary } from "../../shared/engine/library.ts";
import { recovery } from "../../shared/engine/recovery.ts";
import { REVIEW_TITLE, build } from "../../shared/engine/rolling.ts";
import type { Library } from "../../shared/engine/types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const SCENARIOS = join(HERE, "fixtures", "scenarios.json");
const lib = new ExerciseLibrary(JSON.parse(readFileSync(join(REPO, "coach", "library.json"), "utf8")) as Library);
const pictures = JSON.parse(readFileSync(join(HERE, "..", "src", "generated", "pictures.json"), "utf8"));

function python(): Record<string, any> {
  for (const exe of [process.env.PYTHON, "python", "python3"].filter(Boolean) as string[]) {
    const r = spawnSync(exe, [join(REPO, "tools", "parity.py"), SCENARIOS], { encoding: "utf8", maxBuffer: 64 << 20 });
    if (r.status === 0) return JSON.parse(r.stdout);
    if (r.error) continue;
    throw new Error(`tools/parity.py failed:\n${r.stderr}`);
  }
  throw new Error("Python 3 not found: set PYTHON to run the parity test.");
}

const expected = python();
const spec = JSON.parse(readFileSync(SCENARIOS, "utf8"));

for (const sc of spec.scenarios) {
  for (const c of sc.cases) {
    test(`${sc.id}/${c.id}`, () => {
      const want = expected.results[`${sc.id}/${c.id}`];
      const daily = want.daily || (expected.daily[sc.id] || []).filter((r: { date: string }) => r.date <= c.today);
      let rec = c.snapshot_recovery || null;
      if (c.recovery_from_daily) {
        rec = recovery(daily, "Oura", c.today);
        assert.deepEqual(rec, want.recovery, "recovery");
      }
      const got = build({
        today: c.today, lib, healthProfile: sc.health_profile, equipment: sc.equipment, goals: sc.goals || {},
        plan: sc.plan, workouts: sc.workouts || [], checkins: c.checkins || [], recovery: rec, pictures,
      });
      const { generated: _, ...schedule } = got;
      for (const d of want.schedule.days) if (d.kind === "review") d.title = REVIEW_TITLE; // the one wording that differs
      for (let i = 0; i < want.schedule.days.length; i++) {
        assert.deepEqual(schedule.days[i], want.schedule.days[i], `day ${want.schedule.days[i].date}`);
      }
      assert.deepEqual(schedule, want.schedule);
    });
  }
}
