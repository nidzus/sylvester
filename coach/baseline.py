"""Baseline report from calibration results.

    python coach/baseline.py      # <data>/records/assessments.csv -> baseline.md, baseline.json

Reads the test catalogue (coach/assessments.json + the person's plans/calibration.json, see
catalogue.py) and every result filed by phone.py sync.
For each test it shows the latest result per side, the change since the previous test, and:
- estimated 1-rep max for rep tests with a load (Epley with reps in reserve: load × (1 + (reps + RIR) / 30),
  RIR = 10 − RPE; RPE defaults to 8, the test's stopping point). Never tested directly.
- a starting weight for 3 × 8–12 at RPE 6–7 (≈ e1RM / 1.45), rounded down to what the equipment allows.
- left/right asymmetry (≥ 15 % is flagged) and every flag, pain or note recorded.
Deterministic: no interpretation here; the Coach reads the report.
"""

import csv
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.dirname(HERE))
import catalogue  # noqa: E402
from core import paths  # noqa: E402

DATA = str(paths.RECORDS)
CSV = os.path.join(DATA, "assessments.csv")
ASYM_FLAG = 15  # % difference between sides worth a look


def num(v):
    try:
        return float(str(v).strip())
    except ValueError:
        return None


def e1rm(load, reps, rpe):
    rir = 10 - (num(rpe) if num(rpe) is not None else 8)
    return load * (1 + (reps + rir) / 30)


def floor_step(x, steps):
    fit = [s for s in steps if s <= x + 1e-9]
    return fit[-1] if fit else None


