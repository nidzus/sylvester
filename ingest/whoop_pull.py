#!/usr/bin/env python3
"""WHOOP: recovery, HRV, resting heart rate, sleep and strain. Standard library only.

Setup once:
    1. Create an app at https://developer-dashboard.whoop.com with the redirect URI
       http://localhost:3002/callback and the scopes read:recovery, read:cycles, read:sleep,
       read:workout, read:profile and offline. Then <data>/secrets/whoop_config.json:
         {"client_id": "...", "client_secret": "...", "redirect_uri": "http://localhost:3002/callback"}
    2. python sylvester.py connect whoop

Every day:
    python sylvester.py pull whoop                         # the last 3 days (the daily task does this)
    python ingest/whoop_pull.py pull 2026-08-01 2026-09-04 # a range

Writes <data>/sources/whoop_daily.csv, one row per day (the day you woke up), with the same column
names as Oura where they mean the same thing, so the snapshot and the rolling plan read either.
"""

import sys
import time
from datetime import date, datetime, timedelta
from statistics import mean

import oauth_local as oa
from oauth_local import paths

NAME = "whoop"
AUTH_URL = "https://api.prod.whoop.com/oauth/oauth2/auth"
TOKEN_URL = "https://api.prod.whoop.com/oauth/oauth2/token"
API = "https://api.prod.whoop.com/developer/v2"
SCOPES = "offline read:recovery read:cycles read:sleep read:workout read:profile"
CSV = paths.SOURCES / "whoop_daily.csv"
FIELDS = ["date", "readiness_score", "avg_hrv", "lowest_hr", "spo2", "skin_temp_c", "temperature_deviation",
          "total_sleep_h", "deep_sleep_h", "rem_sleep_h", "efficiency", "sleep_score", "avg_breath",
          "strain", "active_calories", "steps"]


def auth():
    cfg = oa.config(NAME)
    code = oa.authorize(AUTH_URL, {"client_id": cfg["client_id"], "response_type": "code", "scope": SCOPES}, cfg["redirect_uri"])
    status, body = oa.post_form(TOKEN_URL, {"grant_type": "authorization_code", "code": code, "client_id": cfg["client_id"],
                                            "client_secret": cfg["client_secret"], "redirect_uri": cfg["redirect_uri"]})
    if status != 200 or "access_token" not in body:
        sys.exit(f"WHOOP sign-in failed ({status}). Check the client id, secret and redirect URI in whoop_config.json.")
    oa.save_tokens(NAME, body)
    print("WHOOP connected.")


def token():
    cfg, t = oa.config(NAME), oa.load_tokens(NAME)
    if time.time() < t.get("expires_at", 0):
        return t["access_token"]
    status, body = oa.post_form(TOKEN_URL, {"grant_type": "refresh_token", "refresh_token": t["refresh_token"],
                                            "client_id": cfg["client_id"], "client_secret": cfg["client_secret"], "scope": "offline"})
    if status != 200 or "access_token" not in body:
        sys.exit("WHOOP refresh failed: connect again with `python sylvester.py connect whoop`.")
    return oa.save_tokens(NAME, body)["access_token"]


def collection(path, tok, start, end):
    out, nxt = [], None
    while True:
        status, body = oa.get_json(f"{API}/{path}", tok, {"start": start, "end": end, "limit": 25, "nextToken": nxt})
        if status != 200:
            sys.exit(f"WHOOP {path}: HTTP {status}")
        out += body.get("records", [])
        nxt = body.get("next_token") or body.get("nextToken")
        if not nxt:
            return out


def hours(ms):
    return round(ms / 3_600_000, 2) if ms else None


def pull(start, end):
    tok = token()
    a = datetime.fromisoformat(start).strftime("%Y-%m-%dT00:00:00.000Z")
    b = (datetime.fromisoformat(end) + timedelta(days=1)).strftime("%Y-%m-%dT00:00:00.000Z")
    sleeps = {s["id"]: s for s in collection("activity/sleep", tok, a, b) if not s.get("nap")}
    cycles = {c["id"]: c for c in collection("cycle", tok, a, b)}
    rows = {}
    for rec in collection("recovery", tok, a, b):
        sl = sleeps.get(rec.get("sleep_id")) or {}
        day = (sl.get("end") or rec.get("created_at") or "")[:10]
        if not day:
            continue
        sc, ss = rec.get("score") or {}, (sl.get("score") or {})
        st = ss.get("stage_summary") or {}
        asleep = sum(st.get(k) or 0 for k in ("total_light_sleep_time_milli", "total_slow_wave_sleep_time_milli", "total_rem_sleep_time_milli"))
        cy = (cycles.get(rec.get("cycle_id")) or {})
        cs = cy.get("score") or {}
        rows[day] = {
            "date": day,
            "readiness_score": sc.get("recovery_score"),
            "avg_hrv": round(sc["hrv_rmssd_milli"], 1) if sc.get("hrv_rmssd_milli") else None,
            "lowest_hr": sc.get("resting_heart_rate"),
            "spo2": sc.get("spo2_percentage"),
            "skin_temp_c": round(sc["skin_temp_celsius"], 2) if sc.get("skin_temp_celsius") is not None else None,
            "total_sleep_h": hours(asleep),
            "deep_sleep_h": hours(st.get("total_slow_wave_sleep_time_milli")),
            "rem_sleep_h": hours(st.get("total_rem_sleep_time_milli")),
            "efficiency": ss.get("sleep_efficiency_percentage"),
            "sleep_score": ss.get("sleep_performance_percentage"),
            "avg_breath": ss.get("respiratory_rate"),
            "strain": cs.get("strain"),
            "active_calories": round(cs["kilojoule"] / 4.184) if cs.get("kilojoule") else None,
            "steps": cy.get("step_count"),
        }
    # WHOOP reports skin temperature, not a deviation: compare with the previous 30 days, like Oura does.
    history = [r for r in oa_rows() if r.get("skin_temp_c")]
    for day, r in rows.items():
        if r.get("skin_temp_c") is None:
            continue
        since = (date.fromisoformat(day) - timedelta(days=30)).isoformat()
        base = [float(h["skin_temp_c"]) for h in history if since <= h["date"] < day]
        base += [float(x["skin_temp_c"]) for d, x in rows.items() if since <= d < day and x.get("skin_temp_c") is not None]
        if len(base) >= 7:
            r["temperature_deviation"] = round(float(r["skin_temp_c"]) - mean(base), 2)
    n = oa.upsert_csv(CSV, FIELDS, list(rows.values()))
    print(f"WHOOP: {n} days {start} to {end} into {CSV.name}")


def oa_rows():
    import csv
    if not CSV.exists():
        return []
    with open(CSV, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


if __name__ == "__main__":
    args = sys.argv[1:]
    if args[:1] == ["auth"]:
        auth()
    elif args[:1] == ["pull"]:
        end = args[2] if len(args) > 2 else date.today().isoformat()
        start = args[1] if len(args) > 1 else (date.fromisoformat(end) - timedelta(days=2)).isoformat()
        pull(start, end)
    else:
        print(__doc__)
