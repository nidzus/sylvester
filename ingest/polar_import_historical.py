#!/usr/bin/env python3
"""
One-off importer for the Polar GDPR data export ("Download your data" on
account.polar.com), used to backfill history that the live AccessLink API
cannot provide (it only sees data from app-registration date forward).

Usage:
    python sylvester.py import polar <folder of the unzipped Polar account export>

Reads every training-session_*.json and fitness-test-results-*.json in the
given export folder and upserts them into polar_exercises.csv and
polar_fitness_tests.csv (same files the daily polar_pull.py writes to), so
history and ongoing daily pulls end up in one continuous CSV. Safe to
re-run -- rows are upserted by exercise_id / date.

The original export JSON files (which include full per-second sample
series, laps, zones) are left untouched in the export folder as the raw
archive; only summary fields are flattened into the CSVs.
"""

import csv
import glob
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
from core import paths  # noqa: E402
for _d in (paths.SECRETS, paths.SOURCES, paths.RECORDS):
    _d.mkdir(parents=True, exist_ok=True)

EXERCISES_CSV = str(paths.SOURCES / "polar_exercises.csv")
FITNESS_TESTS_CSV = str(paths.SOURCES / "polar_fitness_tests.csv")

EXERCISE_FIELDS = [
    "exercise_id", "start_time", "sport",
    "duration_min", "distance_km", "calories",
    "hr_avg", "hr_max", "training_load",
]
FITNESS_TEST_FIELDS = ["date", "own_index", "avg_hr", "fitness_class"]


def upsert_csv(path, fields, key_field, new_rows, sort_field=None):
    sort_field = sort_field or key_field
    existing = {}
    if os.path.exists(path):
        with open(path, newline="") as f:
            for r_ in csv.DictReader(f):
                existing[r_[key_field]] = r_
    for r_ in new_rows:
        k = r_.get(key_field)
        if k is None:
            continue
        existing[str(k)] = r_
    with open(path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        for k in sorted(existing, key=lambda k_: (existing[k_].get(sort_field) or "", k_)):
            w.writerow({fld: existing[k].get(fld) for fld in fields})
    return len(existing)


def import_sessions(export_dir):
    rows = []
    skipped = []
    for path in glob.glob(os.path.join(export_dir, "training-session_*.json")):
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
        exercise_id = (d.get("identifier") or {}).get("id")
        if not exercise_id:
            skipped.append(path)
            continue
        ex0 = (d.get("exercises") or [{}])[0]
        cardio_load = (ex0.get("trainingLoadReport") or {}).get("cardioLoad")
        rows.append({
            "exercise_id": exercise_id,
            "start_time": d.get("startTime"),
            "sport": d.get("name"),
            "duration_min": round(d["durationMillis"] / 60000, 2) if d.get("durationMillis") else None,
            "distance_km": round(d["distanceMeters"] / 1000, 3) if d.get("distanceMeters") is not None else None,
            "calories": d.get("calories"),
            "hr_avg": d.get("hrAvg"),
            "hr_max": d.get("hrMax"),
            "training_load": cardio_load,
        })
    n = upsert_csv(EXERCISES_CSV, EXERCISE_FIELDS, "exercise_id", rows, sort_field="start_time")
    print(f"Sessions: imported {len(rows)}, skipped {len(skipped)} (no id). "
          f"{EXERCISES_CSV} now holds {n} rows.")


def import_fitness_tests(export_dir):
    rows = []
    for path in glob.glob(os.path.join(export_dir, "fitness-test-results-*.json")):
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
        ftr = d.get("fitnessTestResult") or {}
        date = (d.get("startTime") or "")[:10]
        if not date:
            continue
        rows.append({
            "date": date,
            "own_index": ftr.get("ownIndex"),
            "avg_hr": ftr.get("averageHeartRate"),
            "fitness_class": ftr.get("fitnessClass"),
        })
    n = upsert_csv(FITNESS_TESTS_CSV, FITNESS_TEST_FIELDS, "date", rows)
    print(f"Fitness tests: imported {len(rows)}. {FITNESS_TESTS_CSV} now holds {n} rows.")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit('Usage: polar_import_historical.py "<export folder>"')
    export_dir = sys.argv[1]
    if not os.path.isdir(export_dir):
        sys.exit(f"Not a directory: {export_dir}")
    import_sessions(export_dir)
    import_fitness_tests(export_dir)
