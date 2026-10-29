#!/usr/bin/env python3
"""
Polar AccessLink v3 pull with OAuth2 (long-lived token, no refresh needed).

Setup once:
    1. Register an app at https://admin.polaraccesslink.com/
       Set the redirect URI to exactly: http://localhost:3001/callback
    2. Create <data>/secrets/polar_config.json:
         {"client_id": "...", "client_secret": "...",
          "redirect_uri": "http://localhost:3001/callback"}
    3. python sylvester.py connect polar
       Browser opens, you log in to Polar Flow and approve, the script
       catches the callback, exchanges the code for a token, and registers
       you as a user of the app (required before any data is available).
       Writes polar_tokens.json.

Every day:
    python sylvester.py pull polar

Polar access tokens do not expire and there is no refresh flow (unlike
Oura). If a pull ever gets a 401, the token was revoked -- run: python sylvester.py connect polar.

Exercises, daily activity, and physical info are "transactional": each
pull opens a transaction for whatever is new since the last commit, reads
it, and commits it (marking it consumed). Sleep and nightly recharge are
plain GETs of recent history, re-fetched and de-duplicated each run.

Outputs (all upserted, safe to re-run):
    polar_daily.csv       one row per day: activity + sleep + recharge
    polar_exercises.csv   one row per exercise session
    polar_physical.csv    one row per physical-info entry (rare)
    polar_raw.jsonl        every raw API record, for anything not mapped
                           into the CSVs above (field names Polar returns
                           are not fully documented publicly; this is the
                           safety net -- nothing pulled is ever lost)
"""

import csv
import json
import os
import re
import sys
import threading
import time
import uuid
import webbrowser
from datetime import date, timedelta
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlencode, urlparse, parse_qs

import http_lite as requests  # standard library: no pip install needed

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
from core import paths  # noqa: E402
for _d in (paths.SECRETS, paths.SOURCES, paths.RECORDS):
    _d.mkdir(parents=True, exist_ok=True)

CONFIG_PATH = str(paths.SECRETS / "polar_config.json")
TOKEN_PATH = str(paths.SECRETS / "polar_tokens.json")
DAILY_CSV = str(paths.SOURCES / "polar_daily.csv")
EXERCISES_CSV = str(paths.SOURCES / "polar_exercises.csv")
PHYSICAL_CSV = str(paths.SOURCES / "polar_physical.csv")
RAW_LOG = str(paths.SOURCES / "polar_raw.jsonl")

AUTH_URL = "https://flow.polar.com/oauth2/authorization"
TOKEN_URL = "https://polarremote.com/v2/oauth2/token"
API = "https://www.polaraccesslink.com/v3"

DAILY_FIELDS = [
    "date",
    "steps", "calories", "active_calories", "active_duration_min",
    "sleep_start", "sleep_end", "sleep_score",
    "light_sleep_min", "deep_sleep_min", "rem_sleep_min", "total_sleep_min",
    "sleep_charge",
    "nightly_recharge_status", "ans_charge", "ans_charge_status",
    "hr_avg_sleep", "hrv_avg_sleep", "breathing_rate_avg",
]
EXERCISE_FIELDS = [
    "exercise_id", "start_time", "sport",
    "duration_min", "distance_km", "calories",
    "hr_avg", "hr_max", "training_load",
]
PHYSICAL_FIELDS = [
    "created", "weight", "height", "vo2_max", "resting_hr", "max_hr",
]


def load_config():
    if not os.path.exists(CONFIG_PATH):
        sys.exit(f"Missing {CONFIG_PATH}. See the docstring at the top of this file.")
    with open(CONFIG_PATH) as f:
        return json.load(f)


def save_tokens(tokens):
    with open(TOKEN_PATH, "w") as f:
        json.dump(tokens, f, indent=2)
    os.chmod(TOKEN_PATH, 0o600)


def load_tokens():
    if not os.path.exists(TOKEN_PATH):
        sys.exit("No tokens yet. Run: python sylvester.py connect polar")
    with open(TOKEN_PATH) as f:
        return json.load(f)


def auth_headers(token):
    return {"Authorization": f"Bearer {token}", "Accept": "application/json"}


# ---------- one-time authorization ----------

class CallbackHandler(BaseHTTPRequestHandler):
    code = None

    def do_GET(self):
        qs = parse_qs(urlparse(self.path).query)
        CallbackHandler.code = qs.get("code", [None])[0]
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.end_headers()
        ok = CallbackHandler.code is not None
        msg = "Authorized. Close this tab." if ok else "Authorization failed."
        self.wfile.write(f"<html><body><h3>{msg}</h3></body></html>".encode())

    def log_message(self, *args):
        pass


