"""Where Sylvester keeps things.

The app (this repository) and a person's data live in two separate folders. The app
never holds personal data, and the data folder is never a git repository.

The data folder is found, in order:
  1. the SYLVESTER_DATA environment variable,
  2. ~/.sylvester.json  {"data": "<folder>"}  (written by `sylvester.py init`),
  3. ~/health-data.
"""

import json
import os
from pathlib import Path

APP = Path(__file__).resolve().parent.parent
POINTER = Path.home() / ".sylvester.json"


def data_root():
    env = os.environ.get("SYLVESTER_DATA")
    if env:
        return Path(env).expanduser()
    if POINTER.exists():
        try:
            return Path(json.loads(POINTER.read_text(encoding="utf-8"))["data"]).expanduser()
        except (ValueError, KeyError, OSError):
            pass
    return Path.home() / "health-data"


DATA = data_root()
SETTINGS = DATA / "settings.json"
PROFILE = DATA / "profile"          # health_profile.json, equipment.json, goals.json (+ .history/)
HISTORY = PROFILE / ".history"
RECORDS = DATA / "records"          # check-ins, workouts, assessments, generated reports
SOURCES = DATA / "sources"          # CSVs pulled from Oura, Polar, Apple Health
IMPORTS = DATA / "imports"          # raw exports: apple_health_export/, polar/
SECRETS = DATA / "secrets"          # OAuth configs and tokens, LAN passcode
PLANS = DATA / "plans"              # programs, routines, rolling schedule, calibration batteries
MEDIA = DATA / "media"              # exercise pictures for this person's plan
PHONE = DATA / "phone"              # outbox / inbox for the phone page
LOGS = DATA / "logs"

# App-side (shared, read-only for personal purposes)
CATALOGUE = APP / "coach" / "exercises"
ASSESSMENTS = APP / "coach" / "assessments.json"
TEMPLATES = APP / "templates"

# Version of the data folder's layout. When an app update changes it, sylvester.py's MIGRATIONS
# upgrade older folders (run by init, daily and check); a newer folder than the app asks for `git pull`.
SCHEMA = 1

DEFAULT_SETTINGS = {
    "schema": 0,
    "python": "",
    "phone_url": "",
    "units": "metric",
    "pull_time": "11:00",
    "sources": {"oura": False, "polar": False, "whoop": False, "withings": False, "apple_health": False},
    "active_plan": "",
}


def settings():
    s = dict(DEFAULT_SETTINGS)
    if SETTINGS.exists():
        try:
            s.update(json.loads(SETTINGS.read_text(encoding="utf-8")))
        except ValueError:
            pass
    return s


def save_settings(s):
    DATA.mkdir(parents=True, exist_ok=True)
    tmp = SETTINGS.with_suffix(".tmp")
    tmp.write_text(json.dumps(s, indent=2, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, SETTINGS)


def read_json(path, default=None):
    path = Path(path)
    if not path.exists():
        return default
    with open(path, encoding="utf-8-sig") as f:
        return json.load(f)


def write_json(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    os.replace(tmp, path)
    return path


def active_plan_dir():
    """The folder of the plan in use: settings.active_plan, else the most recently changed plan with a program.md."""
    name = settings().get("active_plan")
    if name and (PLANS / name).is_dir():
        return PLANS / name
    progs = sorted(PLANS.glob("*/program.md"), key=lambda p: p.stat().st_mtime) if PLANS.exists() else []
    return progs[-1].parent if progs else None
