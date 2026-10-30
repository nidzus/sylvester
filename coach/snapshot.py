#!/usr/bin/env python3
"""
Condense the raw CSVs into one current-state summary for the Coach.

    python coach/snapshot.py        # writes <data>/records/snapshot.json and snapshot.md

Recovery is judged against your own baseline (the 60 days before the last 7),
not population norms.
"""

import csv
import json
import os
import sys
from collections import defaultdict
from datetime import date, datetime, timedelta
from statistics import mean

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
from core import paths, signals  # noqa: E402

DATA_DIR = str(paths.RECORDS)
SRC = str(paths.SOURCES)

OURA = os.path.join(SRC, "oura_daily.csv")
WHOOP = os.path.join(SRC, "whoop_daily.csv")
WITHINGS_M = os.path.join(SRC, "withings_measures.csv")
# Daily score bands per ring/strap: (red below, green from). Oura readiness and WHOOP recovery differ.
BANDS = {"Oura": (70, 80), "WHOOP": (34, 67)}
POLAR_EX = os.path.join(SRC, "polar_exercises.csv")
POLAR_PHYS = os.path.join(SRC, "polar_physical.csv")
POLAR_TESTS = os.path.join(SRC, "polar_fitness_tests.csv")
APPLE_DAILY = os.path.join(SRC, "apple_daily.csv")
APPLE_BP = os.path.join(SRC, "apple_bp.csv")
APPLE_ME = os.path.join(DATA_DIR, "apple_me.json")
PROFILE = str(paths.PROFILE / "health_profile.json")
CHECKINS = os.path.join(DATA_DIR, "checkins.csv")
WORKOUT_LOG = os.path.join(DATA_DIR, "workout_log.csv")

MIN_REAL_SLEEP_H = 2.0  # shorter records are naps or a ring that came off