def cmd_auth():
    cfg = load_config()
    params = {
        "client_id": cfg["client_id"],
        "response_type": "code",
        "redirect_uri": cfg["redirect_uri"],
    }
    url = f"{AUTH_URL}?{urlencode(params)}"

    port = urlparse(cfg["redirect_uri"]).port or 80
    server = HTTPServer(("localhost", port), CallbackHandler)
    threading.Thread(target=server.handle_request, daemon=True).start()

    print("Opening browser to authorize. If it does not open, visit:\n" + url)
    webbrowser.open(url)

    waited = 0
    while CallbackHandler.code is None and waited < 180:
        time.sleep(0.5)
        waited += 0.5
    if CallbackHandler.code is None:
        sys.exit("No callback received within 3 minutes.")

    r = requests.post(
        TOKEN_URL,
        data={
            "grant_type": "authorization_code",
            "code": CallbackHandler.code,
            "redirect_uri": cfg["redirect_uri"],
        },
        headers={"Accept": "application/json"},
        auth=(cfg["client_id"], cfg["client_secret"]),
        timeout=30,
    )
    r.raise_for_status()
    body = r.json()
    tokens = {
        "access_token": body["access_token"],
        "user_id": body["x_user_id"],
        "member_id": uuid.uuid4().hex,
    }

    reg = requests.post(
        f"{API}/users",
        headers={**auth_headers(tokens["access_token"]), "Content-Type": "application/json"},
        json={"member-id": tokens["member_id"]},
        timeout=30,
    )
    if reg.status_code == 409:
        print("User already registered for this app (fine, continuing).")
    else:
        reg.raise_for_status()

    save_tokens(tokens)
    print(f"Tokens saved to {TOKEN_PATH}")


# ---------- helpers ----------

def log_raw(kind, record):
    with open(RAW_LOG, "a") as f:
        f.write(json.dumps({"type": kind, "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%S"), "data": record}) + "\n")


_DUR_RE = re.compile(r"PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?")


def parse_duration_min(s):
    """ISO8601 duration like 'PT1H30M0S' -> minutes."""
    if not s:
        return None
    m = _DUR_RE.match(s)
    if not m:
        return None
    h, mi, sec = m.groups()
    total = (int(h) if h else 0) * 60 + (int(mi) if mi else 0) + (float(sec) if sec else 0) / 60
    return round(total, 2)


def sec_to_min(v):
    return round(v / 60, 2) if isinstance(v, (int, float)) else None


def as_list(resp, *keys):
    if isinstance(resp, list):
        return resp
    if isinstance(resp, dict):
        for k in keys:
            v = resp.get(k)
            if isinstance(v, list):
                return v
    return []


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


# ---------- transactional pull (exercises / activity / physical info) ----------

def run_transaction(kind_path, token, user_id):
    """Create a transaction, return (resource_urls, commit_fn) or (None, None) if nothing new."""
    r = requests.post(f"{API}/users/{user_id}/{kind_path}", headers=auth_headers(token), timeout=30)
    if r.status_code == 401:
        return "UNAUTHORIZED", None
    if r.status_code == 204:
        return None, None
    r.raise_for_status()
    transaction_url = r.json()["resource-uri"]

    lr = requests.get(transaction_url, headers=auth_headers(token), timeout=30)
    lr.raise_for_status()
    listing = lr.json()

    def commit():
        requests.put(transaction_url, headers=auth_headers(token), timeout=30).raise_for_status()

    return listing, commit


def pull_exercises(token, user_id):
    listing, commit = run_transaction("exercise-transactions", token, user_id)
    if listing == "UNAUTHORIZED":
        print("Exercises: 401 Unauthorized -- token may have been revoked. Re-run auth.")
        return []
    if listing is None:
        print("Exercises: nothing new.")
        return []

    rows = []
    for url in as_list(listing, "exercises"):
        r = requests.get(url, headers=auth_headers(token), timeout=30)
        r.raise_for_status()
        e = r.json()
        log_raw("exercise", e)
        hr = e.get("heart-rate") if isinstance(e.get("heart-rate"), dict) else {}
        sport = e.get("sport")
        if not sport or sport == "OTHER":
            sport = e.get("detailed-sport-info") or sport
        training_load = e.get("training-load")
        if training_load is None:
            training_load = (e.get("training-load-pro") or {}).get("cardio-load")
        rows.append({
            "exercise_id": e.get("id"),
            "start_time": e.get("start-time"),
            "sport": sport,
            "duration_min": parse_duration_min(e.get("duration")),
            "distance_km": round(e["distance"] / 1000, 3) if e.get("distance") is not None else None,
            "calories": e.get("calories"),
            "hr_avg": hr.get("average"),
            "hr_max": hr.get("maximum"),
            "training_load": training_load,
        })
    commit()
    print(f"Exercises: {len(rows)} new session(s).")
    return rows


def pull_daily_activity(token, user_id):
    listing, commit = run_transaction("activity-transactions", token, user_id)
    if listing == "UNAUTHORIZED":
        print("Daily activity: 401 Unauthorized -- token may have been revoked. Re-run auth.")
        return {}
    if listing is None:
        print("Daily activity: nothing new.")
        return {}

    by_date = {}
    for url in as_list(listing, "activity-log"):
        r = requests.get(url, headers=auth_headers(token), timeout=30)
        r.raise_for_status()
        a = r.json()
        log_raw("activity", a)
        day = a.get("date")
        if not day:
            continue
        by_date[day] = {
            "steps": a.get("active-steps", a.get("steps")),
            "calories": a.get("calories"),
            "active_calories": a.get("active-calories"),
            "active_duration_min": parse_duration_min(a.get("duration")),
        }
    commit()
    print(f"Daily activity: {len(by_date)} day(s).")
    return by_date


