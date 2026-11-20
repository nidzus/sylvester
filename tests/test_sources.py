"""Wearable pulls against a fake API on localhost (no network), then the snapshot and trends reading them."""

import contextlib
import csv
import io
import json
import threading
import time
import unittest
from datetime import date
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

from tests import DATA, remove, write

import http_lite
import oauth_local as oa


class Fake(BaseHTTPRequestHandler):
    """Answers by (method, path); records every request it saw."""
    routes, seen = {}, []

    def handle_any(self):
        u = urlparse(self.path)
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        Fake.seen.append({"method": self.command, "path": u.path, "query": parse_qs(u.query), "headers": dict(self.headers),
                          "body": body, "length": self.headers.get("Content-Length")})
        route = Fake.routes.get((self.command, u.path))
        status, payload = route(Fake.seen[-1]) if callable(route) else (route or (404, {"error": "no route"}))
        data = b"" if payload is None else json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    do_GET = do_POST = do_PUT = handle_any

    def log_message(self, *a):
        pass


def setUpModule():
    global SERVER, BASE
    SERVER = HTTPServer(("127.0.0.1", 0), Fake)
    BASE = f"http://127.0.0.1:{SERVER.server_port}"
    threading.Thread(target=SERVER.serve_forever, daemon=True).start()


def tearDownModule():
    SERVER.shutdown()


def quiet(fn, *a):
    with contextlib.redirect_stdout(io.StringIO()):
        return fn(*a)


