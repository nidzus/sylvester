#!/usr/bin/env python3
"""
Apple Health export -> CSVs the Coach can use.

    python sylvester.py import apple        # both parts
    python ingest/apple_import.py records   # export.xml only  (~1 min)
    python ingest/apple_import.py clinical  # clinical-records/ only

Re-export from the iPhone (Health > profile > Export All Health Data), unzip
into <data>/imports/apple_health_export/, and re-run. Outputs are rebuilt from scratch each
run, so re-running is always safe.

Outputs
    apple_daily.csv          one row per day: weight, body fat, BP, steps,
                             gait, Elite HRV readings, mindful minutes, glucose
    apple_bp.csv             one row per blood-pressure reading
    apple_glucose_daily.csv  CGM summary per day (mean, peak, time > 140 / < 70)
    apple_workouts.csv       one row per workout
    data\\apple_me.json       date of birth / sex from the Health profile
    data\\clinical_summary.json / .md
                             conditions, medications, allergies, procedures,
                             labs and vitals from linked medical records

Not imported, on purpose: heart rate samples, sleep and energy burned —
Oura and Polar already supply them at better resolution.
"""

import csv
import glob
import json
import os
import re
import sys
import time
import xml.etree.ElementTree as ET
from collections import defaultdict
from statistics import mean

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
from core import paths  # noqa: E402
for _d in (paths.SECRETS, paths.SOURCES, paths.RECORDS):
    _d.mkdir(parents=True, exist_ok=True)

EXPORT_DIR = str(paths.IMPORTS / "apple_health_export")
EXPORT_XML = os.path.join(EXPORT_DIR, "export.xml")
CLINICAL_DIR = os.path.join(EXPORT_DIR, "clinical-records")
DATA_DIR = str(paths.RECORDS)

DAILY_CSV = str(paths.SOURCES / "apple_daily.csv")
BP_CSV = str(paths.SOURCES / "apple_bp.csv")
GLUCOSE_CSV = str(paths.SOURCES / "apple_glucose_daily.csv")
WORKOUTS_CSV = str(paths.SOURCES / "apple_workouts.csv")

LB = 0.45359237
MI = 1.609344
Q = "HKQuantityTypeIdentifier"

DAILY_FIELDS = [
    "date", "weight_kg", "body_fat_pct", "bmi",
    "bp_systolic", "bp_diastolic", "bp_readings",
    "steps", "flights", "walking_speed_kmh", "step_length_cm",
    "double_support_pct", "walking_asymmetry_pct", "walking_steadiness_pct",
    "resting_hr_elitehrv", "hrv_sdnn_elitehrv", "mindful_min",
    "glucose_mean", "glucose_max",
]

# type -> (column, how to aggregate within a day, unit conversion)
MEAN, LAST, SUM_BEST_SOURCE = "mean", "last", "sum_best_source"


def pct(v):
    return v * 100 if v <= 1.5 else v  # Apple stores most percentages as fractions


TYPES = {
    Q + "BodyMass": ("weight_kg", LAST, None),  # converted per unit below
    Q + "BodyFatPercentage": ("body_fat_pct", LAST, pct),
    Q + "BodyMassIndex": ("bmi", LAST, None),
    Q + "StepCount": ("steps", SUM_BEST_SOURCE, None),
    Q + "FlightsClimbed": ("flights", SUM_BEST_SOURCE, None),
    Q + "WalkingSpeed": ("walking_speed_kmh", MEAN, None),
    Q + "WalkingStepLength": ("step_length_cm", MEAN, None),
    Q + "WalkingDoubleSupportPercentage": ("double_support_pct", MEAN, pct),
    Q + "WalkingAsymmetryPercentage": ("walking_asymmetry_pct", MEAN, pct),
    Q + "AppleWalkingSteadiness": ("walking_steadiness_pct", LAST, pct),
    Q + "RestingHeartRate": ("resting_hr_elitehrv", MEAN, None),
    Q + "HeartRateVariabilitySDNN": ("hrv_sdnn_elitehrv", MEAN, None),
}

UNIT_CONVERT = {
    ("weight_kg", "lb"): lambda v: v * LB,
    ("walking_speed_kmh", "mi/hr"): lambda v: v * MI,
    ("walking_speed_kmh", "m/s"): lambda v: v * 3.6,
    ("step_length_cm", "in"): lambda v: v * 2.54,
    ("step_length_cm", "m"): lambda v: v * 100,
}


