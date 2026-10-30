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
            return 200, {"data": [{"day": "2026-10-28", "score": 64, "contributors": {}}], "next_token": None}
        Fake.routes.update({
            ("POST", "/oura/token"): (200, {"access_token": "new", "refresh_token": "r2", "expires_in": 86400}),
            ("GET", "/oura/daily_readiness"): readiness,
            ("GET", "/oura/daily_sleep"): (200, {"data": [{"day": "2026-10-28", "score": 70}]}),
            ("GET", "/oura/daily_activity"): (200, {"data": [{"day": "2026-10-28", "steps": 8000, "score": 80}]}),
            ("GET", "/oura/daily_stress"): (200, {"data": [{"day": "2026-10-28", "stress_high": 3600}]}),
            ("GET", "/oura/daily_resilience"): (200, {"data": []}),
            ("GET", "/oura/sleep"): (200, {"data": [{"day": "2026-10-28", "type": "long_sleep", "total_sleep_duration": 25200,
                                                     "average_hrv": 48, "lowest_heart_rate": 52}]}),
        })
        quiet(oura_pull.cmd_pull, "2026-10-27", "2026-10-28")
        got = {r["date"]: r for r in rows("oura_daily.csv")}
        self.assertEqual(got["2026-10-27"]["readiness_score"], "81")
        self.assertEqual(got["2026-10-28"]["readiness_score"], "64")
        self.assertEqual(got["2026-10-28"]["total_sleep_h"], "7.0")
        self.assertEqual(got["2026-10-28"]["stress_high_min"], "60")
        self.assertEqual(json.loads((DATA / "secrets" / "oura_tokens.json").read_text())["refresh_token"], "r2")


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
