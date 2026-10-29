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
    python sylvester.py pull oura            # yesterday + today (the daily task does this)
    python ingest/oura_pull.py pull 2026-08-01 2026-09-04   # a range

Appends one row per day to <data>/sources/oura_daily.csv, de-duplicated by date.
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
SCOPES = "daily heartrate workout personal session tag spo2 stress"

FIELDS = [
    "date",
    "readiness_score", "temperature_deviation", "hrv_balance", "resting_hr_contrib",
    "sleep_score", "total_sleep_h", "deep_sleep_h", "rem_sleep_h", "efficiency",
    "avg_hrv", "lowest_hr", "avg_breath",
    "activity_score", "steps", "active_calories",
    "stress_high_min", "stress_summary", "resilience_level",
]


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


def cmd_pull(start, end):
    cfg = load_config()
    tokens = load_tokens()
    token = tokens["access_token"]

    probe = get("daily_readiness", token, start, end)
    if probe is None:
        tokens = refresh(cfg, tokens)
        token = tokens["access_token"]
        probe = get("daily_readiness", token, start, end)

    readiness = {d["day"]: d for d in (probe or [])}
    sleep_daily = {d["day"]: d for d in (get("daily_sleep", token, start, end) or [])}
    activity = {d["day"]: d for d in (get("daily_activity", token, start, end) or [])}
    stress = {d["day"]: d for d in (get("daily_stress", token, start, end) or [])}
    resil = {d["day"]: d for d in (get("daily_resilience", token, start, end) or [])}
    detail = {}
    for s in (get("sleep", token, start, end) or []):
        if s.get("type") in ("long_sleep", "sleep"):
            detail[s["day"]] = s

    rows = []
    for day in sorted(set(readiness) | set(sleep_daily) | set(activity)):
        rd = readiness.get(day, {})
        sd = sleep_daily.get(day, {})
        ac = activity.get(day, {})
        dt = detail.get(day, {})
        c = rd.get("contributors", {}) or {}
        rows.append({
            "date": day,
            "readiness_score": rd.get("score"),
            "temperature_deviation": rd.get("temperature_deviation"),
            "hrv_balance": c.get("hrv_balance"),
            "resting_hr_contrib": c.get("resting_heart_rate"),
            "sleep_score": sd.get("score"),
            "total_sleep_h": round(dt["total_sleep_duration"] / 3600, 2) if dt.get("total_sleep_duration") else None,
            "deep_sleep_h": round(dt["deep_sleep_duration"] / 3600, 2) if dt.get("deep_sleep_duration") else None,
            "rem_sleep_h": round(dt["rem_sleep_duration"] / 3600, 2) if dt.get("rem_sleep_duration") else None,
            "efficiency": dt.get("efficiency"),
            "avg_hrv": dt.get("average_hrv"),
            "lowest_hr": dt.get("lowest_heart_rate"),
            "avg_breath": dt.get("average_breath"),
            "activity_score": ac.get("score"),
            "steps": ac.get("steps"),
            "active_calories": ac.get("active_calories"),
            "stress_high_min": (lambda v: round(v / 60) if v is not None else None)(
                (stress.get(day) or {}).get("stress_high")),
            "stress_summary": (stress.get(day) or {}).get("day_summary"),
            "resilience_level": (resil.get(day) or {}).get("level"),
        })

    existing = {}
    if os.path.exists(CSV_PATH):
        with open(CSV_PATH) as f:
            for r_ in csv.DictReader(f):
                existing[r_["date"]] = r_
    for r_ in rows:
        existing[r_["date"]] = r_

    with open(CSV_PATH, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        w.writeheader()
        for day in sorted(existing):
            w.writerow({k: existing[day].get(k) for k in FIELDS})

    print(f"{len(rows)} day(s) pulled. {CSV_PATH} now holds {len(existing)} rows.")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "pull"
    if cmd == "auth":
        cmd_auth()
    elif cmd == "pull":
        if len(sys.argv) >= 4:
            cmd_pull(sys.argv[2], sys.argv[3])
        else:
            cmd_pull(str(date.today() - timedelta(days=1)), str(date.today()))
    else:
        sys.exit("Usage: oura_pull.py [auth | pull [start_date end_date]]")