def read_csv(path):
    if not os.path.exists(path):
        return []
    with open(path, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def num(v):
    try:
        f = float(v) if v not in (None, "") else None
    except ValueError:
        return None
    return int(f) if f is not None and f.is_integer() else f


def avg(rows, key):
    vals = [num(r.get(key)) for r in rows]
    vals = [v for v in vals if v is not None]
    return round(mean(vals), 1) if vals else None


def sleep_rows(rows):
    return [r for r in rows if (num(r.get("total_sleep_h")) or 0) >= MIN_REAL_SLEEP_H]


def recovery_source():
    """The recovery wearable with the most recent data: Oura or WHOOP (same column names)."""
    best = None
    for name, path in (("Oura", OURA), ("WHOOP", WHOOP)):
        rows = sorted(read_csv(path), key=lambda r: r["date"])
        if rows and (best is None or rows[-1]["date"] > best[1][-1]["date"]):
            best = (name, rows)
    return best


def recovery(today):
    src = recovery_source()
    if not src:
        return None
    source, rows = src
    red_below, green_from = BANDS[source]
    by_date = {r["date"]: r for r in rows}
    d7 = {(today - timedelta(days=i)).isoformat() for i in range(7)}
    d60 = {(today - timedelta(days=i)).isoformat() for i in range(7, 67)}
    last7 = [by_date[d] for d in d7 if d in by_date]
    base = [by_date[d] for d in d60 if d in by_date]

    latest = next((r for r in reversed(rows) if num(r.get("readiness_score")) is not None), rows[-1])
    last_night = next((r for r in reversed(rows) if (num(r.get("total_sleep_h")) or 0) >= MIN_REAL_SLEEP_H), None)

    metrics = {}
    for key, label, src in [
        ("readiness_score", "Readiness" if source == "Oura" else "Recovery", None),
        ("avg_hrv", "HRV (ms)", "sleep"),
        ("lowest_hr", "Lowest night HR (bpm)", "sleep"),
        ("total_sleep_h", "Sleep (h)", "sleep"),
        ("sleep_score", "Sleep score", None),
        ("steps", "Steps", None),
    ]:
        a, b = (sleep_rows(last7), sleep_rows(base)) if src == "sleep" else (last7, base)
        m7, m60 = avg(a, key), avg(b, key)
        metrics[key] = {
            "label": label,
            "last_7d": m7,
            "baseline_60d": m60,
            "delta_pct": round((m7 - m60) / m60 * 100, 1) if m7 is not None and m60 else None,
        }

    flags = []
    hrv = metrics["avg_hrv"]
    if hrv["delta_pct"] is not None and hrv["delta_pct"] <= -10:
        flags.append(f"HRV {abs(hrv['delta_pct'])}% below your baseline this week")
    rhr = metrics["lowest_hr"]
    if rhr["last_7d"] is not None and rhr["baseline_60d"] is not None and rhr["last_7d"] - rhr["baseline_60d"] >= 3:
        flags.append(f"Night resting HR up {round(rhr['last_7d'] - rhr['baseline_60d'], 1)} bpm vs baseline")
    sl = metrics["total_sleep_h"]["last_7d"]
    if sl is not None and sl < 6.5:
        flags.append(f"Averaging {sl} h sleep this week (under 6.5 h)")
    temp = num(latest.get("temperature_deviation"))
    if temp is not None and temp >= 0.5:
        flags.append(f"Body temperature +{temp} °C — possible illness, don't train hard")
    short_nights = sum(1 for r in last7 if 0 < (num(r.get("total_sleep_h")) or 0) < MIN_REAL_SLEEP_H or not r.get("total_sleep_h"))
    if short_nights >= 3:
        flags.append(f"{short_nights} of the last 7 nights have missing or partial sleep data — trends less reliable")

    score = num(latest.get("readiness_score"))
    hard_flags = [f for f in flags if "data" not in f]
    if (temp is not None and temp >= 0.5) or (score is not None and score < red_below) or len(hard_flags) >= 2:
        status = "red"
    elif (score is not None and score >= green_from) and not hard_flags:
        status = "green"
    else:
        status = "amber"
    # Why, in the words the phone shows: the score against its bands, then what the flags add.
    name = metrics["readiness_score"]["label"].lower()
    why = []
    if temp is not None and temp >= 0.5:
        why.append(f"temperature +{temp} °C")
    if score is not None:
        why.append(f"{name} {score:g} is under {red_below}" if score < red_below else
                   f"{name} {score:g} (green from {green_from})" if score < green_from else f"{name} {score:g}")
    why += [f[0].lower() + f[1:] for f in hard_flags if not f.startswith("Body temperature")]

    return {
        "status": status,
        "status_why": why,
        "status_meaning": {
            "green": "Train as planned; a hard session is fine.",
            "amber": "Train, but cap intensity (RPE ≤ 7) or trim volume ~20–30%.",
            "red": "Recovery day: mobility, easy zone-2 walk/cycle, or rest.",
        }[status],
        "source": source,
        "latest_date": latest["date"],
        "readiness_today": score,
        "temperature_deviation": temp,
        "resilience": latest.get("resilience_level") or None,
        "stress": latest.get("stress_summary") or None,
        "last_night": None if not last_night else {
            "date": last_night["date"],
            "sleep_h": num(last_night["total_sleep_h"]),
            "deep_h": num(last_night.get("deep_sleep_h")),
            "rem_h": num(last_night.get("rem_sleep_h")),
            "efficiency": num(last_night.get("efficiency")),
            "hrv": num(last_night.get("avg_hrv")),
            "lowest_hr": num(last_night.get("lowest_hr")),
        },
        "metrics": metrics,
        "flags": flags,
    }


def training(today):
    seen, sessions = set(), []
    for r in read_csv(POLAR_EX):
        try:
            start = datetime.fromisoformat(r["start_time"][:19])
        except ValueError:
            continue
        key = start.strftime("%Y-%m-%dT%H:%M")  # same session can arrive from both the export and the API
        if key in seen:
            continue
        seen.add(key)
        sessions.append({
            "start": start,
            "sport": (r.get("sport") or "-").replace("_", " ").title(),
            "minutes": round(num(r.get("duration_min")) or 0),
            "load": round(num(r.get("training_load")) or 0, 1),
            "hr_avg": num(r.get("hr_avg")),
            "hr_max": num(r.get("hr_max")),
        })
    sessions.sort(key=lambda s: s["start"])
    if not sessions:
        return None

    def window(days):
        since = datetime.combine(today - timedelta(days=days - 1), datetime.min.time())
        w = [s for s in sessions if s["start"] >= since]
        return {
            "sessions": len(w),
            "minutes": round(sum(s["minutes"] or 0 for s in w)),
            "load": round(sum(s["load"] or 0 for s in w), 1),
        }

    w7, w28 = window(7), window(28)
    chronic = w28["load"] / 4
    # The ratio only means something with a steady training history; one walk in a month reads as a "spike".
    enough = w28["sessions"] >= 6
    acwr = round(w7["load"] / chronic, 2) if chronic and enough else None
    last = sessions[-1]
    return {
        "source": "Polar (heart-rate sessions only — sets/reps/loads are not recorded yet)",
        "last_7d": w7,
        "last_28d": w28,
        "acute_chronic_ratio": acwr,
        "acwr_note": "too few recorded sessions in 28 days to judge" if acwr is None else (
            "low — room to build" if acwr < 0.8 else
            "in the productive range" if acwr <= 1.3 else
            "spiking — injury risk rises above ~1.5"
        ),
        "days_since_last_session": (today - last["start"].date()).days,
        "recent": [
            {**{k: v for k, v in s.items() if k != "start"}, "date": s["start"].date().isoformat()}
            for s in sessions[-10:]
        ][::-1],
    }


def load_json(path):
    if not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def scale_rows():
    """Weight and body-fat readings from Apple Health and Withings, one per day (Withings wins a tie)."""
    by = {}
    for r in read_csv(APPLE_DAILY):
        if num(r.get("weight_kg")) or num(r.get("body_fat_pct")):
            by[r["date"]] = {"date": r["date"], "weight_kg": r.get("weight_kg"), "body_fat_pct": r.get("body_fat_pct"), "source": "Apple Health"}
    for r in read_csv(WITHINGS_M):
        if num(r.get("weight_kg")) or num(r.get("fat_pct")):
            d, old = r["time"][:10], by.get(r["time"][:10], {})
            by[d] = {"date": d, "weight_kg": r.get("weight_kg") or old.get("weight_kg"),
                     "body_fat_pct": r.get("fat_pct") or old.get("body_fat_pct"), "source": "Withings"}
    return [by[d] for d in sorted(by)]


def body(today):
    """Weight from a smart scale (via Apple Health) beats Polar's setting, which is only updated by hand."""
    profile = load_json(PROFILE).get("basics", {})
    me = load_json(APPLE_ME)
    phys = read_csv(POLAR_PHYS)
    p = phys[-1] if phys else {}
    scale = scale_rows()
    apple = [r for r in scale if num(r.get("weight_kg"))]

    out = {}
    dob = profile.get("dob") or me.get("date_of_birth")
    if dob:
        b = date.fromisoformat(dob)
        out["age"] = today.year - b.year - ((today.month, today.day) < (b.month, b.day))
    out["sex"] = profile.get("sex") or me.get("sex")

    height = num(profile.get("height_cm")) or num(p.get("height"))
    out["height_cm"] = height
    if apple:
        last = apple[-1]
        w = num(last["weight_kg"])
        out.update({"weight_kg": w, "weight_date": last["date"], "weight_source": f"scale ({last['source']})"})

        def change(days):
            since = (date.fromisoformat(last["date"]) - timedelta(days=days)).isoformat()
            older = [r for r in apple if r["date"] <= since]
            return round(w - num(older[-1]["weight_kg"]), 1) if older else None

        out["weight_change_kg"] = {"30d": change(30), "90d": change(90), "365d": change(365)}
        fat = [r for r in scale if num(r.get("body_fat_pct"))]
        if fat:
            out["body_fat_pct"] = num(fat[-1]["body_fat_pct"])
            out["body_fat_date"] = fat[-1]["date"]
    elif p:
        out.update({"weight_kg": num(p.get("weight")), "weight_date": p.get("created", "")[:10], "weight_source": "Polar profile setting"})
    if num(profile.get("weight_kg")) and (not out.get("weight_date") or (profile.get("weight_date") or "") > out["weight_date"]):
        out.update({"weight_kg": num(profile["weight_kg"]), "weight_source": "profile"})
    if out.get("weight_kg") and height:
        out["bmi"] = round(out["weight_kg"] / (height / 100) ** 2, 1)
    if out.get("weight_date"):
        out["weight_age_days"] = (today - date.fromisoformat(out["weight_date"])).days

    if p:
        out.update({
            "vo2max_polar_setting": num(p.get("vo2_max")),
            "resting_hr_polar_setting": num(p.get("resting_hr")),
            "max_hr_polar_setting": num(p.get("max_hr")),
        })
    if out.get("age"):
        out["max_hr_age_estimate"] = round(208 - 0.7 * out["age"])  # Tanaka; a guide, not a measurement
    return out


def fitness_tests():
    tests = read_csv(POLAR_TESTS)
    if not tests:
        return {}
    return {"fitness_tests_recent": [
        {"date": t["date"], "vo2max_estimate": num(t["own_index"]), "class": t["fitness_class"]}
        for t in tests[-5:]
    ]}


def bp_category(sys_, dia):
    if sys_ >= 180 or dia >= 120:
        return "crisis range"
    if sys_ >= 140 or dia >= 90:
        return "stage 2"
    if sys_ >= 130 or dia >= 80:
        return "stage 1"
    if sys_ >= 120:
        return "elevated"
    return "normal"


def blood_pressure(today):
    """Home readings via Apple Health and Withings, plus any typed into the daily check-in."""
    readings = [{"time": r["time"], "sys": int(r["systolic"]), "dia": int(r["diastolic"]), "source": "Apple Health"}
                for r in read_csv(APPLE_BP)]
    readings += [{"time": r["time"], "sys": int(float(r["systolic"])), "dia": int(float(r["diastolic"])), "source": "Withings"}
                 for r in read_csv(WITHINGS_M) if num(r.get("systolic")) and num(r.get("diastolic"))]
    for c in read_csv(CHECKINS):
        parts = (c.get("bp") or "").replace(" ", "").split("/")
        if len(parts) == 2 and all(x.isdigit() for x in parts):
            readings.append({"time": c["date"] + "T00:00:00", "sys": int(parts[0]), "dia": int(parts[1]), "source": "check-in"})
    if not readings:
        return None
    readings.sort(key=lambda x: x["time"])
    last = readings[-1]
    since = (date.fromisoformat(last["time"][:10]) - timedelta(days=30)).isoformat()
    month = [x for x in readings if x["time"][:10] >= since]
    s, d = round(mean(x["sys"] for x in month)), round(mean(x["dia"] for x in month))
    return {
        "latest": {"date": last["time"][:10], "reading": f"{last['sys']}/{last['dia']}", "source": last["source"]},
        "latest_age_days": (today - date.fromisoformat(last["time"][:10])).days,
        "last_30d_of_readings": {"n": len(month), "avg": f"{s}/{d}", "category": bp_category(s, d),
                                 "highest": "{sys}/{dia}".format(**max(month, key=lambda x: (x["sys"], x["dia"])))},
    }


def wellbeing(today):
    rows = read_csv(CHECKINS)
    if not rows:
        return None
    since = (today - timedelta(days=6)).isoformat()
    week = [r for r in rows if r["date"] >= since]
    out = {"days_logged_7d": len(week), "latest": rows[-1],
           "signals": [{"key": s["key"], "label": s["label"], "scale": f"{s['lo']}–{s['hi']}"} for s in signals.personal()]}
    for k in signals.BASE_KEYS + [s["key"] for s in out["signals"]]:
        out[f"{k}_7d"] = avg(week, k)
    return out


def logged_workouts(today):
    rows = read_csv(WORKOUT_LOG)
    if not rows:
        return None
    since = (today - timedelta(days=13)).isoformat()
    sessions = defaultdict(list)
    for r in rows:
        if r["date"] >= since:
            sessions[(r["date"], r["session"])].append(r)
    return [{
        "date": d, "session": s,
        "exercises": [f"{r['exercise']} {r['sets'] + '×' if r['sets'] else ''}{r['reps']}"
                      f"{' @ ' + r['load_kg'] + ' kg' if r['load_kg'] else ''}{' RPE ' + r['rpe'] if r['rpe'] else ''}"
                      f"{' pain ' + r['pain'] if r['pain'] not in ('', '0') else ''}" for r in rs],
    } for (d, s), rs in sorted(sessions.items(), reverse=True)]


def to_markdown(s):
    L = [f"# Snapshot — {s['generated'][:16].replace('T', ' ')}", ""]
    r = s.get("recovery")
    if r:
        L += [f"## Recovery: **{r['status'].upper()}** — {r['status_meaning']}", "",
              f"- {'WHOOP recovery' if r.get('source') == 'WHOOP' else 'Readiness'} ({r['latest_date']}): **{r['readiness_today']}**"
              + (f", temperature {r['temperature_deviation']:+} °C" if r['temperature_deviation'] is not None else "")
              + (f", resilience *{r['resilience']}*" if r['resilience'] else "")]
        n = r.get("last_night")
        if n:
            L.append(f"- Last full night ({n['date']}): {n['sleep_h']} h sleep, deep {n['deep_h']} h, "
                     f"REM {n['rem_h']} h, HRV {n['hrv']} ms, lowest HR {n['lowest_hr']}")
        L += ["", "| Metric | Last 7 d | 60-d baseline | Δ |", "|---|---|---|---|"]
        for m in r["metrics"].values():
            d = f"{m['delta_pct']:+}%" if m["delta_pct"] is not None else "–"
            L.append(f"| {m['label']} | {m['last_7d']} | {m['baseline_60d']} | {d} |")
        if r["flags"]:
            L += ["", "**Flags**"] + [f"- {f}" for f in r["flags"]]
        L.append("")
    t = s.get("training")
    if t:
        L += ["## Training load", "",
              f"- Last 7 d: {t['last_7d']['sessions']} sessions, {t['last_7d']['minutes']} min, load {t['last_7d']['load']}",
              f"- Last 28 d: {t['last_28d']['sessions']} sessions, {t['last_28d']['minutes']} min, load {t['last_28d']['load']}",
              f"- Acute:chronic ratio: {t['acute_chronic_ratio'] if t['acute_chronic_ratio'] is not None else '–'} ({t['acwr_note']})",
              f"- Days since last recorded session: {t['days_since_last_session']}",
              f"- _{t['source']}_", "", "| Date | Sport | Min | Avg HR | Load |", "|---|---|---|---|---|"]
        for x in t["recent"]:
            L.append(f"| {x['date']} | {x['sport']} | {x['minutes']} | {x['hr_avg']} | {x['load']} |")
        L.append("")
    w = s.get("logged_workouts")
    L += ["## Logged workouts (last 14 days)", ""]
    if w:
        for x in w:
            L.append(f"- **{x['date']} · {x['session']}**: " + "; ".join(x["exercises"]))
    else:
        L.append("- Nothing logged yet (phone page or form → Log tab).")
    L.append("")
    wb = s.get("wellbeing")
    if wb:
        L += ["## Check-ins (1–5; pain 0–10)", "",
              f"- Logged {wb['days_logged_7d']} of last 7 days. 7-day averages: mood {wb['mood_7d']}, energy {wb['energy_7d']}, "
              f"stress {wb['stress_7d']}, motivation {wb['motivation_7d']}, soreness {wb['soreness_7d']}, pain {wb['pain_7d']}"
              + "".join(f", {s['label'].lower()} {wb.get(s['key'] + '_7d')} ({s['scale']})" for s in wb.get("signals", [])),
              f"- Latest ({wb['latest']['date']}): " + ", ".join(f"{k} {v}" for k, v in wb["latest"].items() if v and k != "date"), ""]
    bp = s.get("blood_pressure")
    if bp:
        m = bp["last_30d_of_readings"]
        L += ["## Blood pressure (home)", "",
              f"- Latest {bp['latest']['reading']} on {bp['latest']['date']} ({bp['latest']['source']}) — {bp['latest_age_days']} days ago",
              f"- 30 days up to then: {m['n']} readings, average {m['avg']} (**{m['category']}**), highest {m['highest']}"]
        if bp["latest_age_days"] > 21:
            L.append("- _Stale: re-export Apple Health and run `sylvester.py import apple`, or type readings into the daily check-in._")
        L.append("")
    b = s.get("body")
    if b:
        L += ["## Body", ""]
        who = ", ".join(x for x in (f"{b['age']} y" if b.get("age") else "", b.get("sex") or "") if x)
        if who:
            L.append(f"- {who}")
        if b.get("weight_kg"):
            ch = b.get("weight_change_kg") or {}
            L.append(f"- **{b['weight_kg']} kg** on {b.get('weight_date')} ({b.get('weight_source')}, {b.get('weight_age_days')} days ago); "
                     f"height {b['height_cm']} cm; BMI {b.get('bmi')}")
            if ch:
                L.append(f"- Weight change: 30 d {ch.get('30d')}, 90 d {ch.get('90d')}, 12 mo {ch.get('365d')} kg")
        if b.get("body_fat_pct"):
            L.append(f"- Body fat {b['body_fat_pct']} % ({b['body_fat_date']})")
        if b.get("max_hr_polar_setting") or b.get("max_hr_age_estimate"):
            obs = b.get("max_hr_observed_3y")
            L.append(f"- Max HR: Polar setting {b.get('max_hr_polar_setting')}, age estimate {b.get('max_hr_age_estimate')}"
                     + (f", highest seen in a Polar session (3 y) {obs['bpm']} on {obs['date']}" if obs else "")
                     + " — zones should use the higher of observed peak and estimate until a field test")
        if b.get("vo2max_polar_setting"):
            L.append(f"- Polar settings: VO2max {b['vo2max_polar_setting']}, resting HR {b['resting_hr_polar_setting']}")
        for ft in b.get("fitness_tests_recent", []):
            L.append(f"- Fitness test {ft['date']}: VO2max est. {ft['vo2max_estimate']} ({ft['class']})")
    return "\n".join(L) + "\n"


def build(write=True, today=None):
    today = today or date.today()
    b = body(today)
    b.update(fitness_tests())
    cutoff = (today - timedelta(days=3 * 365)).isoformat()
    peaks = [(num(r.get("hr_max")), r["start_time"][:10]) for r in read_csv(POLAR_EX)
             if r.get("start_time", "") >= cutoff and num(r.get("hr_max"))]
    if peaks:
        hr, day = max(peaks)
        b["max_hr_observed_3y"] = {"bpm": hr, "date": day}
    s = {
        "generated": datetime.now().isoformat(timespec="seconds"),
        "recovery": recovery(today),
        "training": training(today),
        "logged_workouts": logged_workouts(today),
        "wellbeing": wellbeing(today),
        "blood_pressure": blood_pressure(today),
        "body": b,
    }
    if write:
        os.makedirs(DATA_DIR, exist_ok=True)
        with open(os.path.join(DATA_DIR, "snapshot.json"), "w", encoding="utf-8") as f:
            json.dump(s, f, indent=2, ensure_ascii=False)
        with open(os.path.join(DATA_DIR, "snapshot.md"), "w", encoding="utf-8") as f:
            f.write(to_markdown(s))
    return s


if __name__ == "__main__":
    s = build()
    sys.stdout.reconfigure(encoding="utf-8")
    print(to_markdown(s))
