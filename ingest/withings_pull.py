#!/usr/bin/env python3
"""Withings: weight, body fat and blood pressure (scales, BP monitors), plus steps and sleep from
watches and sleep mats. Standard library only.

Setup once:
    1. Create an application at https://developer.withings.com (Public API, free) with the callback
       http://localhost:3003/callback. Then <data>/secrets/withings_config.json:
         {"client_id": "...", "client_secret": "...", "redirect_uri": "http://localhost:3003/callback"}
    2. python sylvester.py connect withings

Every day:
    python sylvester.py pull withings                         # the last 7 days (the daily task does this)
    python ingest/withings_pull.py pull 2024-01-01 2026-09-04 # a range (history back to 2009 if you have it)

Writes, in <data>/sources/:
    withings_measures.csv  one row per measurement: time, weight_kg, fat_pct, fat_mass_kg, systolic, diastolic, pulse
    withings_daily.csv     one row per day: steps, sleep (h), sleep score, night heart rate
"""

import sys
import time
from datetime import date, datetime, timedelta

import oauth_local as oa
from oauth_local import paths

NAME = "withings"
AUTH_URL = "https://account.withings.com/oauth2_user/authorize2"
TOKEN_URL = "https://wbsapi.withings.net/v2/oauth2"
SCOPES = "user.info,user.metrics,user.activity"
MEASURES = paths.SOURCES / "withings_measures.csv"
DAILY = paths.SOURCES / "withings_daily.csv"
MEAS_FIELDS = ["time", "weight_kg", "fat_pct", "fat_mass_kg", "systolic", "diastolic", "pulse"]
DAILY_FIELDS = ["date", "steps", "total_sleep_h", "deep_sleep_h", "rem_sleep_h", "sleep_score", "lowest_hr", "avg_hr_night"]
TYPES = {1: "weight_kg", 6: "fat_pct", 8: "fat_mass_kg", 9: "diastolic", 10: "systolic", 11: "pulse"}


def tokens_from(status, body, what):
    if status != 200 or body.get("status") != 0 or "access_token" not in (body.get("body") or {}):
        sys.exit(f"Withings {what} failed (status {body.get('status', status)}). Connect again: python sylvester.py connect withings")
    b = body["body"]
    b["expires_in"] = b.get("expires_in") or 10800
    return oa.save_tokens(NAME, b)


def auth():
    cfg = oa.config(NAME)
    code = oa.authorize(AUTH_URL, {"response_type": "code", "client_id": cfg["client_id"], "scope": SCOPES}, cfg["redirect_uri"])
    # Withings codes expire after 30 seconds: exchange immediately.
    status, body = oa.post_form(TOKEN_URL, {"action": "requesttoken", "grant_type": "authorization_code", "client_id": cfg["client_id"],
                                            "client_secret": cfg["client_secret"], "code": code, "redirect_uri": cfg["redirect_uri"]})
    tokens_from(status, body, "sign-in")
    print("Withings connected.")


def token():
    cfg, t = oa.config(NAME), oa.load_tokens(NAME)
    if time.time() < t.get("expires_at", 0):
        return t["access_token"]
    status, body = oa.post_form(TOKEN_URL, {"action": "requesttoken", "grant_type": "refresh_token", "client_id": cfg["client_id"],
                                            "client_secret": cfg["client_secret"], "refresh_token": t["refresh_token"]})
    return tokens_from(status, body, "refresh")["access_token"]


def call(url, tok, data):
    """Withings answers HTTP 200 with its own status; 0 is success. Follows `more`/`offset` paging."""
    out, offset = [], None
    while True:
        status, body = oa.post_form(url, {**data, **({"offset": offset} if offset else {})}, token=tok)
        if status != 200 or body.get("status") != 0:
            sys.exit(f"Withings {data.get('action')}: status {body.get('status', status)}")
        out.append(body.get("body") or {})
        if not (body.get("body") or {}).get("more"):
            return out
        offset = body["body"].get("offset")


def pull(start, end):
    tok = token()
    a = int(datetime.fromisoformat(start).timestamp())
    b = int((datetime.fromisoformat(end) + timedelta(days=1)).timestamp())
    rows = []
    for page in call("https://wbsapi.withings.net/measure", tok,
                     {"action": "getmeas", "meastypes": ",".join(map(str, TYPES)), "category": 1, "startdate": a, "enddate": b}):
        for g in page.get("measuregrps") or []:
            r = {"time": datetime.fromtimestamp(g["date"]).isoformat(timespec="seconds")}
            for m in g.get("measures") or []:
                if m.get("type") in TYPES:
                    v = m["value"] * 10 ** m["unit"]
                    r[TYPES[m["type"]]] = round(v, 2) if m["type"] in (1, 6, 8) else int(round(v))
            if len(r) > 1:
                rows.append(r)
    n_m = oa.upsert_csv(MEASURES, MEAS_FIELDS, rows, key="time")

    days = {}
    for page in call("https://wbsapi.withings.net/v2/measure", tok,
                     {"action": "getactivity", "startdateymd": start, "enddateymd": end, "data_fields": "steps"}):
        for x in page.get("activities") or []:
            days.setdefault(x["date"], {"date": x["date"]})["steps"] = x.get("steps")
    fields = "total_sleep_time,deepsleepduration,remsleepduration,sleep_score,hr_min,hr_average"
    for page in call("https://wbsapi.withings.net/v2/sleep", tok,
                     {"action": "getsummary", "startdateymd": start, "enddateymd": end, "data_fields": fields}):
        for x in page.get("series") or []:
            d, s = x.get("date"), x.get("data") or {}
            if not d:
                continue
            h = lambda sec: round(sec / 3600, 2) if sec else None  # noqa: E731
            days.setdefault(d, {"date": d}).update({
                "total_sleep_h": h(s.get("total_sleep_time")), "deep_sleep_h": h(s.get("deepsleepduration")),
                "rem_sleep_h": h(s.get("remsleepduration")), "sleep_score": s.get("sleep_score"),
                "lowest_hr": s.get("hr_min"), "avg_hr_night": s.get("hr_average")})
    n_d = oa.upsert_csv(DAILY, DAILY_FIELDS, list(days.values()))
    print(f"Withings: {n_m} measurements, {n_d} days {start} to {end}")


if __name__ == "__main__":
    args = sys.argv[1:]
    if args[:1] == ["auth"]:
        auth()
    elif args[:1] == ["pull"]:
        end = args[2] if len(args) > 2 else date.today().isoformat()
        start = args[1] if len(args) > 1 else (date.fromisoformat(end) - timedelta(days=6)).isoformat()
        pull(start, end)
    else:
        print(__doc__)
