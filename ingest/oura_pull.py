#!/usr/bin/env python3
"""
Oura v2 pull with OAuth2 and persistent token rotation.

Setup once:
    1. Register an app at https://cloud.ouraring.com/oauth/applications
       (redirect URI: http://localhost:3000/callback), then create
       <data>/secrets/oura_config.json:
         {"client_id": "...", "client_secret": "...",
          "redirect_uri": "http://localhost:3000/callback"}
    2. python sylvester.py connect oura
       Browser opens, you approve, the script catches the callback itself.
       Writes oura_tokens.json. You never copy a code by hand.

Every day:
    python sylvester.py pull oura            # catches up from the last stored day, at least the last 7 days (the daily task does this)
    python ingest/oura_pull.py pull 2026-08-01 2026-09-04   # a range

Appends one row per day to <data>/sources/oura_daily.csv, de-duplicated by date, then lists the days in the
range Oura itself has no data or no night for (ingest/catch_up.py has the window rules).
"""

import csv
import json
import os
import sys
import threading
import webbrowser
from datetime import date, timedelta
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlencode, urlparse, parse_qs

import catch_up
import http_lite as requests  # standard library: no pip install needed

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
from core import paths  # noqa: E402
for _d in (paths.SECRETS, paths.SOURCES, paths.RECORDS):
    _d.mkdir(parents=True, exist_ok=True)

CONFIG_PATH = str(paths.SECRETS / "oura_config.json")
TOKEN_PATH = str(paths.SECRETS / "oura_tokens.json")
CSV_PATH = str(paths.SOURCES / "oura_daily.csv")

AUTH_URL = "https://cloud.ouraring.com/oauth/authorize"
TOKEN_URL = "https://api.ouraring.com/oauth/token"
API = "https://api.ouraring.com/v2/usercollection"
SCOPES = "daily heartrate workout personal session tag spo2 stress heart_health"  # heart_health: VO2 max, cardiovascular age

# Readiness parts besides hrv_balance and resting_heart_rate (older columns, kept as they were); sleep parts by column.
READINESS_PARTS = ["activity_balance", "body_temperature", "previous_day_activity", "previous_night",
                   "recovery_index", "sleep_balance", "sleep_regularity"]
SLEEP_PARTS = {"deep_sleep": "sleep_deep_contrib", "efficiency": "sleep_efficiency_contrib", "latency": "sleep_latency_contrib",
               "rem_sleep": "sleep_rem_contrib", "restfulness": "sleep_restfulness_contrib", "timing": "sleep_timing_contrib",
               "total_sleep": "sleep_total_contrib"}
REST_MODE_LOOKBACK_DAYS = 60  # Rest Mode periods are listed by start day: look back for one still running

FIELDS = [
    "date",
    "readiness_score", "temperature_deviation", "hrv_balance", "resting_hr_contrib",
    "sleep_score", "total_sleep_h", "deep_sleep_h", "rem_sleep_h", "efficiency",
    "avg_hrv", "lowest_hr", "avg_breath",
    "activity_score", "steps", "active_calories",
    "stress_high_min", "stress_summary", "resilience_level",
    # Since 2026-11: total_sleep_h adds up every sleep session of the day; the night alone, the rest, and how many.
    "night_sleep_h", "nap_sleep_h", "sleep_sessions",
    "avg_hr_night", "latency_min", "awake_h", "time_in_bed_h", "restless_periods",
    "temperature_trend_deviation", "spo2_avg", "breathing_disturbance_index", "recovery_high_min",
    "high_activity_min", "medium_activity_min", "low_activity_min", "sedentary_h", "non_wear_h", "total_calories",
    "vo2_max", "cardiovascular_age", "pulse_wave_velocity",
    # Since 2026-11: what each score is made of (0-100; under 70 is Oura's "pay attention"), bedtimes, Rest Mode.
    *[f"{k}_contrib" for k in READINESS_PARTS], *SLEEP_PARTS.values(),
    "bedtime_start", "bedtime_end", "rest_mode",
]
WORKOUTS_PATH = str(paths.SOURCES / "oura_workouts.csv")
# Oura keeps one profile weight (the Oura app takes it from Apple Health), with no history or date. Each pull records
# it under the day it was seen, as a new row only when it differs from the last one.
WEIGHT_PATH = str(paths.SOURCES / "oura_weight.csv")
WEIGHT_FIELDS = ["date", "weight_kg"]
WORKOUT_FIELDS = ["id", "date", "activity", "intensity", "start", "end", "duration_min", "calories", "distance_m", "source", "label"]
SLEEP_TYPES = ("long_sleep", "sleep", "late_nap")  # "rest" is a rest period, not sleep; "deleted" is gone


