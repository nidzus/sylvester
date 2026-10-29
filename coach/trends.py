#!/usr/bin/env python3
"""
Long-term trends across every source — the heavy analysis the Coach doesn't
redo each day.

    python coach/trends.py        # writes <data>/records/trends.json and trends.md

Monthly averages over all the history available, last-90-days vs the same period a year earlier,
and a handful of within-person correlations (each with its n, so weak
evidence looks weak).
"""

import csv
import json
import os
import sys
from collections import defaultdict
from datetime import date, datetime, timedelta
from statistics import mean

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.dirname(HERE))
from core import paths  # noqa: E402

DATA_DIR = str(paths.RECORDS)
SRC = str(paths.SOURCES)
from snapshot import read_csv, num, MIN_REAL_SLEEP_H  # noqa: E402

OURA = os.path.join(SRC, "oura_daily.csv")
WHOOP = os.path.join(SRC, "whoop_daily.csv")
WITHINGS_M = os.path.join(SRC, "withings_measures.csv")
WITHINGS_D = os.path.join(SRC, "withings_daily.csv")
APPLE = os.path.join(SRC, "apple_daily.csv")
APPLE_BP = os.path.join(SRC, "apple_bp.csv")
APPLE_WO = os.path.join(SRC, "apple_workouts.csv")
POLAR_EX = os.path.join(SRC, "polar_exercises.csv")
CHECKINS = os.path.join(DATA_DIR, "checkins.csv")


def daily_series():
    """date -> merged metrics from every source."""
    days = defaultdict(dict)
    for r in read_csv(OURA):
        d = days[r["date"]]
        for k in ("readiness_score", "steps", "active_calories", "stress_high_min", "temperature_deviation"):
            d[k] = num(r.get(k))
        if (num(r.get("total_sleep_h")) or 0) >= MIN_REAL_SLEEP_H:
            for k in ("total_sleep_h", "avg_hrv", "lowest_hr", "efficiency", "deep_sleep_h"):
                d[k] = num(r.get(k))
    # WHOOP fills the nights Oura doesn't have (someone who switched, or wears only WHOOP). Its recovery
    # score is on a different scale from Oura readiness, so it keeps its own column.
    for r in read_csv(WHOOP):
        d = days[r["date"]]
        d["whoop_recovery"] = num(r.get("readiness_score"))
        for k in ("steps", "active_calories", "temperature_deviation"):
            if d.get(k) is None:
                d[k] = num(r.get(k))
        if (num(r.get("total_sleep_h")) or 0) >= MIN_REAL_SLEEP_H and d.get("avg_hrv") is None:
            for k in ("total_sleep_h", "avg_hrv", "lowest_hr", "efficiency", "deep_sleep_h"):
                d[k] = num(r.get(k))
    for r in read_csv(APPLE):
        d = days[r["date"]]
        for k in ("weight_kg", "body_fat_pct", "bp_systolic", "bp_diastolic", "walking_speed_kmh",
                  "walking_asymmetry_pct", "glucose_mean", "mindful_min"):
            if num(r.get(k)) is not None:
                d[k] = num(r.get(k))
    # Withings scale and BP monitor: the day's mean, which wins over Apple's copy of the same readings.
    per_day = defaultdict(lambda: defaultdict(list))
    for r in read_csv(WITHINGS_M):
        for src, k in (("weight_kg", "weight_kg"), ("fat_pct", "body_fat_pct"), ("systolic", "bp_systolic"), ("diastolic", "bp_diastolic")):
            if num(r.get(src)) is not None:
                per_day[r["time"][:10]][k].append(num(r[src]))
    for day, vals in per_day.items():
        days[day].update({k: round(mean(v), 1) for k, v in vals.items()})
    for r in read_csv(WITHINGS_D):
        d = days[r["date"]]
        if d.get("steps") is None:
            d["steps"] = num(r.get("steps"))
        if (num(r.get("total_sleep_h")) or 0) >= MIN_REAL_SLEEP_H and d.get("total_sleep_h") is None:
            for k in ("total_sleep_h", "deep_sleep_h", "lowest_hr"):
                d[k] = num(r.get(k))
    # Training minutes per day: Polar sessions, plus Apple workouts not auto-detected by Oura (those overlap Polar/Strava rarely)
    seen = set()
    for r in read_csv(POLAR_EX):
        key = r["start_time"][:16]
        if key in seen:
            continue
        seen.add(key)
        d = days[r["start_time"][:10]]
        d["training_min"] = (d.get("training_min") or 0) + (num(r.get("duration_min")) or 0)
    for r in read_csv(APPLE_WO):
        if r["source"] in ("Oura", "Polar Beat") or r["start"][:16] in seen:
            continue
        d = days[r["start"][:10]]
        d["training_min"] = (d.get("training_min") or 0) + (num(r.get("duration_min")) or 0)
    for r in read_csv(CHECKINS):
        d = days[r["date"]]
        for k in ("mood", "energy", "stress", "pain"):
            if num(r.get(k)) is not None:
                d["checkin_" + k] = num(r.get(k))
    return dict(sorted(days.items()))


