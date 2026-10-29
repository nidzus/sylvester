"""Bridge between the data folder and the person's phone page (their own claude.ai artifact,
published from app/phone.html; its link is in <data>/settings.json -> phone_url).

The page keeps its data in the artifact's database; Claude moves documents with the
ArtifactData tool. This script prepares what goes up and files away what comes down.

    python coach/phone.py plan                 # rolling 14 days -> outbox: sessions/day-*, plan/current, config/checkin
    python coach/phone.py status               # -> outbox/status/current.json (recovery only)
    python coach/phone.py session <spec.json>  # one routine or session -> outbox/sessions/<id>.json
    python coach/phone.py battery <id>         # calibration battery -> outbox/sessions/<id>.json
    python coach/phone.py sync                 # inbox/{checkins,workouts,assessments}/*.json -> CSVs

Every command lists pictures not yet on the page as `UPLOAD <path>`; Claude uploads them
(Artifact publish, asset: true) and records each url in <data>/media/phone_assets.json under
its path relative to <data>/media/. `plan` also writes outbox/manifest.json: the documents to
set, and the stale `sessions/day-*` ids to delete.

Session spec: {id, title, date ("" for a reusable routine), order, focus, duration, coach_note,
warmup: [..], exercises: [{lib: <exercise_lib id>, name, sets, reps, unit ("s" for holds),
load_kg, rest, cues: [..], note, implement, tags}]}.

Only training content and recovery status go to the page — never the health profile,
medical records or labs.
"""

import glob
import json
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "app"))

from core import paths, signals  # noqa: E402
import catalogue  # noqa: E402
import exercise_lib  # noqa: E402

PHONE_DIR = str(paths.PHONE)
OUTBOX = os.path.join(PHONE_DIR, "outbox")
INBOX = os.path.join(PHONE_DIR, "inbox")
ASSETS = str(paths.MEDIA / "phone_assets.json")
PRIVATE_KEYS = ("tags", "implement", "routine", "ex", "slot", "ladder")  # planning detail the page doesn't need


def write_json(path, data):
    return str(paths.write_json(path, data))


def status():
    import snapshot
    s = snapshot.build(write=True)
    r = s.get("recovery") or {}
    m = r.get("metrics") or {}
    hrv = m.get("avg_hrv") or {}
    night = r.get("last_night") or {}
    doc = {
        "updated": s["generated"][:16],
        "recovery": {
            "status": r.get("status"),
            "meaning": r.get("status_meaning"),
            "readiness": r.get("readiness_today"),
            "source": r.get("source"),
            "sleep_h": round(night["sleep_h"], 1) if night.get("sleep_h") else None,
            "hrv": night.get("hrv"),
            "hrv_baseline": round(hrv["baseline_60d"]) if hrv.get("baseline_60d") else None,
        },
    }
    print(write_json(os.path.join(OUTBOX, "status", "current.json"), doc))


def with_pictures(items, lib, assets, missing, instructions=True):
    """Resolve each item's `lib` id into name, credit, instructions and uploaded image urls."""
    out = []
    for e in items:
        ex = lib.get(e.get("lib", ""))
        item = {k: v for k, v in e.items() if k != "lib" and k not in PRIVATE_KEYS}
        if ex:
            item.setdefault("name", ex["name"])
            if instructions:
                item.setdefault("instructions", ex.get("instructions", []))
            item["credit"] = ex["license"]
            urls = []
            for path in exercise_lib.fetch(ex["id"], lib):
                rel = os.path.relpath(path, exercise_lib.LIB_DIR).replace(os.sep, "/")
                if rel in assets:
                    urls.append(assets[rel])
                elif os.path.exists(path):
                    missing.append(path)
            item["images"] = urls if len(urls) == len(ex["images"]) else []
        elif e.get("lib"):
            print(f"warning: {e['lib']} not in the exercise library", file=sys.stderr)
        out.append(item)
    return out


def read_assets():
    return paths.read_json(ASSETS, {}) or {}


def report_missing(missing):
    for p in dict.fromkeys(missing):
        print("UPLOAD", p)


def session(spec_path):
    spec = paths.read_json(spec_path)
    missing = []
    doc = {k: v for k, v in spec.items() if k not in ("id", "exercises") and k not in PRIVATE_KEYS}
    doc.setdefault("date", "")
    doc["exercises"] = with_pictures(spec["exercises"], exercise_lib.load(), read_assets(), missing)
    print(write_json(os.path.join(OUTBOX, "sessions", spec["id"] + ".json"), doc))
    report_missing(missing)