def load_config():
    if not os.path.exists(CONFIG_PATH):
        sys.exit(f"Missing {CONFIG_PATH}. See the docstring at the top of this file.")
    with open(CONFIG_PATH) as f:
        return json.load(f)


def save_tokens(tokens):
    """Refresh tokens are single-use. Persisting the rotated one is mandatory."""
    with open(TOKEN_PATH, "w") as f:
        json.dump(tokens, f, indent=2)
    os.chmod(TOKEN_PATH, 0o600)


def load_tokens():
    if not os.path.exists(TOKEN_PATH):
        sys.exit("No tokens yet. Run: python sylvester.py connect oura")
    with open(TOKEN_PATH) as f:
        return json.load(f)


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
        "redirect_uri": cfg["redirect_uri"],
        "response_type": "code",
        "scope": SCOPES,
    }
    url = f"{AUTH_URL}?{urlencode(params)}"

    port = urlparse(cfg["redirect_uri"]).port or 80
    server = HTTPServer(("localhost", port), CallbackHandler)
    threading.Thread(target=server.handle_request, daemon=True).start()

    print("Opening browser to authorize. If it does not open, visit:\n" + url)
    webbrowser.open(url)

    server_thread_timeout = 180
    import time
    waited = 0
    while CallbackHandler.code is None and waited < server_thread_timeout:
        time.sleep(0.5)
        waited += 0.5
    if CallbackHandler.code is None:
        sys.exit("No callback received within 3 minutes.")

    r = requests.post(TOKEN_URL, data={
        "grant_type": "authorization_code",
        "code": CallbackHandler.code,
        "client_id": cfg["client_id"],
        "client_secret": cfg["client_secret"],
        "redirect_uri": cfg["redirect_uri"],
    }, timeout=30)
    r.raise_for_status()
    save_tokens(r.json())
    print(f"Tokens saved to {TOKEN_PATH}")


def refresh(cfg, tokens):
    r = requests.post(TOKEN_URL, data={
        "grant_type": "refresh_token",
        "refresh_token": tokens["refresh_token"],
        "client_id": cfg["client_id"],
        "client_secret": cfg["client_secret"],
    }, timeout=30)
    if r.status_code != 200:
        sys.exit("Refresh failed. The refresh token was likely consumed without "
                 "being saved. Re-run: python sylvester.py connect oura")
    new = r.json()
    save_tokens(new)
    return new


# ---------- daily pull ----------

def get(endpoint, token, start, end):
    """Paginated. Oura v2 wraps results as {data: [...], next_token: str|null}."""
    out, next_token = [], None
    while True:
        params = {"start_date": start, "end_date": end}
        if next_token:
            params["next_token"] = next_token
        r = requests.get(f"{API}/{endpoint}",
                         headers={"Authorization": f"Bearer {token}"},
                         params=params, timeout=30)
        if r.status_code == 401:
            return None
        r.raise_for_status()
        body = r.json()
        out.extend(body.get("data", []))
        next_token = body.get("next_token")
        if not next_token:
            return out


def optional(endpoint, token, start, end):
    """An endpoint the connection or the account may not have: None instead of an error."""
    try:
        return get(endpoint, token, start, end)
    except requests.HTTPError:
        return None


