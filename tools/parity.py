#!/usr/bin/env python3
"""Run the desktop plan on the iPhone app's parity scenarios, so both engines can be compared.

    python tools/parity.py mobile/test/fixtures/scenarios.json > expected.json

For every scenario and case it writes a throwaway data folder (never a real one), runs coach/rolling.py
(and coach/snapshot.py's recovery for cases that use wearable rows), and prints:

    {"daily": {scenario: [rows]}, "results": {"<scenario>/<case>": {"schedule": {...}, "recovery": {...}}}}

The app's test (mobile/test/parity.test.ts) runs the TypeScript engine on the same inputs and expects the same days.
Standard library only; made-up people only.
"""

import csv
import json
import os
import shutil
import sys
import tempfile
from datetime import date, timedelta
from pathlib import Path

APP = Path(__file__).resolve().parent.parent
DATA = Path(tempfile.mkdtemp(prefix="sylvester-parity-"))
os.environ["SYLVESTER_DATA"] = str(DATA)
for p in (APP / "coach", APP):
    sys.path.insert(0, str(p))

import rolling  # noqa: E402
import snapshot  # noqa: E402
from core import paths  # noqa: E402


def write(rel, content):
    p = DATA / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content if isinstance(content, str) else json.dumps(content, ensure_ascii=False), encoding="utf-8")


def write_csv(rel, rows):
    p = DATA / rel
    if not rows:
        if p.exists():
            p.unlink()
        return
    fields = list(dict.fromkeys(k for r in rows for k in r))
    p.parent.mkdir(parents=True, exist_ok=True)
    with open(p, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        for r in rows:
            w.writerow({k: r.get(k, "") for k in fields})


def synthetic_daily(start="2026-09-01", days=81):
    """Oura-like rows with some short and missing nights; deterministic."""
    out, d0 = [], date.fromisoformat(start)
    for i in range(days):
        sleep = "" if i % 11 == 0 else ("1.5" if i % 17 == 0 else f"{5.5 + (i % 7) * 0.4:.1f}")
        out.append({
            "date": (d0 + timedelta(days=i)).isoformat(),
            "readiness_score": str(60 + (i * 7) % 30),
            "temperature_deviation": f"{((i % 13) - 4) * 0.07:.2f}",
            "avg_hrv": str(40 + (i * 3) % 15) if sleep else "",
            "lowest_hr": str(52 + i % 6) if sleep else "",
            "total_sleep_h": sleep,
            "sleep_score": str(65 + (i * 5) % 25),
            "steps": str(4000 + (i * 977) % 9000),
        })
    return out


def run(spec):
    out = {"daily": {}, "results": {}}
    for sc in spec["scenarios"]:
        shutil.rmtree(DATA, ignore_errors=True)
        plan = sc["plan"]
        write("settings.json", {"schema": 1, "units": "metric", "active_plan": plan["name"], "sources": {}})
        write("profile/health_profile.json", sc["health_profile"])
        write("profile/equipment.json", sc["equipment"])
        write("profile/goals.json", sc.get("goals") or {})
        folder = f"plans/{plan['name']}"
        write(f"{folder}/rolling.json", plan["rolling"])
        write(f"{folder}/program.md", "# Parity plan\n")
        for key, r in plan["routines"].items():
            write(f"{folder}/routines/{key}.json", r)
        for day, o in (plan.get("overrides") or {}).items():
            write(f"{folder}/overrides/{day}.json", o)
        write_csv("records/workout_log.csv", sc.get("workouts") or [])
        daily = synthetic_daily() if sc.get("daily") == "synthetic" else []
        out["daily"][sc["id"]] = daily
        for case in sc["cases"]:
            write_csv("records/checkins.csv", case.get("checkins") or [])
            rec = case.get("snapshot_recovery")
            rows = [r for r in daily if r["date"] <= case["today"]]
            if case.get("rest_mode"):  # [first, last]: Oura Rest Mode on those days (inclusive), off on the others
                lo, hi = case["rest_mode"]
                rows = [{**r, "rest_mode": "1" if lo <= r["date"] <= hi else "0"} for r in rows]
            if case.get("recovery_from_daily"):
                write_csv("sources/oura_daily.csv", rows)
                rec = snapshot.recovery(date.fromisoformat(case["today"]))
            snap = DATA / "records/snapshot.json"
            if rec:
                paths.write_json(snap, {"recovery": rec})
            elif snap.exists():
                snap.unlink()
            s = rolling.build(date.fromisoformat(case["today"]))
            s.pop("generated", None)
            res = {"schedule": s, "recovery": rec if case.get("recovery_from_daily") else None}
            if case.get("rest_mode"):
                res["daily"] = rows  # this case's own rows, for the app to read instead of the scenario's
            out["results"][f"{sc['id']}/{case['id']}"] = res
    return out


if __name__ == "__main__":
    try:
        spec = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
        result = run(spec)
        sys.stdout.reconfigure(encoding="utf-8")
        print(json.dumps(result, ensure_ascii=False))
    finally:
        shutil.rmtree(DATA, ignore_errors=True)
