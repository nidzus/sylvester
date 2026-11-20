#!/usr/bin/env python3
"""Sylvester: one entry point for everything that runs on this computer. Same commands on Windows and macOS.

    python sylvester.py init [folder]        create the personal data folder (default ~/health-data) and link it
    python sylvester.py where                show the data folder and what's in it
    python sylvester.py check                self-check: Python, folders, sources, schedule, phone page
    python sylvester.py setup [--lan]        the onboarding wizard in the browser (ends itself when finished)
    python sylvester.py form [--lan]         the local form: profile, equipment, goals, check-ins, workouts
    python sylvester.py connect oura|polar|whoop|withings   one-time sign-in to a wearable (opens the browser)
    python sylvester.py pull [source]       pull wearable data now (default: every connected source)
    python sylvester.py import apple         rebuild Apple Health CSVs from <data>/imports/apple_health_export/
    python sylvester.py import polar <dir>   backfill history from a Polar account export
    python sylvester.py daily                pull + snapshot + trends + roll the 14-day plan (the scheduled task)
    python sylvester.py schedule [HH:MM]     run `daily` every day (Task Scheduler / launchd); unschedule removes it
    python sylvester.py images               download pictures for every exercise the plan uses
    python sylvester.py plan                 rebuild the rolling 14 days now and show them
    python sylvester.py next                 the one next step (Claude Code runs this when a session starts; init sets that up)
    python sylvester.py export [file]        everything the iPhone app needs, in one file (no passwords or tokens)

On macOS use `python3` instead of `python`.
"""

import json
import os
import platform
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path

APP = Path(__file__).resolve().parent
sys.path.insert(0, str(APP))
from core import paths  # noqa: E402

PY = sys.executable
SYSTEM = platform.system()  # "Windows", "Darwin", "Linux"
TASK = "Sylvester daily"
LAUNCHD = Path.home() / "Library" / "LaunchAgents" / "com.sylvester.daily.plist"
WEARABLES = ("oura", "polar", "whoop", "withings")  # each has ingest/<name>_pull.py with auth and pull
FOLDERS = ["profile", "records", "sources", "imports", "secrets", "plans", "media", "phone", "logs"]


def run(script, *args, log=None):
    cmd = [PY, str(APP / script), *args]
    if log:
        with open(log, "a", encoding="utf-8") as f:
            f.write(f"\n== {datetime.now():%Y-%m-%d %H:%M} {' '.join([script, *args])}\n")
            f.flush()
            return subprocess.call(cmd, stdout=f, stderr=subprocess.STDOUT, cwd=str(APP))
    return subprocess.call(cmd, cwd=str(APP))


# ---------- init / where / check ----------

# Data-folder upgrades, oldest first: (schema it produces, what it does, function(data_folder)).
# Each runs once, in order, when a folder's settings.json "schema" is older.
def _schema_1(data):
    """Version 1: the layout of the first release. Nothing to change; folders from before versioning get the number."""


MIGRATIONS = [(1, "first versioned layout", _schema_1)]


def migrate(quiet=False):
    """Bring the data folder up to paths.SCHEMA. Returns (old, new); exits if the app is older than the data."""
    if not paths.DATA.exists():
        return None, None
    s = paths.settings()
    old = int(s.get("schema") or 0)
    if old > paths.SCHEMA:
        sys.exit(f"Your data folder is newer (version {old}) than this copy of Sylvester (version {paths.SCHEMA}). "
                 f"Update the app: git -C \"{APP}\" pull")
    for version, what, fn in MIGRATIONS:
        if old < version:
            fn(paths.DATA)
            s["schema"] = version
            paths.save_settings(s)
            if not quiet and version > 1:
                print(f"Upgraded the data folder to version {version}: {what}")
    return old, int(s.get("schema") or 0)


def link_settings(cfg, data, old, hook):
    """Claude Code's local settings for this app folder (uncommitted), updated in place and returned:
    access to the data folder, and a SessionStart hook running `next` (one line on where setup stands).
    After a move (a new app folder or data folder) the stale entries are replaced, not kept beside the new ones:
    the previously linked data folder loses its access, and the hook points at this app folder."""
    dirs = cfg.setdefault("permissions", {}).setdefault("additionalDirectories", [])
    if old and str(old) != str(data) and str(old) in dirs:
        dirs.remove(str(old))
    if str(data) not in dirs:
        dirs.append(str(data))
    starts = cfg.setdefault("hooks", {}).setdefault("SessionStart", [])
    ours = [h for s in starts for h in s.get("hooks", []) if h.get("command", "").endswith("sylvester.py\" next")]
    for h in ours:
        h["command"] = hook
    if not ours:
        starts.append({"hooks": [{"type": "command", "command": hook, "timeout": 20}]})
    return cfg