def sleep_by_day(records):
    """Every sleep session of each day, the night first.

    A day can hold several records (the night, a doze before it, naps), in no particular order. The night is
    Oura's "long_sleep" (else the longest session)."""
    def rank(s):
        return (s.get("type") == "long_sleep", s.get("total_sleep_duration") or 0)
    out = {}
    for s in records:
        if s.get("type") in SLEEP_TYPES:
            out.setdefault(s["day"], []).append(s)
    return {d: sorted(v, key=rank, reverse=True) for d, v in out.items()}


def sleep_fields(sessions):
    """One day's sleep columns (sessions in sleep_by_day order). Hours add up over all sessions;
    heart rate, HRV, breathing, efficiency and the rest describe the night."""
    if not sessions:
        return {}
    night = sessions[0]
    total = sum(x.get("total_sleep_duration") or 0 for x in sessions)
    night_s = night.get("total_sleep_duration") or 0
    return {
        "total_sleep_h": hours(total),
        "deep_sleep_h": hours(sum(x.get("deep_sleep_duration") or 0 for x in sessions)),
        "rem_sleep_h": hours(sum(x.get("rem_sleep_duration") or 0 for x in sessions)),
        "night_sleep_h": hours(night_s), "nap_sleep_h": hours(total - night_s), "sleep_sessions": len(sessions),
        "efficiency": night.get("efficiency"), "avg_hrv": night.get("average_hrv"), "lowest_hr": night.get("lowest_heart_rate"),
        "avg_breath": night.get("average_breath"), "avg_hr_night": night.get("average_heart_rate"),
        "latency_min": minutes(night.get("latency")), "awake_h": hours(night.get("awake_time")),
        "time_in_bed_h": hours(night.get("time_in_bed")), "restless_periods": night.get("restless_periods"),
        "bedtime_start": clock(night.get("bedtime_start")), "bedtime_end": clock(night.get("bedtime_end")),
    }


def clock(ts):
    """Oura's local timestamp ('2026-11-18T23:41:12+01:00') to minutes: '2026-11-18T23:41'."""
    return ts[:16] if ts else None


def rest_mode_on(periods, day):
    """1 on a day in a Rest Mode period, else 0. The day it was switched off doesn't count, unless it began that day too."""
    for p in periods:
        s, e = p.get("start_day"), p.get("end_day")
        if s and s <= day and (not e or day < e or day == s):
            return 1
    return 0


def workout_rows(records):
    """Oura's workouts (auto-detected or entered in the app), one row each."""
    from datetime import datetime
    out = []
    for w in records:
        a, b = w.get("start_datetime") or "", w.get("end_datetime") or ""
        try:
            mins = round((datetime.fromisoformat(b) - datetime.fromisoformat(a)).total_seconds() / 60)
        except ValueError:
            mins = None
        out.append({"id": w.get("id"), "date": w.get("day"), "activity": w.get("activity"), "intensity": w.get("intensity"),
                    "start": a, "end": b, "duration_min": mins, "calories": w.get("calories"),
                    "distance_m": w.get("distance"), "source": w.get("source"), "label": w.get("label")})
    return out


def hours(sec):
    return round(sec / 3600, 2) if sec else None


def minutes(sec):
    return round(sec / 60) if sec is not None else None


def save_workouts(workouts):
    old = {}
    if os.path.exists(WORKOUTS_PATH):
        with open(WORKOUTS_PATH, newline="", encoding="utf-8") as f:
            old = {r_["id"]: r_ for r_ in csv.DictReader(f)}
    old.update({w_["id"]: w_ for w_ in workouts})
    with open(WORKOUTS_PATH, "w", newline="", encoding="utf-8") as f:
        ww = csv.DictWriter(f, fieldnames=WORKOUT_FIELDS)
        ww.writeheader()
        for w_ in sorted(old.values(), key=lambda r_: (r_.get("date") or "", r_.get("start") or "")):
            ww.writerow({k: w_.get(k) for k in WORKOUT_FIELDS})
    return len(old)