def battery(battery_id, date=""):
    """A calibration battery as a phone session (kind "assessment"): the page shows typed inputs per test."""
    cat = catalogue.load()
    b = cat["batteries"][battery_id]
    tests = [{"id": t, **{k: v for k, v in cat["tests"][t].items() if k not in ("needs", "implement")}} for t in b["tests"]]
    missing = []
    doc = {"kind": "assessment", "battery": battery_id, "title": b["title"], "date": date, "order": 0,
           "duration": b.get("duration", ""), "coach_note": b.get("coach_note", ""), "warmup": b.get("warmup", []),
           "tests": with_pictures(tests, exercise_lib.load(), read_assets(), missing, instructions=False)}
    print(write_json(os.path.join(OUTBOX, "sessions", battery_id + ".json"), doc))
    report_missing(missing)


def checkin_config():
    """The person's own check-in scales for the page, with how each level changes the day."""
    out = []
    for s in signals.personal():
        doc = {k: s[k] for k in ("key", "label", "lo", "hi", "hint", "help") if k in s}
        doc["levels"] = {lvl: a.get("day") for lvl, a in (s.get("levels") or {}).items() if a.get("day")}
        out.append(doc)
    return {"signals": out}


def plan():
    """Rebuild the rolling 14 days and stage everything the page shows for them."""
    import rolling
    sched = rolling.build()
    lib, assets, missing = exercise_lib.load(), read_assets(), []
    sessions_dir = os.path.join(OUTBOX, "sessions")
    if os.path.isdir(sessions_dir):
        for p in glob.glob(os.path.join(sessions_dir, "day-*.json")):
            os.remove(p)
    ids, strip = [], []
    for d in sched["days"]:
        strip.append({k: d[k] for k in ("date", "weekday", "kind", "title", "intensity", "reasons", "note", "phase") if d.get(k)})
        s = d.get("session")
        if not s:
            continue
        doc = {k: v for k, v in s.items() if k not in ("id", "exercises", "easy", "anywhere") and k not in PRIVATE_KEYS}
        doc["optional"] = d["kind"] == "optional"

        def variant(v):  # easier and no-equipment versions, with their pictures
            out = {**v, "exercises": with_pictures(v["exercises"], lib, assets, missing)}
            if v.get("anywhere"):
                out["anywhere"] = variant(v["anywhere"])
            return out
        doc.update(variant({k: s[k] for k in ("exercises", "anywhere") if k in s}))
        if s.get("easy"):
            doc["easy"] = variant(s["easy"])
        write_json(os.path.join(sessions_dir, s["id"] + ".json"), doc)
        ids.append(s["id"])
    write_json(os.path.join(OUTBOX, "plan", "current.json"),
               {"updated": sched["generated"][:16], "phase": sched.get("phase", {}).get("name", ""), "today": sched["today"], "days": strip})
    write_json(os.path.join(OUTBOX, "config", "checkin.json"), checkin_config())
    write_json(os.path.join(OUTBOX, "manifest.json"), {
        "set": [f"sessions/{i}" for i in ids] + ["plan/current", "config/checkin"],
        "keep_day_sessions": ids,
        "note": "Delete any sessions/day-* document on the page that is not in keep_day_sessions.",
    })
    print(f"{len(ids)} sessions in the next 14 days -> {OUTBOX}")
    report_missing(missing)


def sync():
    """File phone check-ins, workouts and calibration results into the CSVs. Idempotent: a check-in
    replaces that date's row; a workout replaces that date + session; results replace that date + battery."""
    import server
    n_c = n_w = n_a = 0
    for path in sorted(glob.glob(os.path.join(INBOX, "assessments", "*.json"))):
        a = paths.read_json(path)
        a = a.get("data", a)
        if a.get("date") and a.get("battery"):
            server.save_assessment(a)
            n_a += 1
    for path in sorted(glob.glob(os.path.join(INBOX, "checkins", "*.json"))):
        c = paths.read_json(path)
        c = c.get("data", c)  # tolerate a {data: ...} wrapper
        if c.get("date"):
            server.save_checkin(c)
            n_c += 1
    for path in sorted(glob.glob(os.path.join(INBOX, "workouts", "*.json"))):
        w = paths.read_json(path)
        w = w.get("data", w)
        if w.get("date") and w.get("session"):
            server.save_workout(w)
            n_w += 1
    print(f"synced {n_c} check-ins, {n_w} workouts, {n_a} calibration sessions")


def clear_inbox():
    shutil.rmtree(INBOX, ignore_errors=True)
    print("cleared", INBOX)


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "status":
        status()
    elif cmd == "plan":
        plan()
    elif cmd == "session" and len(sys.argv) > 2:
        session(sys.argv[2])
    elif cmd == "battery" and len(sys.argv) > 2:
        battery(sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else "")
    elif cmd == "sync":
        sync()
    elif cmd == "clear-inbox":
        clear_inbox()
    else:
        print(__doc__)