def rows(name):
    with open(DATA / "sources" / name, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


class HttpLite(unittest.TestCase):
    def setUp(self):
        Fake.seen.clear()

    def test_get_with_params_and_json(self):
        Fake.routes[("GET", "/x")] = (200, {"ok": 1})
        r = http_lite.get(BASE + "/x", params={"a": "1", "skip": None}, headers={"Authorization": "Bearer t"})
        self.assertEqual((r.status_code, r.json()), (200, {"ok": 1}))
        self.assertEqual(Fake.seen[-1]["query"], {"a": ["1"]})
        self.assertEqual(Fake.seen[-1]["headers"]["Authorization"], "Bearer t")

    def test_post_form_with_basic_auth(self):
        Fake.routes[("POST", "/f")] = (200, {})
        http_lite.post(BASE + "/f", data={"grant_type": "x y"}, auth=("id", "secret"))
        seen = Fake.seen[-1]
        self.assertEqual(parse_qs(seen["body"].decode()), {"grant_type": ["x y"]})
        self.assertEqual(seen["headers"]["Authorization"], "Basic aWQ6c2VjcmV0")

    def test_post_json_and_empty_bodies(self):
        Fake.routes[("POST", "/j")] = (201, {})
        Fake.routes[("PUT", "/j")] = (200, None)
        http_lite.post(BASE + "/j", json={"member-id": "m"})
        self.assertEqual(json.loads(Fake.seen[-1]["body"]), {"member-id": "m"})
        http_lite.post(BASE + "/j")
        self.assertEqual(Fake.seen[-1]["length"], "0")
        self.assertEqual(http_lite.put(BASE + "/j").status_code, 200)

    def test_errors_come_back_as_responses(self):
        Fake.routes[("GET", "/no")] = (401, {"error": "nope"})
        r = http_lite.get(BASE + "/no")
        self.assertEqual(r.status_code, 401)
        self.assertFalse(r.ok)
        with self.assertRaises(http_lite.HTTPError):
            r.raise_for_status()


class Oura(unittest.TestCase):
    def test_pull_refreshes_an_expired_token_and_follows_pages(self):
        import oura_pull
        oura_pull.API, oura_pull.TOKEN_URL = BASE + "/oura", BASE + "/oura/token"
        write("secrets/oura_config.json", {"client_id": "c", "client_secret": "s", "redirect_uri": "http://localhost:3000/callback"})
        write("secrets/oura_tokens.json", {"access_token": "old", "refresh_token": "r1"})

        def readiness(req):
            if req["headers"]["Authorization"] != "Bearer new":
                return 401, {}
            if "next_token" not in req["query"]:
                return 200, {"data": [{"day": "2026-10-27", "score": 81, "temperature_deviation": 0.1,
                                       "contributors": {"hrv_balance": 77}}], "next_token": "p2"}
            return 200, {"data": [{"day": "2026-10-28", "score": 64,
                                   "contributors": {"recovery_index": 41, "sleep_balance": 66, "body_temperature": 98}}],
                         "next_token": None}
        Fake.routes.update({
            ("POST", "/oura/token"): (200, {"access_token": "new", "refresh_token": "r2", "expires_in": 86400}),
            ("GET", "/oura/daily_readiness"): readiness,
            ("GET", "/oura/daily_sleep"): (200, {"data": [{"day": "2026-10-28", "score": 70,
                                                           "contributors": {"rem_sleep": 35, "total_sleep": 61, "timing": 90}}]}),
            ("GET", "/oura/rest_mode_period"): (200, {"data": [{"start_day": "2026-10-20", "end_day": "2026-10-28"}]}),
            ("GET", "/oura/personal_info"): (200, {"weight": 91.24, "height": 1.8}),
            ("GET", "/oura/daily_activity"): (200, {"data": [{"day": "2026-10-28", "steps": 8000, "score": 80}]}),
            ("GET", "/oura/daily_stress"): (200, {"data": [{"day": "2026-10-28", "stress_high": 3600}]}),
            ("GET", "/oura/daily_resilience"): (200, {"data": []}),
            ("GET", "/oura/sleep"): (200, {"data": [{"day": "2026-10-28", "type": "long_sleep", "total_sleep_duration": 25200,
                                                     "average_hrv": 48, "lowest_heart_rate": 52,
                                                     "bedtime_start": "2026-10-27T23:41:12+01:00",
                                                     "bedtime_end": "2026-10-28T06:58:40+01:00"}]}),
            ("GET", "/oura/daily_spo2"): (200, {"data": [{"day": "2026-10-28", "spo2_percentage": {"average": 96.1},
                                                         "breathing_disturbance_index": 2}]}),
            ("GET", "/oura/vO2_max"): (401, {}),  # a sign-in without heart_health
            ("GET", "/oura/workout"): (200, {"data": [{"id": "w1", "day": "2026-10-28", "activity": "walking", "intensity": "easy",
                                                      "start_datetime": "2026-10-28T08:00:00+01:00",
                                                      "end_datetime": "2026-10-28T08:40:00+01:00", "calories": 150}]}),
        })
        Fake.seen.clear()
        quiet(oura_pull.cmd_pull, "2026-10-27", "2026-10-28")
        ends = {q["query"]["end_date"][0] for q in Fake.seen if q["path"].startswith("/oura/") and "end_date" in q["query"]}
        self.assertEqual(ends, {"2026-10-29"})  # asked a day past the end: Oura's sleep endpoints treat end_date as exclusive
        got = {r["date"]: r for r in rows("oura_daily.csv")}
        self.assertEqual(got["2026-10-27"]["readiness_score"], "81")
        self.assertEqual(got["2026-10-28"]["readiness_score"], "64")
        self.assertEqual(got["2026-10-28"]["total_sleep_h"], "7.0")
        self.assertEqual(got["2026-10-28"]["stress_high_min"], "60")
        self.assertEqual((got["2026-10-28"]["spo2_avg"], got["2026-10-28"]["breathing_disturbance_index"]), ("96.1", "2"))
        self.assertEqual(got["2026-10-28"]["vo2_max"], "")  # unavailable endpoints (401, 404) are skipped, not fatal
        d = got["2026-10-28"]
        self.assertEqual((d["recovery_index_contrib"], d["sleep_balance_contrib"], d["activity_balance_contrib"]), ("41", "66", ""))
        self.assertEqual((d["sleep_rem_contrib"], d["sleep_total_contrib"], d["sleep_timing_contrib"]), ("35", "61", "90"))
        self.assertEqual((d["bedtime_start"], d["bedtime_end"]), ("2026-10-27T23:41", "2026-10-28T06:58"))
        # Rest Mode on from the 20th; switched off on the 28th, so that day no longer counts.
        self.assertEqual((got["2026-10-27"]["rest_mode"], d["rest_mode"]), ("1", "0"))
        rest_q = next(q for q in Fake.seen if q["path"] == "/oura/rest_mode_period")["query"]
        self.assertEqual(rest_q["start_date"], ["2026-08-28"])  # looks back for a period that began before the pull
        self.assertEqual(rows("oura_weight.csv")[-1], {"date": date.today().isoformat(), "weight_kg": "91.2"})
        remove("sources/oura_weight.csv")

    def test_profile_weight_is_kept_only_when_it_changes(self):
        import oura_pull
        self.addCleanup(remove, "sources/oura_weight.csv")
        rec = oura_pull.record_weight
        self.assertTrue(rec(100.6, "2026-11-19"))
        self.assertFalse(rec(100.6, "2026-11-19"))   # pulled again the same day: nothing new
        self.assertFalse(rec(100.6, "2026-11-20"))   # same as before: nothing new
        self.assertFalse(rec(None, "2026-11-20"))    # no weight in the profile
        self.assertTrue(rec(100.2, "2026-11-21"))
        self.assertTrue(rec(100.0, "2026-11-21"))    # changed again the same day: that day keeps the latest
        self.assertEqual([(r["date"], r["weight_kg"]) for r in rows("oura_weight.csv")],
                         [("2026-11-19", "100.6"), ("2026-11-21", "100.0")])
        self.assertTrue(rec(100.6, "2026-11-21"))    # and back to the earlier value: no new reading that day
        self.assertEqual([(r["date"], r["weight_kg"]) for r in rows("oura_weight.csv")], [("2026-11-19", "100.6")])

    def test_snapshot_weight_uses_the_newer_oura_reading(self):
        import snapshot
        self.addCleanup(remove, "sources/oura_weight.csv")
        self.addCleanup(remove, "sources/apple_daily.csv")
        write("sources/apple_daily.csv", "date,weight_kg\n2026-10-15,104.1\n2026-11-01,103.0\n")
        write("sources/oura_weight.csv", "date,weight_kg\n2026-11-01,102.5\n2026-11-19,100.6\n")
        by = {r["date"]: r for r in snapshot.scale_rows()}
        self.assertEqual((by["2026-11-01"]["weight_kg"], by["2026-11-01"]["source"]), ("103.0", "Apple Health"))  # Apple wins a tie
        b = snapshot.body(date(2026, 11, 20))
        self.assertEqual((b["weight_kg"], b["weight_date"], b["weight_age_days"]), (100.6, "2026-11-19", 1))
        self.assertEqual(b["weight_change_kg"]["30d"], -3.5)
        self.assertEqual(rows("oura_workouts.csv")[0]["duration_min"], "40")
        self.assertEqual(json.loads((DATA / "secrets" / "oura_tokens.json").read_text())["refresh_token"], "r2")


class CatchUp(unittest.TestCase):
    """A default pull catches up after days with the computer off, and says which days the source itself lacks."""

    def csv_with(self, last):
        p = write("sources/catch_up_test.csv", "date,steps\n2026-07-01,5000\n" + (f"{last},7000\n" if last else ""))
        self.addCleanup(remove, "sources/catch_up_test.csv")
        return p

    def test_window(self):
        import catch_up
        today = date(2026, 11, 14)
        self.assertEqual(catch_up.window(DATA / "sources" / "missing.csv", today), ("2026-11-07", "2026-11-14", ""))
        # Pulled yesterday: still the last week, since a ring can sync to its app days late.
        self.assertEqual(catch_up.window(self.csv_with("2026-11-13"), today)[:2], ("2026-11-07", "2026-11-14"))
        # Laptop off since the 4th: from the last stored day (fetched again, it may be incomplete).
        self.assertEqual(catch_up.window(self.csv_with("2026-11-04"), today)[:2], ("2026-11-04", "2026-11-14"))
        # Off for months: capped, with the range to pull by hand.
        start, end, note = catch_up.window(self.csv_with("2026-08-01"), today)
        self.assertEqual(start, "2026-09-15")
        self.assertIn("2026-08-01 2026-09-14", note)
        self.assertEqual(catch_up.days_between("2026-10-30", "2026-11-02"), ["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"])
        self.assertEqual(catch_up.ranges(["2026-11-12", "2026-11-05", "2026-11-06", "2026-11-07"]), "2026-11-05 to 2026-11-07, 2026-11-12")

    def test_oura_lists_the_days_oura_itself_lacks(self):
        import oura_pull
        got = [{"date": "2026-11-05", "total_sleep_h": 7.1, "sleep_score": 80},
               {"date": "2026-11-07", "total_sleep_h": None, "sleep_score": None, "steps": 4000}]
        lines = oura_pull.gap_report("2026-11-05", "2026-11-09", got, today=date(2026, 11, 9))
        self.assertEqual(lines, ["Oura has no data for: 2026-11-06, 2026-11-08 (ring not worn, or not yet synced to the Oura app).",
                                 "Oura has no night recorded for: 2026-11-07."])
        self.assertEqual(oura_pull.gap_report("2026-11-05", "2026-11-05", got[:1], today=date(2026, 11, 9)), [])

    def test_oura_asks_past_the_last_day_and_never_erases_a_night(self):
        import oura_pull
        oura_pull.merge_rows([{"date": "2026-11-14", "readiness_score": 80, "total_sleep_h": 7.1, "lowest_hr": 55}])
        oura_pull.merge_rows([{"date": "2026-11-14", "readiness_score": 81, "total_sleep_h": None, "lowest_hr": None}])
        got = {r["date"]: r for r in rows("oura_daily.csv")}["2026-11-14"]
        self.assertEqual((got["readiness_score"], got["total_sleep_h"], got["lowest_hr"]), ("81", "7.1", "55"))

    def test_rest_mode_days(self):
        import oura_pull
        on = oura_pull.rest_mode_on
        ps = [{"start_day": "2026-11-10", "end_day": "2026-11-13"}, {"start_day": "2026-11-15", "end_day": "2026-11-15"},
              {"start_day": "2026-11-18", "end_day": None}]
        self.assertEqual([on(ps, f"2026-11-{d:02d}") for d in range(9, 20)], [0, 1, 1, 1, 0, 0, 1, 0, 0, 1, 1])
        self.assertEqual(on([], "2026-11-10"), 0)

    def test_oura_adds_up_the_sessions_and_takes_the_night_for_the_rest(self):
        import oura_pull
        recs = [{"day": "2026-11-12", "type": "sleep", "total_sleep_duration": 430},
                {"day": "2026-11-12", "type": "long_sleep", "total_sleep_duration": 21600, "deep_sleep_duration": 3600,
                 "lowest_heart_rate": 58, "average_hrv": 44, "latency": 600},
                {"day": "2026-11-12", "type": "late_nap", "total_sleep_duration": 650, "deep_sleep_duration": 0},
                {"day": "2026-11-12", "type": "rest", "total_sleep_duration": 9000},
                {"day": "2026-11-13", "type": "sleep", "total_sleep_duration": 900},
                {"day": "2026-11-13", "type": "sleep", "total_sleep_duration": 5400, "lowest_heart_rate": 58}]
        by_day = oura_pull.sleep_by_day(recs)
        d = oura_pull.sleep_fields(by_day["2026-11-12"])
        self.assertEqual((d["total_sleep_h"], d["night_sleep_h"], d["nap_sleep_h"], d["sleep_sessions"]), (6.3, 6.0, 0.3, 3))
        self.assertEqual((d["lowest_hr"], d["avg_hrv"], d["latency_min"], d["deep_sleep_h"]), (58, 44, 10, 1.0))
        d = oura_pull.sleep_fields(by_day["2026-11-13"])
        self.assertEqual((d["night_sleep_h"], d["lowest_hr"], d["sleep_sessions"]), (1.5, 58, 2))


class NightSleep(unittest.TestCase):
    def test_naps_count_in_the_hours_but_a_short_night_still_flags(self):
        import snapshot
        from datetime import timedelta
        today = date(2026, 11, 20)
        lines = ["date,readiness_score,total_sleep_h,night_sleep_h,avg_hrv,lowest_hr"]
        for i in range(40):
            d = (today - timedelta(days=i)).isoformat()
            lines.append(f"{d},82,7.4,{5.2 if i < 7 else 7.4},45,52")
        write("sources/oura_daily.csv", "\n".join(lines) + "\n")
        self.addCleanup(remove, "sources/oura_daily.csv")
        rec = snapshot.recovery(today)
        self.assertTrue(any(f.startswith("Averaging 5.2 h of night sleep") for f in rec["flags"]), rec["flags"])
        self.assertEqual(snapshot.night_h({"total_sleep_h": "6.6"}), 6.6)  # older rows: the total is the night


class OuraDetail(unittest.TestCase):
    TODAY = date(2026, 11, 20)

    def days(self, rest=(), extra=lambda i: {}):
        from datetime import timedelta
        rows = []
        for i in range(30):
            d = (self.TODAY - timedelta(days=29 - i)).isoformat()
            rows.append({"date": d, "readiness_score": "84", "total_sleep_h": "7.2", "avg_hrv": "45", "lowest_hr": "52",
                         "rest_mode": "1" if d in rest else "0", **extra(i)})
        fields = list(dict.fromkeys(k for r in rows for k in r))
        write("sources/oura_daily.csv", "\n".join([",".join(fields)] + [",".join(r.get(k, "") for k in fields) for r in rows]) + "\n")
        self.addCleanup(remove, "sources/oura_daily.csv")

    def test_rest_mode_on_is_red_and_says_since_when(self):
        import snapshot
        self.days(rest={"2026-11-18", "2026-11-19", "2026-11-20"})
        rec = snapshot.recovery(self.TODAY)
        self.assertEqual(rec["rest_mode"], {"on": True, "since": "2026-11-18", "ended": None})
        self.assertEqual((rec["status"], rec["status_why"][0]), ("red", "Oura rest mode on since 2026-11-18"))

    def test_rest_mode_ended_lately_and_long_ago(self):
        import snapshot
        self.days(rest={"2026-11-12", "2026-11-13"})
        rec = snapshot.recovery(self.TODAY)
        self.assertEqual(rec["rest_mode"], {"on": False, "since": None, "ended": "2026-11-14"})
        self.assertEqual(rec["status"], "green")
        self.days(rest={"2026-10-22"})
        self.assertEqual(snapshot.recovery(self.TODAY)["rest_mode"], {"on": False, "since": None, "ended": None})

    def test_low_parts_and_bedtimes(self):
        import snapshot
        beds = ["23:10", "23:40", "00:20"]  # either side of midnight
        self.days(extra=lambda i: {"recovery_index_contrib": "41", "sleep_balance_contrib": "66", "hrv_balance": "90",
                                   "sleep_rem_contrib": "35", "sleep_total_contrib": "80",
                                   "bedtime_start": f"2026-11-01T{beds[i % 3]}", "bedtime_end": "2026-11-02T07:05"})
        od = snapshot.oura_detail(self.TODAY)
        self.assertEqual(od["readiness_parts"]["low"], ["recovery index", "sleep balance"])
        self.assertEqual(od["sleep_parts"]["low"], ["REM"])
        bt = od["bedtime"]
        self.assertEqual((bt["last_bed"], bt["last_wake"]), (beds[29 % 3], "07:05"))
        self.assertEqual(bt["avg_7d"][:2], "23")  # 23:10, 23:40 and 00:20 average to before midnight, not to noon
        self.assertGreater(bt["spread_7d_min"], 0)
        md = snapshot.to_markdown(snapshot.build(write=False, today=self.TODAY))
        self.assertIn("Readiness parts (2026-11-20): low (under 70): recovery index 41, sleep balance 66", md)
        self.assertIn(f"Bedtime (2026-11-20): {beds[29 % 3]} → 07:05", md)

    def test_older_rows_have_no_detail_and_no_rest_mode(self):
        import snapshot
        write("sources/oura_daily.csv", "date,readiness_score,total_sleep_h,hrv_balance\n2026-11-20,80,7.0,88\n")
        self.addCleanup(remove, "sources/oura_daily.csv")
        self.assertIsNone(snapshot.oura_detail(self.TODAY))
        self.assertIsNone(snapshot.recovery(self.TODAY)["rest_mode"])


class Polar(unittest.TestCase):
    def test_exercise_transaction_is_read_and_committed(self):
        import polar_pull
        polar_pull.API = BASE + "/polar"
        write("secrets/polar_tokens.json", {"access_token": "t", "user_id": 7})
        Fake.routes.update({
            ("POST", "/polar/users/7/exercise-transactions"): (201, {"resource-uri": BASE + "/polar/tx/1"}),
            ("GET", "/polar/tx/1"): (200, {"exercises": [BASE + "/polar/ex/9"]}),
            ("GET", "/polar/ex/9"): (200, {"id": 9, "start-time": "2026-10-28T18:00:00", "sport": "STRENGTH_TRAINING",
                                          "duration": "PT45M", "calories": 300, "heart-rate": {"average": 118, "maximum": 160}}),
            ("PUT", "/polar/tx/1"): (200, None),
            ("POST", "/polar/users/7/activity-transactions"): (204, None),
            ("POST", "/polar/users/7/physical-information-transactions"): (204, None),
            ("GET", "/polar/users/sleep/"): (200, {"nights": []}),
            ("GET", "/polar/users/nightly-recharge/"): (200, {"recharges": []}),
        })
        Fake.seen.clear()
        quiet(polar_pull.cmd_pull)
        ex = rows("polar_exercises.csv")
        self.assertEqual((ex[0]["sport"], ex[0]["duration_min"], ex[0]["hr_avg"]), ("STRENGTH_TRAINING", "45.0", "118"))
        self.assertIn(("PUT", "/polar/tx/1"), [(s["method"], s["path"]) for s in Fake.seen])


def fake_whoop(url, token, params=None):
    days = [(19, 70), (20, 72), (21, 66), (22, 80), (23, 75), (24, 71), (25, 69), (26, 74), (27, 68), (28, 31)]
    if url.endswith("/recovery"):
        return 200, {"records": [{"cycle_id": i, "sleep_id": f"s{i}", "created_at": f"2026-10-{d:02d}T07:00:00Z",
                                  "score": {"recovery_score": sc, "resting_heart_rate": 52, "hrv_rmssd_milli": 61.3,
                                            "skin_temp_celsius": 33.6 + (0.7 if d == 28 else 0)}} for i, (d, sc) in enumerate(days)]}
    if url.endswith("/activity/sleep"):
        return 200, {"records": [{"id": f"s{i}", "nap": False, "end": f"2026-10-{d:02d}T06:40:00Z", "score": {"stage_summary": {
            "total_light_sleep_time_milli": 12_600_000, "total_slow_wave_sleep_time_milli": 5_400_000,
            "total_rem_sleep_time_milli": 6_300_000}, "sleep_performance_percentage": 88}} for i, (d, _) in enumerate(days)]}
    if url.endswith("/cycle"):
        return 200, {"records": [{"id": i, "score": {"strain": 11.2, "kilojoule": 9000}} for i in range(10)]}
    raise AssertionError(url)


def fake_withings(url, data, token=None):
    t = int(time.mktime((2026, 10, 27, 7, 30, 0, 0, 0, -1)))
    return 200, {"status": 0, "body": {
        "getmeas": {"measuregrps": [{"date": t, "measures": [{"value": 88350, "type": 1, "unit": -3}, {"value": 214, "type": 6, "unit": -1}]},
                                    {"date": t + 600, "measures": [{"value": 138, "type": 10, "unit": 0}, {"value": 87, "type": 9, "unit": 0}]}]},
        "getactivity": {"activities": [{"date": "2026-10-27", "steps": 9321}]},
        "getsummary": {"series": [{"date": "2026-10-27", "data": {"total_sleep_time": 25200, "sleep_score": 81}}]},
    }[data["action"]]}


class WhoopWithings(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        for n in ("whoop", "withings"):
            write(f"secrets/{n}_config.json", {"client_id": "x", "client_secret": "y", "redirect_uri": "http://localhost:3002/callback"})
            oa.save_tokens(n, {"access_token": "t", "refresh_token": "r", "expires_in": 3600})
        import whoop_pull
        import withings_pull
        whoop_pull.oa.get_json, withings_pull.oa.post_form = fake_whoop, fake_withings
        remove("sources/oura_daily.csv")  # WHOOP is then the freshest recovery source
        quiet(whoop_pull.pull, "2026-10-19", "2026-10-28")
        quiet(withings_pull.pull, "2026-10-21", "2026-10-28")

    def test_whoop_rows_and_temperature(self):
        last = rows("whoop_daily.csv")[-1]
        self.assertEqual((last["date"], last["readiness_score"], last["temperature_deviation"]), ("2026-10-28", "31", "0.7"))

    def test_snapshot_uses_whoop_bands_and_withings_readings(self):
        import snapshot
        s = snapshot.build(write=False, today=date(2026, 10, 28))
        self.assertEqual((s["recovery"]["source"], s["recovery"]["status"]), ("WHOOP", "red"))
        self.assertEqual(s["body"]["weight_kg"], 88.35)
        self.assertIn("Withings", s["body"]["weight_source"])
        self.assertIn("138/87", json.dumps(s["blood_pressure"]))
        self.assertEqual(s["recovery"]["status_why"][:2], ["temperature +0.7 °C", "recovery 31 is under 34"])

    def test_phone_status_has_trend_days_and_no_profile(self):
        import phone
        quiet(phone.status)
        doc = json.loads((DATA / "phone/outbox/status/current.json").read_text(encoding="utf-8"))
        self.assertEqual(len(doc["days"]), 14)
        self.assertEqual([m["key"] for m in doc["metrics"]], ["readiness_score", "avg_hrv", "lowest_hr", "total_sleep_h", "steps"])
        self.assertIn("recovery 31 is under 34", doc["recovery"]["why"])
        self.assertFalse({"body", "blood_pressure", "conditions"} & set(doc))

    def test_trends_read_both(self):
        import trends
        t = quiet(trends.build, date(2026, 10, 28))
        self.assertEqual(t["year_over_year"]["WHOOP recovery"]["n"], 10)
        self.assertEqual(t["year_over_year"]["BP sys"]["last_90d"], 138)
        self.assertIn("2026", t["bp_profile"]["by_year"])


if __name__ == "__main__":
    unittest.main()