def r(v, n=1):
    return None if v is None else round(v, n)


def write_csv(path, fields, rows):
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)


def parse_dt(s):
    """'2023-11-18 01:53:00 -0700' -> ('2023-11-18', '2023-11-18T01:53:00'). Local wall-clock time."""
    return s[:10], s[:19].replace(" ", "T")


# ---------- export.xml ----------

def import_records():
    if not os.path.exists(EXPORT_XML):
        print(f"No {EXPORT_XML} — skipping records.")
        return
    t0 = time.time()
    means = defaultdict(lambda: defaultdict(list))        # col -> date -> [values]
    lasts = defaultdict(dict)                             # col -> date -> (time, value)
    sums = defaultdict(lambda: defaultdict(lambda: defaultdict(float)))  # col -> date -> source -> sum
    bp = {}                                               # time -> {sys, dia}
    glucose = defaultdict(list)                           # date -> [mg/dL]
    mindful = defaultdict(float)
    workouts = []
    me = {}

    depth = 0
    root = None
    for event, el in ET.iterparse(EXPORT_XML, events=("start", "end")):
        if event == "start":
            if root is None:
                root = el
            depth += 1
            continue
        depth -= 1
        tag = el.tag

        if tag == "Record":
            a = el.attrib
            t = a.get("type", "")
            start = a.get("startDate", "")
            day, ts = parse_dt(start)
            try:
                v = float(a.get("value", "nan"))
            except ValueError:
                v = None

            if t in TYPES and v is not None:
                col, how, conv = TYPES[t]
                v = UNIT_CONVERT.get((col, a.get("unit")), lambda x: x)(v)
                if conv:
                    v = conv(v)
                if how == MEAN:
                    means[col][day].append(v)
                elif how == LAST:
                    prev = lasts[col].get(day)
                    if prev is None or ts >= prev[0]:
                        lasts[col][day] = (ts, v)
                else:
                    sums[col][day][a.get("sourceName", "?")] += v
            elif t == Q + "BloodPressureSystolic" and v is not None:
                bp.setdefault(ts, {})["sys"] = v
            elif t == Q + "BloodPressureDiastolic" and v is not None:
                bp.setdefault(ts, {})["dia"] = v
            elif t == Q + "BloodGlucose" and v is not None:
                if a.get("unit") == "mmol<180.1558800000541>/L" or a.get("unit", "").startswith("mmol"):
                    v *= 18.0
                glucose[day].append(v)
            elif t == "HKCategoryTypeIdentifierMindfulSession":
                _, te = parse_dt(a.get("endDate", start))
                try:
                    mindful[day] += (time.mktime(time.strptime(te, "%Y-%m-%dT%H:%M:%S"))
                                     - time.mktime(time.strptime(ts, "%Y-%m-%dT%H:%M:%S"))) / 60
                except ValueError:
                    pass

        elif tag == "Workout":
            a = el.attrib
            day, ts = parse_dt(a.get("startDate", ""))
            _, te = parse_dt(a.get("endDate", ""))
            stats = {s.get("type", "").replace(Q, ""): s.attrib for s in el.findall("WorkoutStatistics")}
            dur = float(a["duration"]) if a.get("duration") else None
            if dur is not None and a.get("durationUnit") == "sec":
                dur /= 60
            dist = a.get("totalDistance")
            dist_unit = a.get("totalDistanceUnit")
            if dist is None:
                for k in ("DistanceWalkingRunning", "DistanceCycling", "DistanceSwimming", "DistanceDownhillSnowSports"):
                    if k in stats and stats[k].get("sum"):
                        dist, dist_unit = stats[k]["sum"], stats[k].get("unit")
                        break
            dist_km = None
            if dist is not None:
                dist_km = float(dist) * {"mi": MI, "km": 1, "m": 0.001, "yd": 0.0009144}.get(dist_unit, 1)
            energy = a.get("totalEnergyBurned") or stats.get("ActiveEnergyBurned", {}).get("sum")
            hr = stats.get("HeartRate", {})
            workouts.append({
                "start": ts, "end": te,
                "type": a.get("workoutActivityType", "").replace("HKWorkoutActivityType", ""),
                "duration_min": r(dur),
                "distance_km": r(dist_km, 2),
                "energy_kcal": r(float(energy)) if energy else None,
                "hr_avg": r(float(hr["average"])) if hr.get("average") else None,
                "hr_max": r(float(hr["maximum"])) if hr.get("maximum") else None,
                "source": a.get("sourceName"),
            })

        elif tag == "Me":
            me = {
                "date_of_birth": el.get("HKCharacteristicTypeIdentifierDateOfBirth") or None,
                "sex": (el.get("HKCharacteristicTypeIdentifierBiologicalSex") or "").replace("HKBiologicalSex", "").lower() or None,
                "blood_type": (el.get("HKCharacteristicTypeIdentifierBloodType") or "").replace("HKBloodType", "") or None,
            }

        if depth == 1 and root is not None:
            root.clear()  # drop finished top-level elements; keeps memory flat across 1.3 GB

    # --- assemble daily rows ---
    days = defaultdict(dict)
    for col, by_day in means.items():
        for d, vals in by_day.items():
            days[d][col] = r(mean(vals))
    for col, by_day in lasts.items():
        for d, (_, v) in by_day.items():
            days[d][col] = r(v)
    for col, by_day in sums.items():
        for d, by_src in by_day.items():
            days[d][col] = round(max(by_src.values()))  # phone + watch both count steps; take one source, not the sum
    bp_rows = []
    by_day_bp = defaultdict(list)
    for ts in sorted(bp):
        p = bp[ts]
        if "sys" in p and "dia" in p:
            bp_rows.append({"time": ts, "systolic": round(p["sys"]), "diastolic": round(p["dia"])})
            by_day_bp[ts[:10]].append(p)
    for d, ps in by_day_bp.items():
        days[d]["bp_systolic"] = round(mean(p["sys"] for p in ps))
        days[d]["bp_diastolic"] = round(mean(p["dia"] for p in ps))
        days[d]["bp_readings"] = len(ps)
    for d, m in mindful.items():
        days[d]["mindful_min"] = round(m)
    glucose_rows = []
    for d in sorted(glucose):
        g = glucose[d]
        days[d]["glucose_mean"] = round(mean(g))
        days[d]["glucose_max"] = round(max(g))
        glucose_rows.append({
            "date": d, "readings": len(g), "mean": round(mean(g)), "min": round(min(g)), "max": round(max(g)),
            "pct_above_140": round(sum(x > 140 for x in g) / len(g) * 100, 1),
            "pct_below_70": round(sum(x < 70 for x in g) / len(g) * 100, 1),
        })

    write_csv(DAILY_CSV, DAILY_FIELDS, [{"date": d, **days[d]} for d in sorted(days)])
    write_csv(BP_CSV, ["time", "systolic", "diastolic"], bp_rows)
    write_csv(GLUCOSE_CSV, ["date", "readings", "mean", "min", "max", "pct_above_140", "pct_below_70"], glucose_rows)
    workouts.sort(key=lambda w: w["start"])
    write_csv(WORKOUTS_CSV, ["start", "end", "type", "duration_min", "distance_km", "energy_kcal", "hr_avg", "hr_max", "source"], workouts)
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(os.path.join(DATA_DIR, "apple_me.json"), "w", encoding="utf-8") as f:
        json.dump(me, f, indent=2)
    print(f"Records: {len(days)} days, {len(bp_rows)} BP readings, {len(glucose_rows)} CGM days, "
          f"{len(workouts)} workouts in {round(time.time() - t0)} s.")