def pull_physical_info(token, user_id):
    listing, commit = run_transaction("physical-information-transactions", token, user_id)
    if listing == "UNAUTHORIZED":
        print("Physical info: 401 Unauthorized -- token may have been revoked. Re-run auth.")
        return []
    if listing is None:
        print("Physical info: nothing new.")
        return []

    rows = []
    for url in as_list(listing, "physical-informations"):
        r = requests.get(url, headers=auth_headers(token), timeout=30)
        r.raise_for_status()
        p = r.json()
        log_raw("physical_info", p)
        rows.append({
            "created": p.get("created"),
            "weight": p.get("weight"),
            "height": p.get("height"),
            "vo2_max": p.get("vo2-max"),
            "resting_hr": p.get("resting-heart-rate"),
            "max_hr": p.get("maximum-heart-rate"),
        })
    commit()
    print(f"Physical info: {len(rows)} entr{'y' if len(rows) == 1 else 'ies'}.")
    return rows


# ---------- direct (non-transactional) pulls ----------

def pull_sleep(token):
    r = requests.get(f"{API}/users/sleep/", headers=auth_headers(token), timeout=30)
    if r.status_code == 401:
        print("Sleep: 401 Unauthorized -- token may have been revoked. Re-run auth.")
        return {}
    r.raise_for_status()
    body = r.json()
    by_date = {}
    for n in as_list(body, "nights", "sleep"):
        log_raw("sleep", n)
        day = n.get("date") or n.get("sleep_result_date")
        if not day:
            continue
        light = n.get("light_sleep")
        deep = n.get("deep_sleep")
        rem = n.get("rem_sleep")
        total = sum(v for v in (light, deep, rem) if isinstance(v, (int, float))) or None
        by_date[day] = {
            "sleep_start": n.get("sleep_start_time"),
            "sleep_end": n.get("sleep_end_time"),
            "sleep_score": n.get("sleep_score"),
            "light_sleep_min": sec_to_min(light),
            "deep_sleep_min": sec_to_min(deep),
            "rem_sleep_min": sec_to_min(rem),
            "total_sleep_min": sec_to_min(total),
            "sleep_charge": n.get("sleep_charge"),
        }
    print(f"Sleep: {len(by_date)} night(s) available.")
    return by_date


def pull_recharge(token):
    r = requests.get(f"{API}/users/nightly-recharge/", headers=auth_headers(token), timeout=30)
    if r.status_code == 401:
        print("Nightly recharge: 401 Unauthorized -- token may have been revoked. Re-run auth.")
        return {}
    r.raise_for_status()
    body = r.json()
    by_date = {}
    for n in as_list(body, "recharges", "nightly-recharge"):
        log_raw("recharge", n)
        day = n.get("date")
        if not day:
            continue
        by_date[day] = {
            "nightly_recharge_status": n.get("nightly_recharge_status"),
            "ans_charge": n.get("ans_charge"),
            "ans_charge_status": n.get("ans_charge_status"),
            "hr_avg_sleep": n.get("heart_rate_avg"),
            "hrv_avg_sleep": n.get("heart_rate_variability_avg"),
            "breathing_rate_avg": n.get("breathing_rate_avg"),
        }
    print(f"Nightly recharge: {len(by_date)} night(s) available.")
    return by_date


# ---------- pull command ----------

def cmd_pull():
    tokens = load_tokens()
    token = tokens["access_token"]
    user_id = tokens["user_id"]

    exercise_rows = pull_exercises(token, user_id)
    activity = pull_daily_activity(token, user_id)
    physical_rows = pull_physical_info(token, user_id)
    sleep = pull_sleep(token)
    recharge = pull_recharge(token)

    daily_rows = []
    for day in sorted(set(activity) | set(sleep) | set(recharge)):
        row = {"date": day}
        row.update(activity.get(day, {}))
        row.update(sleep.get(day, {}))
        row.update(recharge.get(day, {}))
        daily_rows.append(row)

    n_daily = upsert_csv(DAILY_CSV, DAILY_FIELDS, "date", daily_rows)
    n_ex = upsert_csv(EXERCISES_CSV, EXERCISE_FIELDS, "exercise_id", exercise_rows, sort_field="start_time")
    n_phys = upsert_csv(PHYSICAL_CSV, PHYSICAL_FIELDS, "created", physical_rows)

    print(f"{DAILY_CSV} now holds {n_daily} rows. "
          f"{EXERCISES_CSV} now holds {n_ex} rows. "
          f"{PHYSICAL_CSV} now holds {n_phys} rows.")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "pull"
    if cmd == "auth":
        cmd_auth()
    elif cmd == "pull":
        cmd_pull()
    else:
        sys.exit("Usage: polar_pull.py [auth | pull]")