def load_results():
    if not os.path.exists(CSV):
        return []
    with open(CSV, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def fmt(v):
    return f"{v:g}" if isinstance(v, float) else str(v)


def build():
    cat = catalogue.load()  # shared tests + this person's calibration.json
    all_steps = catalogue.load_steps()
    tests = cat["tests"]
    rows = load_results()
    by_test = {}
    for r in rows:
        by_test.setdefault(r["test"], []).append(r)

    report = {"tests": {}, "starting_weights": [], "asymmetries": [], "flags": []}
    for tid, t in tests.items():
        rs = by_test.get(tid)
        if not rs:
            continue
        dates = sorted({r["date"] for r in rs})
        latest = [r for r in rs if r["date"] == dates[-1]]
        prev = [r for r in rs if r["date"] == dates[-2]] if len(dates) > 1 else []
        entry = {"name": t["name"], "category": t["category"], "date": dates[-1], "sides": {}}
        for r in latest:
            side = r["side"] or "-"
            v = r["value"]
            d = {"value": v, "unit": r["unit"], "load_kg": r["load_kg"], "rpe": r["rpe"], "pain": r["pain"],
                 "flags": r["flags"], "note": r["note"]}
            if t.get("measure") == "score" and num(v) is not None:
                k = len(t["options"]) - int(num(v))
                d["label"] = t["options"][k] if 0 <= k < len(t["options"]) else v
            if t.get("cap") and num(v) is not None and num(v) >= t["cap"]:
                d["capped"] = True
            p = next((x for x in prev if (x["side"] or "-") == side), None)
            if p and num(p["value"]) is not None and num(v) is not None:
                d["previous"] = {"date": p["date"], "value": p["value"], "load_kg": p["load_kg"]}
            if t.get("e1rm") and num(v) and num(r["load_kg"]):
                est = e1rm(num(r["load_kg"]), num(v), r["rpe"])
                d["e1rm_kg"] = round(est, 1)
                d["e1rm_note"] = "rough (many reps)" if num(v) + 10 - (num(r["rpe"]) or 8) > 12 else ""
            entry["sides"][side] = d
            if r["flags"] or (num(r["pain"]) or 0) > 0:
                report["flags"].append({"test": t["name"], "side": side, "flags": r["flags"], "pain": r["pain"], "note": r["note"]})
        # Asymmetry between L and R
        L, R = entry["sides"].get("L"), entry["sides"].get("R")
        if L and R and num(L["value"]) is not None and num(R["value"]) is not None:
            lv, rv = num(L["value"]), num(R["value"])
            if t.get("measure") == "score":
                if lv != rv:
                    report["asymmetries"].append({"test": t["name"], "L": L.get("label", L["value"]), "R": R.get("label", R["value"]), "pct": None})
            elif t.get("unit") == "cm":
                # Girths: 1.5 cm is a real difference. Mobility distances: 3 cm.
                if abs(lv - rv) >= (1.5 if t["category"] == "Body & vitals" else 3):
                    report["asymmetries"].append({"test": t["name"], "L": L["value"], "R": R["value"], "pct": None})
            elif max(lv, rv) > 0:
                pct = round(abs(lv - rv) / max(lv, rv) * 100)
                entry["asymmetry_pct"] = pct
                if pct >= ASYM_FLAG:
                    report["asymmetries"].append({"test": t["name"], "L": L["value"], "R": R["value"], "pct": pct})
        # Starting weight for 3 × 8–12 at RPE 6–7
        ests = [s["e1rm_kg"] for s in entry["sides"].values() if s.get("e1rm_kg")]
        if ests:
            target = min(ests) / 1.45
            implement = t.get("implement", "dumbbell")
            steps = all_steps.get(implement) or []
            pick = floor_step(target, steps) if steps else round(int(target * 2) / 2, 1)
            report["starting_weights"].append({
                "test": t["name"], "e1rm_kg": round(min(ests), 1), "target_kg": round(target, 1),
                "use_kg": pick, "outgrown": bool(steps) and target > steps[-1] * 1.1,
                "per": "bar" if implement == "barbell" else implement})
        report["tests"][tid] = entry
    return report


def render(report):
    out = ["# Baseline", "", "_Generated by `coach/baseline.py` from `data/assessments.csv`. Rep tests are single sets "
           "stopped at RPE 8; 1-rep maxes are estimates, never tested._", ""]
    if not report["tests"]:
        return "\n".join(out + ["No calibration results yet. Push a battery to the phone: `coach/phone.py battery calibration-1`."])
    cats = {}
    for tid, e in report["tests"].items():
        cats.setdefault(e["category"], []).append(e)
    for c, es in cats.items():
        out += [f"## {c}", "", "| Test | Date | Result | Since last | Notes |", "|---|---|---|---|---|"]
        for e in es:
            res, chg, notes = [], [], []
            for side, d in e["sides"].items():
                tag = "" if side == "-" else f"{side} "
                val = d.get("label", d["value"])
                unit = "" if d["unit"] in ("score", "") else f" {d['unit']}"
                cap = "≥ " if d.get("capped") else ""
                load = f" @ {d['load_kg']} kg" if d["load_kg"] else ""
                rpe = f", RPE {d['rpe']}" if d["rpe"] else ""
                est = f" (e1RM ≈ {d['e1rm_kg']:g} kg{', ' + d['e1rm_note'] if d.get('e1rm_note') else ''})" if d.get("e1rm_kg") else ""
                res.append(f"{tag}{cap}{val}{unit}{load}{rpe}{est}")
                if d.get("previous"):
                    p = d["previous"]
                    delta = num(d["value"]) - num(p["value"])
                    chg.append(f"{tag}{delta:+g} (was {p['value']}{' @ ' + p['load_kg'] + ' kg' if p['load_kg'] else ''}, {p['date']})")
                bits = [x for x in (d["flags"], f"pain {d['pain']}" if num(d["pain"]) else "", d["note"]) if x]
                if bits:
                    notes.append(tag + "; ".join(bits))
            if e.get("asymmetry_pct"):
                notes.append(f"L/R differ {e['asymmetry_pct']} %")
            out.append(f"| {e['name']} | {e['date']} | {'<br>'.join(res)} | {'<br>'.join(chg) or '–'} | {'<br>'.join(notes) or ''} |")
        out.append("")
    if report["starting_weights"]:
        out += ["## Starting weights (3 × 8–12 at RPE 6–7)", "", "| Lift | e1RM | Target | Use | |", "|---|---|---|---|---|"]
        for s in report["starting_weights"]:
            use = f"{s['use_kg']:g} kg {s['per']}" if s["use_kg"] else "lighter than the smallest step"
            warn = "outgrown the equipment: needs heavier dumbbells or small plates" if s["outgrown"] else ""
            out.append(f"| {s['test']} | {s['e1rm_kg']:g} kg | {s['target_kg']:g} kg | {use} | {warn} |")
        out.append("")
    if report["asymmetries"]:
        out += ["## Left/right differences worth a look", ""]
        for a in report["asymmetries"]:
            out.append(f"- {a['test']}: L {a['L']}, R {a['R']}" + (f" ({a['pct']} %)" if a["pct"] is not None else ""))
        out.append("")
    if report["flags"]:
        out += ["## Flags, pain and notes", ""]
        for f in report["flags"]:
            side = "" if f["side"] == "-" else f" {f['side']}"
            bits = [x for x in (f["flags"], f"pain {f['pain']}" if num(f["pain"]) else "", f["note"]) if x]
            out.append(f"- {f['test']}{side}: {'; '.join(bits)}")
        out.append("")
    return "\n".join(out)


def main():
    report = build()
    with open(os.path.join(DATA, "baseline.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, ensure_ascii=False)
    with open(os.path.join(DATA, "baseline.md"), "w", encoding="utf-8") as f:
        f.write(render(report) + "\n")
    print(os.path.join(DATA, "baseline.md"))


if __name__ == "__main__":
    sys.exit(main())