def init(folder=None):
    data = Path(folder).expanduser().resolve() if folder else paths.data_root()
    if (data / ".git").exists() or data == APP or APP in data.parents:
        sys.exit(f"{data} is inside the app or a git repository. Pick a separate folder, e.g. {Path.home() / 'health-data'}.")
    for d in FOLDERS:
        (data / d).mkdir(parents=True, exist_ok=True)
    tpl = paths.TEMPLATES / "profile"
    for f in tpl.glob("*.json"):
        dest = data / "profile" / f.name
        if not dest.exists():
            shutil.copy2(f, dest)
    settings = data / "settings.json"
    s = {**paths.DEFAULT_SETTINGS, **(json.loads(settings.read_text(encoding="utf-8")) if settings.exists() else {})}
    s["python"] = PY
    s["schema"] = s.get("schema") or paths.SCHEMA  # a new folder starts at the current layout
    settings.write_text(json.dumps(s, indent=2), encoding="utf-8")
    try:
        old = json.loads(paths.POINTER.read_text(encoding="utf-8")).get("data") if paths.POINTER.exists() else None
    except ValueError:
        old = None
    paths.POINTER.write_text(json.dumps({"data": str(data)}, indent=2), encoding="utf-8")
    local = APP / ".claude" / "settings.local.json"
    cfg = json.loads(local.read_text(encoding="utf-8")) if local.exists() else {}
    hook = f'"{Path(PY).as_posix()}" "{(APP / "sylvester.py").as_posix()}" next'
    local.parent.mkdir(exist_ok=True)
    local.write_text(json.dumps(link_settings(cfg, data, old, hook), indent=2), encoding="utf-8")
    if (APP / ".git").exists():
        subprocess.call(["git", "config", "core.hooksPath", "tools/hooks"], cwd=str(APP))
    print(f"Data folder ready: {data}")
    print(f"Linked in {paths.POINTER}")
    print("Next: python sylvester.py setup (the onboarding wizard), then /sylvester:setup in Claude Code.")


def where():
    s = paths.settings()
    print(f"app      {paths.APP}")
    print(f"data     {paths.DATA}" + ("" if paths.DATA.exists() else "   (missing: run `sylvester.py init`)"))
    print(f"python   {s.get('python') or PY}")
    print(f"phone    {s.get('phone_url') or '(not published yet)'}")
    plan = paths.active_plan_dir()
    print(f"plan     {plan.name if plan else '(none yet)'}")
    for name in ("PROFILE", "RECORDS", "SOURCES", "IMPORTS", "SECRETS", "PLANS", "MEDIA", "PHONE", "LOGS"):
        print(f"{name.lower():8} {getattr(paths, name)}")


def scheduled():
    if SYSTEM == "Windows":
        return subprocess.call(["schtasks", "/Query", "/TN", TASK], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) == 0
    if SYSTEM == "Darwin":
        return LAUNCHD.exists()
    return None


def https_ok():
    """True if HTTPS works, False if certificates are missing, None if offline."""
    import ssl
    import urllib.error
    import urllib.request
    try:
        urllib.request.urlopen("https://api.ouraring.com", timeout=5).close()
        return True
    except urllib.error.HTTPError:
        return True  # the server answered: certificates are fine
    except urllib.error.URLError as e:
        return False if isinstance(e.reason, ssl.SSLCertVerificationError) else None
    except OSError:
        return None