# ---------- clinical-records (FHIR R4 JSON) ----------

def cc_text(c):
    """CodeableConcept -> best human label."""
    if not c:
        return None
    if isinstance(c, list):
        c = c[0] if c else {}
    return c.get("text") or next((x.get("display") for x in c.get("coding", []) if x.get("display")), None)


def obs_value(o):
    if "valueQuantity" in o:
        q = o["valueQuantity"]
        return q.get("value"), q.get("unit") or q.get("code")
    if "valueString" in o:
        return o["valueString"], None
    if "valueCodeableConcept" in o:
        return cc_text(o["valueCodeableConcept"]), None
    if o.get("component"):
        parts = []
        for c in o["component"]:
            q = c.get("valueQuantity") or {}
            if q.get("value") is not None:
                parts.append(f"{q['value']:g}" if isinstance(q["value"], (int, float)) else str(q["value"]))
        if parts:
            unit = (o["component"][0].get("valueQuantity") or {}).get("unit")
            return "/".join(parts), unit
    return None, None


def ref_range(o):
    rr = (o.get("referenceRange") or [{}])[0]
    if rr.get("text"):
        return rr["text"]
    lo, hi = (rr.get("low") or {}).get("value"), (rr.get("high") or {}).get("value")
    if lo is None and hi is None:
        return None
    return f"{'' if lo is None else lo}–{'' if hi is None else hi}"