def record_weight(kg, day):
    """Add (day, kg) to oura_weight.csv if kg differs from the last row. A second change on the same day replaces
    that day's row, so each day keeps the latest value. Returns True when the file changed."""
    if kg is None:
        return False
    kg = round(float(kg), 1)
    rows = []
    if os.path.exists(WEIGHT_PATH):
        with open(WEIGHT_PATH, newline="", encoding="utf-8") as f:
            rows = list(csv.DictReader(f))
    if rows and float(rows[-1]["weight_kg"]) == kg:
        return False
    if rows and rows[-1]["date"] == day:
        rows.pop()
        if rows and float(rows[-1]["weight_kg"]) == kg:  # changed back to the previous value: not a new reading
            return write_weights(rows)
    return write_weights(rows + [{"date": day, "weight_kg": kg}])


def write_weights(rows):
    with open(WEIGHT_PATH, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=WEIGHT_FIELDS)
        w.writeheader()
        w.writerows(rows)
    return True


def profile_weight(token):
    """Oura's profile weight in kg, or None (no personal permission, or none set)."""
    try:
        r = requests.get(f"{API}/personal_info", headers={"Authorization": f"Bearer {token}"}, timeout=30)
        return r.json().get("weight") if r.ok else None
    except (requests.HTTPError, ValueError, OSError):
        return None


def cmd_pull(start, end):
    """Days start..end, both inclusive. The API is asked up to the day after end: its sleep endpoints
    treat end_date as exclusive, so without that the last day's night would never arrive."""
    rows = fetch_rows(start, end)
    merge_rows(rows)
    for line in gap_report(start, end, rows):
        print(line)