MONTHLY = [
    ("weight_kg", "Weight kg", "mean"), ("bp_systolic", "BP sys", "mean"), ("bp_diastolic", "BP dia", "mean"),
    ("avg_hrv", "HRV ms", "mean"), ("lowest_hr", "Night HR", "mean"), ("total_sleep_h", "Sleep h", "mean"),
    ("readiness_score", "Readiness", "mean"), ("whoop_recovery", "WHOOP recovery", "mean"),
    ("steps", "Steps", "mean"), ("training_min", "Training min", "sum"),
]


def monthly(days):
    by_month = defaultdict(lambda: defaultdict(list))
    for d, m in days.items():
        for k, _, _ in MONTHLY:
            if m.get(k) is not None:
                by_month[d[:7]][k].append(m[k])
    out = {}
    for month, vals in sorted(by_month.items()):
        out[month] = {k: (round(sum(vals[k])) if how == "sum" else round(mean(vals[k]), 1)) if vals.get(k) else None
                      for k, _, how in MONTHLY}
    return out


def window_mean(days, key, start, end):
    vals = [m[key] for d, m in days.items() if start <= d <= end and m.get(key) is not None]
    return (round(mean(vals), 1), len(vals)) if vals else (None, 0)


def year_over_year(days, today):
    end = today.isoformat()
    start = (today - timedelta(days=89)).isoformat()
    ly_end = (today - timedelta(days=365)).isoformat()
    ly_start = (today - timedelta(days=365 + 89)).isoformat()
    out = {}
    for k, label, _ in MONTHLY:
        if k == "training_min":
            continue
        now, n1 = window_mean(days, k, start, end)
        then, n2 = window_mean(days, k, ly_start, ly_end)
        out[label] = {"last_90d": now, "n": n1, "year_earlier": then, "n_year_earlier": n2,
                      "change": round(now - then, 1) if now is not None and then is not None else None}
    return out


def pearson(pairs):
    pairs = [(x, y) for x, y in pairs if x is not None and y is not None]
    n = len(pairs)
    if n < 20:
        return None, n
    xs, ys = zip(*pairs)
    mx, my = mean(xs), mean(ys)
    sxy = sum((x - mx) * (y - my) for x, y in pairs)
    sxx = sum((x - mx) ** 2 for x in xs)
    syy = sum((y - my) ** 2 for y in ys)
    if not sxx or not syy:
        return None, n
    return round(sxy / (sxx * syy) ** 0.5, 2), n


def next_day(d):
    return (date.fromisoformat(d) + timedelta(days=1)).isoformat()


def correlations(days, today):
    """Within-person relationships over the last 2 years. Oura's row for a date holds the night *ending* that morning."""
    since = (today - timedelta(days=730)).isoformat()
    recent = {d: m for d, m in days.items() if d >= since}

    def lagged(xk, yk):
        return [(m.get(xk), days.get(next_day(d), {}).get(yk)) for d, m in recent.items()]

    def same(xk, yk):
        return [(m.get(xk), m.get(yk)) for m in recent.values()]

    def trained_vs_rest(yk):
        t = [days.get(next_day(d), {}).get(yk) for d, m in recent.items() if (m.get("training_min") or 0) >= 30]
        r_ = [days.get(next_day(d), {}).get(yk) for d, m in recent.items() if not m.get("training_min")]
        t, r_ = [x for x in t if x is not None], [x for x in r_ if x is not None]
        if len(t) < 10 or len(r_) < 10:
            return None
        return {"after_training": round(mean(t), 1), "after_rest": round(mean(r_), 1), "n_training": len(t), "n_rest": len(r_)}

    specs = [
        ("Steps today → HRV tonight", lagged("steps", "avg_hrv")),
        ("Steps today → night HR tonight", lagged("steps", "lowest_hr")),
        ("Daytime stress minutes → HRV tonight", lagged("stress_high_min", "avg_hrv")),
        ("Sleep hours → HRV (same night)", same("total_sleep_h", "avg_hrv")),
        ("Sleep hours → next day's steps", lagged("total_sleep_h", "steps")),
        ("Weight → BP systolic (same day)", same("weight_kg", "bp_systolic")),
        ("Check-in mood ↔ sleep hours", same("checkin_mood", "total_sleep_h")),
        ("Check-in energy ↔ HRV", same("checkin_energy", "avg_hrv")),
    ]
    out = {}
    for label, pairs in specs:
        r_, n = pearson(pairs)
        out[label] = {"r": r_, "n": n}
    out["_training_day_effect"] = {
        "HRV the night after": trained_vs_rest("avg_hrv"),
        "Night HR the night after": trained_vs_rest("lowest_hr"),
        "Readiness next morning": trained_vs_rest("readiness_score"),
        "WHOOP recovery next morning": trained_vs_rest("whoop_recovery"),
    }
    return out