def check():
    ok = True

    def line(good, text, fix=""):
        nonlocal ok
        ok &= bool(good) or good is None
        mark = "ok " if good else ("-- " if good is None else "!! ")
        print(f"{mark} {text}" + (f"\n      → {fix}" if fix and not good else ""))

    print(f"Sylvester self-check on {SYSTEM} {platform.release()}, Python {platform.python_version()}")
    line(sys.version_info >= (3, 10), "Python 3.10 or newer", "Install Python 3.12+ from python.org")
    line(https_ok(), "Python can reach the wearable APIs over HTTPS",
         "On a Mac with Python from python.org: open Applications > Python 3.x > Install Certificates.command")
    line(paths.POINTER.exists() or os.environ.get("SYLVESTER_DATA"), f"data folder linked: {paths.DATA}", "python sylvester.py init")
    line(paths.DATA.exists() and all((paths.DATA / d).is_dir() for d in FOLDERS), "data folder has all its parts", "python sylvester.py init")
    if paths.DATA.exists():
        migrate()
        line(paths.settings().get("schema") == paths.SCHEMA, f"data folder layout is current (version {paths.SCHEMA})")
    line(not (paths.DATA / ".git").exists(), "data folder is not a git repository")
    try:
        probe = paths.LOGS / ".write-test"
        probe.parent.mkdir(parents=True, exist_ok=True)
        probe.write_text("x")
        probe.unlink()
        line(True, "data folder is writable")
    except OSError as e:
        line(False, f"data folder is writable ({e})")
    prof = paths.read_json(paths.PROFILE / "health_profile.json", {}) or {}
    ob = prof.get("onboarding") or {}
    line(bool(ob.get("wizard_completed")), "setup wizard finished", "python sylvester.py setup")
    line(bool(ob.get("completed")), "onboarding finished with the Coach", "In Claude Code: /sylvester:setup")
    eq = paths.read_json(paths.PROFILE / "equipment.json", {}) or {}
    line(bool(eq.get("items")), "equipment listed", "python sylvester.py setup, or the Equipment tab in the form")
    s = paths.settings()
    for src in WEARABLES:
        if s["sources"].get(src):
            line((paths.SECRETS / f"{src}_tokens.json").exists(), f"{src.title()} connected", f"python sylvester.py connect {src}")
    if s["sources"].get("apple_health"):
        line((paths.SOURCES / "apple_daily.csv").exists(), "Apple Health imported", "python sylvester.py import apple")
    line(bool(s.get("phone_url")), "phone page published", "/sylvester:setup publishes it from app/phone.html")
    line(scheduled(), "daily task scheduled" if SYSTEM != "Linux" else "daily task (add the cron line from `schedule`)", "python sylvester.py schedule")
    line(paths.active_plan_dir() is not None or None, "a plan exists", "/sylvester:coach calibrate, then /sylvester:coach plan")
    hooks = subprocess.run(["git", "config", "core.hooksPath"], cwd=str(APP), capture_output=True, text=True).stdout.strip() if (APP / ".git").exists() else "n/a"
    line(hooks in ("tools/hooks", "n/a"), "privacy check runs before every commit", "git config core.hooksPath tools/hooks")
    print("\nAll good." if ok else "\nFix the !! lines above (the → line says how).")
    return 0 if ok else 1


# ---------- data ----------

def daily():
    migrate()
    paths.LOGS.mkdir(parents=True, exist_ok=True)
    log = paths.LOGS / "daily.log"
    s = paths.settings()
    for src in WEARABLES:
        if s["sources"].get(src) and (paths.SECRETS / f"{src}_tokens.json").exists():
            run(f"ingest/{src}_pull.py", "pull", log=log)
    run("coach/snapshot.py", log=log)
    run("coach/trends.py", log=log)
    if paths.active_plan_dir():
        run("coach/rolling.py", log=log)
    print(f"done; log in {log}")


