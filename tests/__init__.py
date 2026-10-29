"""Tests: python -m unittest   (from the app folder; standard library only, no network)

Every test runs against a throwaway data folder made here, never a real one: SYLVESTER_DATA is
set before any Sylvester module is imported, and the folder is deleted when the run ends.
"""

import atexit
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path

APP = Path(__file__).resolve().parent.parent
DATA = Path(tempfile.mkdtemp(prefix="sylvester-tests-"))
os.environ["SYLVESTER_DATA"] = str(DATA)
atexit.register(shutil.rmtree, DATA, ignore_errors=True)
for p in (APP / "ingest", APP / "coach", APP):
    sys.path.insert(0, str(p))


def write(rel, content):
    p = DATA / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content if isinstance(content, str) else json.dumps(content, ensure_ascii=False), encoding="utf-8")
    return p


def remove(rel):
    p = DATA / rel
    if p.exists():
        p.unlink()


# A beginner with dumbbells, a bench, bands and a pull-up bar, who avoids loaded spinal bending and
# twisting, is careful with deep knee bends, and tracks a knee that sometimes aches.
write("settings.json", {"schema": 1, "units": "metric", "active_plan": "test", "sources": {}})
write("profile/equipment.json", {
    "items": [{"name": "Adjustable dumbbells", "kind": "dumbbells", "spec": "2.5-24 kg"},
              {"name": "Bench", "kind": "bench", "spec": "Adjustable (incline)"},
              {"name": "Resistance bands", "kind": "bands", "spec": "Light, Medium, Mini bands"},
              {"name": "Pull-up bar", "kind": "pullup", "spec": "Doorway"}],
    "load_steps": {"dumbbell": [2.5, 5, 7.5, 10, 12.5, 15, 17.5, 20, 22.5]}})
write("profile/health_profile.json", {
    "training_background": {"experience": "beginner (< 1 yr)"},
    "limits": {"avoid": ["spine_flex_loaded", "spine_rot_loaded"], "caution": ["knee_deep"]},
    "signals": [{"key": "knee", "label": "Knee ache", "lo": 0, "hi": 3,
                 "levels": {"2": {"day": "easy", "avoid_tags": ["knee_deep", "kneeling"], "note": "Knee-friendly day."}}}]})
write("plans/test/rolling.json", {
    "start": "2026-11-02", "weekdays": ["mon", "wed", "fri"], "rotation": ["a", "b"],
    "phases": [{"name": "Learn", "weeks": 4, "rpe_cap": 7}, {"name": "Build", "weeks": 4, "rpe_cap": 8}]})
write("plans/test/routines/a.json", {"title": "Full body A", "exercises": [
    {"ex": "goblet_squat", "sets": 3, "reps": "8–12", "load_kg": 12.5},
    {"ex": "push_up", "sets": 3, "reps": "6–12"},
    {"ex": "chest_supported_db_row", "sets": 3, "reps": "10–15", "load_kg": 10},
    {"ex": "crunch", "sets": 2, "reps": "15"},
    {"slot": {"pattern": "core_rot", "purpose": "core", "every_weeks": 3}, "sets": 2, "reps": "6–10"},
    {"slot": {"pattern": "carry", "every_weeks": 3}, "sets": 3, "reps": "30"}]})
write("plans/test/routines/b.json", {"title": "Full body B", "exercises": [
    {"ex": "db_rdl", "sets": 3, "reps": "8–12", "load_kg": 12.5},
    {"ex": "seated_db_press", "sets": 3, "reps": "8–12", "load_kg": 7.5},
    {"slot": {"pattern": "lunge", "purpose": "strength", "every_weeks": 3}, "sets": 3, "reps": "8–10"},
    {"slot": {"pattern": "pull_v", "every_weeks": "phase"}, "sets": 3, "reps": "5–8"},
    {"slot": {"pattern": "core_lat", "every_weeks": 3}, "sets": 2, "reps": "20–30"}]})
# An old-style routine (names, no library ids) must keep working.
write("plans/test/routines/c.json", {"title": "Plain", "exercises": [
    {"name": "Goblet squat", "lib": "Goblet_Squat", "sets": 3, "reps": "8–12", "load_kg": 10, "implement": "dumbbell"}]})
write("records/workout_log.csv", """date,session,duration_min,exercise,sets,reps,load_kg,rpe,pain,notes
2026-11-02,Full body A,50,Goblet squat,3,12;12;12,12.5,7,,
2026-11-02,Full body A,50,Push-up,3,12;12;12,,7,,
2026-11-02,Full body A,50,Chest-supported dumbbell row,3,15;15;14,10,8,,
2026-11-04,Full body B,50,Dumbbell Romanian deadlift,3,10;10;9,12.5,8,,
""")