def bp_profile(today):
    rows = read_csv(APPLE_BP) + [r for r in read_csv(WITHINGS_M) if num(r.get("systolic")) and num(r.get("diastolic"))]
    if not rows:
        return None
    by_year = defaultdict(list)
    morning, evening = [], []
    seen = set()
    for r in rows:
        s, d = int(float(r["systolic"])), int(float(r["diastolic"]))
        if (r["time"][:16], s, d) in seen:  # Withings readings also reach Apple Health
            continue
        seen.add((r["time"][:16], s, d))
        by_year[r["time"][:4]].append((s, d))
        hour = int(r["time"][11:13])
        (morning if hour < 12 else evening).append((s, d))
    f = lambda xs: f"{round(mean(x[0] for x in xs))}/{round(mean(x[1] for x in xs))} (n={len(xs)})" if xs else None
    return {"by_year": {y: f(v) for y, v in sorted(by_year.items())}, "morning": f(morning), "afternoon_evening": f(evening)}


def strength(r_):
    if r_ is None:
        return "not enough data"
    a = abs(r_)
    return "negligible" if a < 0.1 else "weak" if a < 0.3 else "moderate" if a < 0.5 else "strong"


def to_markdown(t):
    L = [f"# Trends — generated {t['generated'][:10]}", "",
         "_Built by coach/trends.py from Oura, WHOOP, Withings, Apple Health, Polar and check-ins (whichever are connected). "
         "Apple data end at the last export; re-export to extend._", ""]
    L += ["## Last 90 days vs the same 90 days a year earlier", "", "| Metric | Last 90 d | Year earlier | Change |", "|---|---|---|---|"]
    for k, v in t["year_over_year"].items():
        if not v["n"] and not v["n_year_earlier"]:
            continue
        ch = f"{v['change']:+}" if v["change"] is not None else "–"
        L.append(f"| {k} | {v['last_90d'] if v['last_90d'] is not None else '–'} (n={v['n']}) | "
                 f"{v['year_earlier'] if v['year_earlier'] is not None else '–'} (n={v['n_year_earlier']}) | {ch} |")
    L += ["", "## Within-person relationships (last 2 years)", "",
          "_Correlation r: ±0.1 negligible, ±0.3 weak, ±0.5 moderate. Correlation isn't causation; treat these as hypotheses to test._", "",
          "| Relationship | r | n | Strength |", "|---|---|---|---|"]
    for k, v in t["correlations"].items():
        if k.startswith("_"):
            continue
        L.append(f"| {k} | {v['r'] if v['r'] is not None else '–'} | {v['n']} | {strength(v['r'])} |")
    eff = t["correlations"]["_training_day_effect"]
    L += ["", "**After a training day (≥ 30 min) vs after a rest day:**", ""]
    for k, v in eff.items():
        if v is None and ("WHOOP" in k or "Readiness" in k):  # a score this person has no device for
            continue
        L.append(f"- {k}: " + (f"{v['after_training']} after training (n={v['n_training']}) vs {v['after_rest']} after rest (n={v['n_rest']})"
                              if v else "not enough data"))
    bp = t.get("bp_profile")
    if bp:
        L += ["", "## Home blood pressure", "", "- By year: " + "; ".join(f"{y} {v}" for y, v in bp["by_year"].items()),
              f"- Morning {bp['morning']} vs afternoon/evening {bp['afternoon_evening']}"]
    first_month = f"{date.today().year - 10}-01"  # a decade is plenty for a table
    months = {m: v for m, v in t["monthly"].items() if m >= first_month}
    cols = [(k, label) for k, label, _ in MONTHLY if any(v.get(k) is not None for v in months.values())]
    L += ["", "## Monthly averages", "",
          "| Month | " + " | ".join(label for _, label in cols) + " |", "|---" * (len(cols) + 1) + "|"]
    for month, vals in months.items():
        L.append(f"| {month} | " + " | ".join("" if vals[k] is None else str(vals[k]) for k, _ in cols) + " |")
    return "\n".join(L) + "\n"


def build(today=None):
    today = today or date.today()
    days = daily_series()
    t = {
        "generated": datetime.now().isoformat(timespec="seconds"),
        "year_over_year": year_over_year(days, today),
        "correlations": correlations(days, today),
        "bp_profile": bp_profile(today),
        "monthly": monthly(days),
    }
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(os.path.join(DATA_DIR, "trends.json"), "w", encoding="utf-8") as f:
        json.dump(t, f, indent=2, ensure_ascii=False)
    with open(os.path.join(DATA_DIR, "trends.md"), "w", encoding="utf-8") as f:
        f.write(to_markdown(t))
    return t


if __name__ == "__main__":
    t = build()
    sys.stdout.reconfigure(encoding="utf-8")
    md = to_markdown(t)
    print(md[:md.find("## Monthly averages")])