def schedule(at="11:00"):
    s = paths.settings()
    s["pull_time"] = at
    paths.save_settings(s)
    me = str(APP / "sylvester.py")
    if SYSTEM == "Windows":
        tr = f'"{PY}" "{me}" daily'
        rc = subprocess.call(["schtasks", "/Create", "/F", "/SC", "DAILY", "/ST", at, "/TN", TASK, "/TR", tr])
        print("Scheduled." if rc == 0 else "Couldn't create the task; try again from an ordinary (not admin) terminal.")
    elif SYSTEM == "Darwin":
        h, m = (int(x) for x in at.split(":"))
        LAUNCHD.parent.mkdir(parents=True, exist_ok=True)
        LAUNCHD.write_text(f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.sylvester.daily</string>
  <key>ProgramArguments</key><array><string>{PY}</string><string>{me}</string><string>daily</string></array>
  <key>WorkingDirectory</key><string>{APP}</string>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>{h}</integer><key>Minute</key><integer>{m}</integer></dict>
  <key>StandardOutPath</key><string>{paths.LOGS / 'launchd.log'}</string>
  <key>StandardErrorPath</key><string>{paths.LOGS / 'launchd.log'}</string>
</dict></plist>
""", encoding="utf-8")
        subprocess.call(["launchctl", "unload", str(LAUNCHD)], stderr=subprocess.DEVNULL)
        rc = subprocess.call(["launchctl", "load", str(LAUNCHD)])
        print("Scheduled (runs at the next scheduled time the Mac is awake)." if rc == 0 else "launchctl couldn't load the job.")
    else:
        h, m = at.split(":")
        print(f"Add this line with `crontab -e`:\n{int(m)} {int(h)} * * * {PY} {me} daily")


def unschedule():
    if SYSTEM == "Windows":
        subprocess.call(["schtasks", "/Delete", "/F", "/TN", TASK])
    elif SYSTEM == "Darwin" and LAUNCHD.exists():
        subprocess.call(["launchctl", "unload", str(LAUNCHD)])
        LAUNCHD.unlink()
        print("Removed.")


def images():
    """Pictures for every exercise in the active plan's routines and the person's calibration batteries."""
    sys.path.insert(0, str(APP / "coach"))
    import catalogue
    import exercise_lib
    lib = exercise_lib.load()
    ids, unnamed = set(), []
    plan = paths.active_plan_dir()
    folders = [p for p in ((plan / "routines") if plan else None, paths.PLANS / "routines") if p and p.exists()]
    for d in folders:
        for f in d.glob("*.json"):
            for e in (paths.read_json(f) or {}).get("exercises", []):
                (ids.add(e["lib"]) if e.get("lib") else unnamed.append(f"{f.stem}: {e.get('name')}"))
    cat = catalogue.load()
    own = paths.read_json(paths.PLANS / "calibration.json", {}) or {}
    for b in (own.get("batteries") or {}).values():
        ids |= {cat["tests"][t]["lib"] for t in b.get("tests", []) if cat["tests"].get(t, {}).get("lib")}
    got = missing = 0
    for i in sorted(ids):
        if i not in lib:
            unnamed.append(f"{i} (not in any catalogue)")
            continue
        try:
            exercise_lib.fetch(i, lib)
            got += 1
        except OSError as e:
            missing += 1
            print(f"!! {i}: {e}")
    print(f"{got} exercises have pictures in {paths.MEDIA}" + (f"; {missing} failed to download" if missing else ""))
    if unnamed:
        print("No picture source (ask Claude to draw these, or add your own photos):")
        for u in unnamed:
            print("  -", u)


def next_step():
    """One line for Claude Code at the start of a session (the SessionStart hook in .claude/settings.json):
    where this person is in setting up, so the Coach can offer the next step without being asked."""
    py = "python3" if SYSTEM == "Darwin" else "python"
    if not paths.DATA.exists() or not (paths.POINTER.exists() or os.environ.get("SYLVESTER_DATA")):
        return (f"Sylvester: not set up on this computer yet. Offer to run `{py} sylvester.py init` "
                f"(it creates the personal data folder, {Path.home() / 'health-data'} by default), then the setup wizard.")
    s = paths.settings()
    if int(s.get("schema") or 0) > paths.SCHEMA:
        return f"Sylvester: the data folder is newer than this app. Offer to update it: `git pull` in {APP}."
    prof = paths.read_json(paths.PROFILE / "health_profile.json", {}) or {}
    ob = prof.get("onboarding") or {}
    if not ob.get("wizard_completed"):
        return ("Sylvester: the setup wizard hasn't been finished. Offer to open it: run "
                f"`{py} sylvester.py setup` in the background (it opens the browser and ends itself on Finish), then /sylvester:setup.")
    if not ob.get("completed"):
        return "Sylvester: the wizard is done but onboarding isn't. Offer to continue with /sylvester:setup (a short follow-up chat)."
    if paths.active_plan_dir() is None:
        return "Sylvester: set up, but there is no plan yet. Offer /sylvester:coach calibrate, then /sylvester:coach plan."
    snap = paths.RECORDS / "snapshot.json"
    stale = ""
    if snap.exists():
        age = (datetime.now() - datetime.fromtimestamp(snap.stat().st_mtime)).days
        if age >= 2:
            stale = f" The daily update last ran {age} days ago; `{py} sylvester.py check` shows why."
    return f"Sylvester: ready. /sylvester:coach today gives today's session; /sylvester:coach sync sends the plan to the phone.{stale}"


EXPORT_DAYS = 400  # wearable history the app gets: a year for baselines and trends


def export_app(target=None):
    """One file with the person's profile, active plan, calibration, logs and recent wearable days, for the iPhone
    app's "Import from the desktop" (shared/model.ts fromExport reads it). Secrets, medical records
    (records/clinical_summary.*) and pictures stay here."""
    import csv
    from datetime import date, timedelta

    def rows(path, since=None):
        if not path.exists():
            return []
        with open(path, newline="", encoding="utf-8") as f:
            return [r for r in csv.DictReader(f) if not since or r.get("date", "") >= since]

    since = (date.today() - timedelta(days=EXPORT_DAYS)).isoformat()
    plan_dir = paths.active_plan_dir()
    plan = None
    if plan_dir:
        program = plan_dir / "program.md"
        plan = {"name": plan_dir.name,
                "program": program.read_text(encoding="utf-8") if program.exists() else "",
                "rolling": paths.read_json(plan_dir / "rolling.json", {}) or {},
                "routines": {f.stem: paths.read_json(f) for f in sorted((plan_dir / "routines").glob("*.json"))},
                "overrides": {f.stem: paths.read_json(f) for f in sorted((plan_dir / "overrides").glob("*.json"))
                              if f.stem >= date.today().isoformat()}}
    shared = paths.PLANS / "routines"
    apple = []
    for r in rows(paths.SOURCES / "apple_daily.csv", since):
        r = {k: v for k, v in r.items() if v not in ("", None)}
        if r.get("hrv_sdnn_elitehrv"):
            r["avg_hrv"] = r["hrv_sdnn_elitehrv"]
        if r.get("resting_hr_elitehrv"):
            r["lowest_hr"] = r["resting_hr_elitehrv"]
        apple.append(r)
    doc = {
        "format": "sylvester-export", "version": 1, "exported": datetime.now().isoformat(timespec="seconds"), "source": "desktop",
        "profile": {k: paths.read_json(paths.PROFILE / f"{k}.json", {}) or {} for k in ("health_profile", "equipment", "goals")},
        "plan": plan,
        "shared_routines": {f.stem: paths.read_json(f) for f in sorted(shared.glob("*.json"))} if shared.exists() else {},
        "calibration": paths.read_json(paths.PLANS / "calibration.json", {}) or {},
        "workouts": rows(paths.RECORDS / "workout_log.csv"),
        "checkins": rows(paths.RECORDS / "checkins.csv"),
        "assessment_rows": rows(paths.RECORDS / "assessments.csv"),
        "daily": {name: [{k: v for k, v in r.items() if v not in ("", None)} for r in rows(paths.SOURCES / f, since)]
                  for name, f in (("Oura", "oura_daily.csv"), ("WHOOP", "whoop_daily.csv"))},
    }
    doc["daily"]["Apple Health"] = apple
    doc["daily"] = {k: v for k, v in doc["daily"].items() if v}
    out = Path(target) if target else paths.DATA / "sylvester-export.json"
    out.write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")
    print(f"Wrote {out} ({out.stat().st_size // 1024} KB). AirDrop it to your iPhone or save it to iCloud Drive, then in the app:")
    print("Settings > Import from the desktop. It holds your health profile: keep it private and delete it after importing.")


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")  # Windows consoles default to a code page without → or ·
    except (AttributeError, ValueError):
        pass
    a = sys.argv[1:]
    cmd = a[0] if a else ""
    if cmd == "init":
        init(a[1] if len(a) > 1 else None)
    elif cmd == "where":
        where()
    elif cmd == "check":
        sys.exit(check())
    elif cmd == "form":
        sys.exit(run("app/server.py", *a[1:]))
    elif cmd == "setup":
        sys.exit(run("app/server.py", "--setup", *a[1:]))
    elif cmd == "connect" and len(a) > 1 and a[1] in WEARABLES:
        s = paths.settings()
        s["sources"][a[1]] = True
        paths.save_settings(s)
        sys.exit(run(f"ingest/{a[1]}_pull.py", "auth"))
    elif cmd == "pull":
        srcs = a[1:] or [k for k in WEARABLES if paths.settings()["sources"].get(k)]
        for src in srcs:
            run(f"ingest/{src}_pull.py", "pull")
    elif cmd == "import" and len(a) > 1 and a[1] == "apple":
        s = paths.settings()
        s["sources"]["apple_health"] = True
        paths.save_settings(s)
        sys.exit(run("ingest/apple_import.py", *a[2:]))
    elif cmd == "import" and len(a) > 2 and a[1] == "polar":
        sys.exit(run("ingest/polar_import_historical.py", a[2]))
    elif cmd == "daily":
        daily()
    elif cmd == "schedule":
        schedule(a[1] if len(a) > 1 else paths.settings().get("pull_time", "11:00"))
    elif cmd == "unschedule":
        unschedule()
    elif cmd == "images":
        images()
    elif cmd == "plan":
        sys.exit(run("coach/rolling.py", *a[1:]))
    elif cmd == "export":
        export_app(a[1] if len(a) > 1 else None)
    elif cmd == "next":
        try:
            print(next_step())
        except Exception as e:  # never break a Claude Code session start
            print(f"Sylvester: couldn't read the setup state ({e.__class__.__name__}). Run `python sylvester.py check`.")
    else:
        print(__doc__)


if __name__ == "__main__":
    main()