def merge_rows(rows):
    """Upsert by date, field by field: a pull that has less for a day (a night not synced yet) doesn't erase what's there."""
    existing = {}
    if os.path.exists(CSV_PATH):
        with open(CSV_PATH, newline="", encoding="utf-8") as f:
            for r_ in csv.DictReader(f):
                existing[r_["date"]] = r_
    for r_ in rows:
        old = existing.get(r_["date"], {})
        existing[r_["date"]] = {**old, **{k: v for k, v in r_.items() if v is not None}}
    with open(CSV_PATH, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        w.writeheader()
        for day in sorted(existing):
            w.writerow({k: existing[day].get(k) for k in FIELDS})
    return existing


def fetch_rows(start, end):
    api_end = (date.fromisoformat(end) + timedelta(days=1)).isoformat()
    want = set(catch_up.days_between(start, end))
    cfg = load_config()
    tokens = load_tokens()
    token = tokens["access_token"]

    probe = get("daily_readiness", token, start, api_end)
    if probe is None:
        tokens = refresh(cfg, tokens)
        token = tokens["access_token"]
        probe = get("daily_readiness", token, start, api_end)

    readiness = {d["day"]: d for d in (probe or [])}
    sleep_daily = {d["day"]: d for d in (get("daily_sleep", token, start, api_end) or [])}
    activity = {d["day"]: d for d in (get("daily_activity", token, start, api_end) or [])}
    stress = {d["day"]: d for d in (get("daily_stress", token, start, api_end) or [])}
    resil = {d["day"]: d for d in (get("daily_resilience", token, start, api_end) or [])}
    sessions = sleep_by_day(get("sleep", token, start, api_end) or [])
    # Endpoints this sign-in may not cover (older ones lack heart_health) come back None and are skipped.
    spo2 = {d["day"]: d for d in (optional("daily_spo2", token, start, api_end) or [])}
    vo2_raw, cva_raw = optional("vO2_max", token, start, api_end), optional("daily_cardiovascular_age", token, start, api_end)
    vo2 = {d["day"]: d for d in (vo2_raw or [])}
    cva = {d["day"]: d for d in (cva_raw or [])}
    workouts = workout_rows(optional("workout", token, start, api_end) or [])
    rest_from = (date.fromisoformat(start) - timedelta(days=REST_MODE_LOOKBACK_DAYS)).isoformat()
    rest = optional("rest_mode_period", token, rest_from, api_end)  # None: unavailable, so the column is left as it was

    rows = []
    for day in sorted(set(readiness) | set(sleep_daily) | set(activity) | set(sessions)):
        rd = readiness.get(day, {})
        sd = sleep_daily.get(day, {})
        ac = activity.get(day, {})
        c = rd.get("contributors", {}) or {}
        sp = spo2.get(day) or {}
        cv = cva.get(day) or {}
        row = {
            "date": day,
            "readiness_score": rd.get("score"),
            "temperature_deviation": rd.get("temperature_deviation"),
            "hrv_balance": c.get("hrv_balance"),
            "resting_hr_contrib": c.get("resting_heart_rate"),
            "sleep_score": sd.get("score"),
            "activity_score": ac.get("score"),
            "steps": ac.get("steps"),
            "active_calories": ac.get("active_calories"),
            "stress_high_min": (lambda v: round(v / 60) if v is not None else None)(
                (stress.get(day) or {}).get("stress_high")),
            "stress_summary": (stress.get(day) or {}).get("day_summary"),
            "resilience_level": (resil.get(day) or {}).get("level"),
            "temperature_trend_deviation": rd.get("temperature_trend_deviation"),
            "spo2_avg": (sp.get("spo2_percentage") or {}).get("average"),
            "breathing_disturbance_index": sp.get("breathing_disturbance_index"),
            "recovery_high_min": minutes((stress.get(day) or {}).get("recovery_high")),
            "high_activity_min": minutes(ac.get("high_activity_time")),
            "medium_activity_min": minutes(ac.get("medium_activity_time")),
            "low_activity_min": minutes(ac.get("low_activity_time")),
            "sedentary_h": hours(ac.get("sedentary_time")),
            "non_wear_h": hours(ac.get("non_wear_time")),
            "total_calories": ac.get("total_calories"),
            "vo2_max": (vo2.get(day) or {}).get("vo2_max"),
            "cardiovascular_age": cv.get("vascular_age"),
            "pulse_wave_velocity": cv.get("pulse_wave_velocity"),
            **{f"{k}_contrib": c.get(k) for k in READINESS_PARTS},
            **{col: (sd.get("contributors") or {}).get(k) for k, col in SLEEP_PARTS.items()},
            "rest_mode": None if rest is None else rest_mode_on(rest, day),
        }
        row.update(sleep_fields(sessions.get(day, [])))
        rows.append(row)

    rows = [r_ for r_ in rows if r_["date"] in want]
    if workouts:
        print(f"{len(workouts)} workout(s) from Oura; {WORKOUTS_PATH} holds {save_workouts(workouts)}.")
    kg = profile_weight(token)
    if record_weight(kg, date.today().isoformat()):
        print(f"Weight {round(float(kg), 1)} kg (Oura profile) recorded for {date.today().isoformat()}.")
    if vo2_raw is None or cva_raw is None:
        print("VO2 max and cardiovascular age need Oura's heart_health permission: run `python sylvester.py connect oura` once to add it.")
    print(f"{len(rows)} day(s) pulled ({start} to {end}).")
    return rows


def gap_report(start, end, rows, today=None):
    """Days in the pulled range that Oura itself has nothing (or no night) for. Today is still in progress, so it's left out.

    Because these days were just asked for, a gap listed here is missing in Oura, not a sync problem on this side."""
    today = (today or date.today()).isoformat()
    got = {r["date"]: r for r in rows}
    past = [d for d in catch_up.days_between(start, end) if d < today]
    none = [d for d in past if d not in got]
    no_night = [d for d in past if d in got and got[d].get("total_sleep_h") is None and got[d].get("sleep_score") is None]
    out = []
    if none:
        out.append(f"Oura has no data for: {catch_up.ranges(none)} (ring not worn, or not yet synced to the Oura app).")
    if no_night:
        out.append(f"Oura has no night recorded for: {catch_up.ranges(no_night)}.")
    return out


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "pull"
    if cmd == "auth":
        cmd_auth()
    elif cmd == "pull":
        if len(sys.argv) >= 4:
            cmd_pull(sys.argv[2], sys.argv[3])
        else:
            start, end, note = catch_up.window(CSV_PATH)
            if note:
                print(note)
            cmd_pull(start, end)
    else:
        sys.exit("Usage: oura_pull.py [auth | pull [start_date end_date]]")