def short(s, n=300):
    if not s:
        return None
    s = " ".join(str(s).split())
    return s if len(s) <= n else s[:n] + "…"


def clean_note(s):
    """Drop sign-off lines and patient-name headers — not needed for coaching."""
    if not isinstance(s, str):
        return s
    s = re.sub(r"(Electronically )?Signed by:.*?(AM|PM)", "", s, flags=re.I | re.S)
    s = re.sub(r"Read by:.*?(AM|PM)", "", s, flags=re.I | re.S)
    s = re.sub(r"Confirmed by .*?(AM|PM)", "", s, flags=re.I | re.S)
    s = re.sub(r"PATIENT:\s*[A-Z ,.'-]+(?=\s+[A-Z]+:)", "", s)
    return " ".join(s.split()) or None


def import_clinical():
    files = glob.glob(os.path.join(CLINICAL_DIR, "*.json"))
    if not files:
        print(f"No clinical records in {CLINICAL_DIR} — skipping.")
        return
    out = {"patient": {}, "conditions": [], "medications": [], "allergies": [], "procedures": [],
           "immunizations": [], "labs": defaultdict(list), "vitals": defaultdict(list),
           "reports": [], "documents": [], "notes": []}
    for path in files:
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
        kind = d.get("resourceType")
        if kind == "Patient":
            out["patient"] = {"birth_date": d.get("birthDate"), "sex": d.get("gender")}  # no name/address/IDs kept
        elif kind == "Condition":
            out["conditions"].append({
                "name": cc_text(d.get("code")),
                "status": cc_text(d.get("clinicalStatus")) or (d.get("clinicalStatus") or {}).get("coding", [{}])[0].get("code"),
                "since": (d.get("onsetDateTime") or d.get("recordedDate") or "")[:10] or None,
            })
        elif kind in ("MedicationRequest", "MedicationStatement"):
            name = cc_text(d.get("medicationCodeableConcept"))
            if not name:
                for c in d.get("contained", []):
                    if c.get("resourceType") == "Medication":
                        name = cc_text(c.get("code"))
            name = name or (d.get("medicationReference") or {}).get("display")
            dosage = "; ".join(x.get("text", "") for x in d.get("dosageInstruction", []) if x.get("text")) or None
            out["medications"].append({
                "name": name, "status": d.get("status"),
                "date": (d.get("authoredOn") or (d.get("effectivePeriod") or {}).get("start") or "")[:10] or None,
                "reason": cc_text(d.get("reasonCode")), "dosage": short(dosage, 160),
            })
        elif kind == "AllergyIntolerance":
            out["allergies"].append(cc_text(d.get("code")))
        elif kind == "Procedure":
            out["procedures"].append({
                "name": cc_text(d.get("code")),
                "date": (d.get("performedDateTime") or (d.get("performedPeriod") or {}).get("start") or "")[:10] or None,
            })
        elif kind == "Immunization":
            out["immunizations"].append({"name": cc_text(d.get("vaccineCode")), "date": (d.get("occurrenceDateTime") or "")[:10] or None})
        elif kind == "Observation":
            name = (cc_text(d.get("code")) or "").strip()
            cats = [cc_text(c) for c in d.get("category", [])]
            when = (d.get("effectiveDateTime") or d.get("issued") or "")[:10] or None
            value, unit = obs_value(d)
            if name in ("Narrative", "Impression", "Diagnosis") or (isinstance(value, str) and len(value) > 60):
                text = clean_note(value)
                # Imaging impressions are the clinically important part (e.g. an MRI finding) — keep them whole.
                text = short(text, 2000 if name == "Impression" else 400)
                if text and text.lower() != "patient fasting" and not any(
                        n["date"] == when and n["text"] == text for n in out["notes"]):
                    out["notes"].append({"name": name, "date": when, "text": text})
                continue
            entry = {"date": when, "value": value, "unit": unit, "range": ref_range(d),
                     "flag": cc_text(d.get("interpretation"))}
            bucket = "vitals" if "Vital Signs" in cats else "labs"
            out[bucket][name].append(entry)
        elif kind == "DiagnosticReport":
            out["reports"].append({"name": cc_text(d.get("code")), "date": (d.get("effectiveDateTime") or d.get("issued") or "")[:10] or None,
                                   "conclusion": short(d.get("conclusion"))})
        elif kind == "DocumentReference":
            out["documents"].append({"type": cc_text(d.get("type")), "date": (d.get("date") or "")[:10] or None,
                                     "description": short(d.get("description"), 120)})

    for k in ("labs", "vitals"):
        out[k] = {name: sorted(v, key=lambda e: e["date"] or "", reverse=True) for name, v in sorted(out[k].items())}
    for k in ("conditions", "medications", "procedures", "immunizations", "reports", "documents", "notes"):
        out[k].sort(key=lambda e: e.get("since") or e.get("date") or "", reverse=True)

    os.makedirs(DATA_DIR, exist_ok=True)
    with open(os.path.join(DATA_DIR, "clinical_summary.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2, ensure_ascii=False)
    with open(os.path.join(DATA_DIR, "clinical_summary.md"), "w", encoding="utf-8") as f:
        f.write(clinical_markdown(out))
    print(f"Clinical: {len(out['conditions'])} conditions, {len(out['medications'])} medications, "
          f"{len(out['labs'])} lab tests, {len(out['vitals'])} vital types.")


def clinical_markdown(c):
    fmt = lambda e: f"{e['value']}{' ' + e['unit'] if e.get('unit') else ''}"
    L = ["# Clinical summary (from Apple Health medical records)", "",
         "_Generated by apple_import.py. Records may be old — always quote the date. Confirm with the person before relying on anything here._", ""]
    p = c["patient"]
    if p:
        L += [f"- Born {p.get('birth_date')}, sex {p.get('sex')}", ""]
    L += ["## Conditions", ""] + [f"- **{x['name']}** — {x['status']}, since {x['since']}" for x in c["conditions"]] + [""]
    L += ["## Medications & prescriptions", ""]
    for m in c["medications"]:
        L.append(f"- {m['name'] or '(unnamed)'} — {m['status']}, {m['date']}"
                 + (f"; for {m['reason']}" if m.get("reason") else "") + (f"; {m['dosage']}" if m.get("dosage") else ""))
    L += ["", "## Allergies", ""] + [f"- {a}" for a in c["allergies"]] + [""]
    if c["procedures"]:
        L += ["## Procedures", ""] + [f"- {x['date']}: {x['name']}" for x in c["procedures"]] + [""]
    L += ["## Labs — latest value, with history", "", "| Test | Latest | Date | Reference | Flag | Earlier |", "|---|---|---|---|---|---|"]
    for name, vals in c["labs"].items():
        e = vals[0]
        earlier = "; ".join(f"{fmt(x)} ({x['date']})" for x in vals[1:4])
        L.append(f"| {name} | {fmt(e)} | {e['date']} | {e['range'] or ''} | {e['flag'] or ''} | {earlier} |")
    L += ["", "## Vitals recorded at visits", "", "| Measure | Readings (newest first) |", "|---|---|"]
    for name, vals in c["vitals"].items():
        L.append(f"| {name} | " + "; ".join(f"{fmt(x)} ({x['date']})" for x in vals[:6]) + " |")
    if c["reports"]:
        L += ["", "## Reports", ""] + [f"- {x['date']}: {x['name']}" + (f" — {x['conclusion']}" if x.get("conclusion") else "") for x in c["reports"]]
    if c["notes"]:
        L += ["", "## Clinician notes (excerpts)", ""] + [f"- {x['date']} {x['name']}: {x['text']}" for x in c["notes"] if x.get("text")]
    return "\n".join(L) + "\n"


if __name__ == "__main__":
    what = sys.argv[1] if len(sys.argv) > 1 else "all"
    if what in ("all", "clinical"):
        import_clinical()
    if what in ("all", "records"):
        import_records()
