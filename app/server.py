#!/usr/bin/env python3
"""
Local intake form for the health profile, equipment inventory and goals.

    python sylvester.py form         # opens http://localhost:8765
    python sylvester.py form --lan   # also reachable from your phone on home Wi-Fi
    python sylvester.py setup        # the onboarding wizard (/setup); ends itself when it's finished

Standard library only. By default binds to 127.0.0.1, so nothing is reachable
from the network. With --lan it listens on the local network, and every device
other than this computer must first enter the passcode in <data>/secrets/lan_passcode.txt
(created on first use). Every save keeps the previous version in <data>/profile/.history/.
"""

import csv
import glob
import json
import os
import re
import secrets
import shutil
import socket
import sys
import threading
import webbrowser
from datetime import date, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "coach"))
from core import paths, signals  # noqa: E402
import snapshot  # noqa: E402

PROFILE_DIR = str(paths.PROFILE)
HISTORY_DIR = str(paths.HISTORY)
PORT = 8765
PASSCODE_FILE = str(paths.SECRETS / "lan_passcode.txt")
LAN = "--lan" in sys.argv
WIZARD = "--setup" in sys.argv  # serve the onboarding wizard and stop once it's finished
SETTINGS_KEYS = ("units",)  # what the pages may change in settings.json
SERVER = None
LOCAL_ADDRS = ("127.0.0.1", "::1")  # this computer: never asked for the passcode

DOCS = {
    "health_profile": {},
    "equipment": {"space": {}, "items": []},
    "goals": {"goals": []},
}


DATA_DIR = str(paths.RECORDS)
PLANS_DIR = str(paths.PLANS)
CHECKINS_CSV = os.path.join(DATA_DIR, "checkins.csv")
WORKOUT_CSV = os.path.join(DATA_DIR, "workout_log.csv")
WORKOUT_FIELDS = ["date", "session", "duration_min", "exercise", "sets", "reps", "load_kg", "rpe", "pain", "notes"]
ASSESS_CSV = os.path.join(DATA_DIR, "assessments.csv")
ASSESS_FIELDS = ["date", "battery", "test", "side", "value", "unit", "load_kg", "rpe", "pain", "flags", "note"]


def read_rows(path):
    if not os.path.exists(path):
        return []
    with open(path, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def write_rows(path, fields, rows):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)
    os.replace(tmp, path)


def checkin_fields(rows=()):
    """Common scales + this person's signals, keeping any column an older CSV already has."""
    fields = signals.checkin_fields()
    for r in rows[:1]:
        fields += [k for k in r if k not in fields]
    return fields


def save_checkin(c):
    if not c.get("date"):
        raise ValueError("date is required")
    rows = [r for r in read_rows(CHECKINS_CSV) if r["date"] != c["date"]]
    fields = checkin_fields(rows)
    rows.append({k: c.get(k, "") for k in fields})
    write_rows(CHECKINS_CSV, fields, sorted(rows, key=lambda r: r["date"]))


def save_workout(w):
    """Replace every row of this date + session; an empty exercise list deletes the session."""
    if not w.get("date") or not w.get("session"):
        raise ValueError("date and session are required")
    rows = [r for r in read_rows(WORKOUT_CSV) if not (r["date"] == w["date"] and r["session"] == w["session"])]
    for e in w.get("exercises", []):
        if (e.get("exercise") or "").strip():
            rows.append({"date": w["date"], "session": w["session"], "duration_min": w.get("duration_min", ""),
                         **{k: e.get(k, "") for k in WORKOUT_FIELDS[3:]}})
    write_rows(WORKOUT_CSV, WORKOUT_FIELDS, sorted(rows, key=lambda r: r["date"]))


def save_assessment(a):
    """Replace every result row of this date + battery (test catalogue: coach/assessments.json)."""
    if not a.get("date") or not a.get("battery"):
        raise ValueError("date and battery are required")
    rows = [r for r in read_rows(ASSESS_CSV) if not (r["date"] == a["date"] and r["battery"] == a["battery"])]
    for r in a.get("results", []):
        if r.get("test") and (str(r.get("value", "")).strip() or r.get("note") or r.get("flags")):
            flags = r.get("flags", "")
            rows.append({"date": a["date"], "battery": a["battery"], **{k: r.get(k, "") for k in ASSESS_FIELDS[2:]},
                         "flags": "; ".join(flags) if isinstance(flags, list) else flags})
    write_rows(ASSESS_CSV, ASSESS_FIELDS, sorted(rows, key=lambda r: r["date"]))


def recent_log(days=42):
    since = (date.today() - timedelta(days=days)).isoformat()
    return {
        "checkins": [r for r in read_rows(CHECKINS_CSV) if r["date"] >= since][::-1],
        "workouts": [r for r in read_rows(WORKOUT_CSV) if r["date"] >= since][::-1],
    }


def planned_session(day):
    """Exercises planned for this day, so logging starts pre-filled: the rolling schedule first,
    then a session file the Coach wrote for that date."""
    plan = paths.active_plan_dir()
    sched = paths.read_json(plan / "schedule.json", {}) if plan else {}
    for d in (sched or {}).get("days", []):
        if d.get("date") == day and d.get("session"):
            s = d["session"]
            return {"file": "rolling schedule", "title": s.get("title", ""),
                    "exercises": [{"exercise": e.get("name", ""), "sets": str(e.get("sets", "")), "reps": str(e.get("reps", "")),
                                   "load_kg": str(e.get("load_kg") or ""),
                                   "planned": f"{e.get('sets', '')} × {e.get('reps', '')}" + (f" @ {e['load_kg']} kg" if e.get("load_kg") else "")}
                                  for e in s.get("exercises", [])]}
    files = glob.glob(os.path.join(PLANS_DIR, "*", "sessions", f"{day}.md"))
    if not files:
        return None
    path = max(files, key=os.path.getmtime)
    with open(path, encoding="utf-8-sig") as f:  # -sig: tolerate the BOM Notepad adds
        text = f.read()
    exercises, cols = [], None
    for line in text.splitlines():
        if not line.strip().startswith("|"):
            cols = None if not line.strip() else cols
            continue
        cells = [c.strip().strip("*") for c in line.strip().strip("|").split("|")]
        if cols is None:
            low = [c.lower() for c in cells]
            if any("exercise" in c for c in low):
                cols = low
            continue
        if set("".join(cells)) <= set("-: "):
            continue
        row = dict(zip(cols, cells))
        name = next((v for k, v in row.items() if "exercise" in k), "")
        scheme = next((v for k, v in row.items() if "set" in k or "rep" in k), "")
        load = next((v for k, v in row.items() if "load" in k or "weight" in k or "rpe" in k), "")
        m = re.match(r"\s*(\d+)\s*[×x]\s*([\d–\-]+)", scheme)
        if name:
            exercises.append({"exercise": name, "sets": m.group(1) if m else "", "reps": m.group(2) if m else scheme,
                              "load_kg": "", "planned": " · ".join(x for x in (scheme, load) if x)})
    title = next((l.lstrip("# ").strip() for l in text.splitlines() if l.startswith("#")), os.path.basename(path))
    return {"file": os.path.relpath(path, PLANS_DIR), "title": title, "exercises": exercises}


def doc_path(name):
    return os.path.join(PROFILE_DIR, f"{name}.json")


def read_doc(name):
    path = doc_path(name)
    if not os.path.exists(path):
        return DOCS[name]
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def write_doc(name, data):
    os.makedirs(HISTORY_DIR, exist_ok=True)
    path = doc_path(name)
    if os.path.exists(path):
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        shutil.copy2(path, os.path.join(HISTORY_DIR, f"{name}-{stamp}.json"))
    data["_updated"] = datetime.now().isoformat(timespec="seconds")
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    os.replace(tmp, path)
    return data


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body, ctype="application/json; charset=utf-8"):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, ensure_ascii=False).encode("utf-8")
        elif isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _allowed(self):
        """This PC always; other devices only with the passcode cookie (LAN mode)."""
        if self.client_address[0] in LOCAL_ADDRS:
            return True
        cookie = self.headers.get("Cookie", "")
        return LAN and f"hgc={lan_passcode()}" in [c.strip() for c in cookie.split(";")]

    def _login(self):
        code = self.path.split("code=")[1].split("&")[0] if "code=" in self.path else ""
        if code and secrets.compare_digest(code, lan_passcode()):
            self.send_response(303)
            self.send_header("Set-Cookie", f"hgc={code}; Max-Age=31536000; Path=/; HttpOnly; SameSite=Strict")
            self.send_header("Location", "/")
            self.end_headers()
            return
        form = ("<!doctype html><meta name=viewport content='width=device-width,initial-scale=1'>"
                "<title>Sylvester — passcode</title><body style='font:18px system-ui;padding:24px;max-width:420px'>"
                "<h1 style='font-size:22px'>Enter passcode</h1>"
                + ("<p style='color:#c0392b'>That passcode isn't right.</p>" if code else "")
                + "<p>It's in <code>secrets/lan_passcode.txt</code> in the data folder, and printed in the window that started the form.</p>"
                "<form action='/login'><input name=code inputmode=numeric autofocus style='font:22px system-ui;padding:8px;width:10ch'> "
                "<button style='font:18px system-ui;padding:8px 16px'>Open</button></form>")
        self._send(401, form, "text/html; charset=utf-8")

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/login" or not self._allowed():
            return self._login()
        if path in ("/", "/index.html", "/setup"):
            page = "setup.html" if path == "/setup" else "index.html"
            with open(os.path.join(HERE, page), "rb") as f:
                return self._send(200, f.read(), "text/html; charset=utf-8")
        if path == "/api/settings":
            s = paths.settings()
            return self._send(200, {k: s.get(k) for k in SETTINGS_KEYS})
        if path == "/api/snapshot":
            try:
                return self._send(200, snapshot.build(write=True))
            except Exception as e:  # show the reason in the tab instead of a blank page
                return self._send(500, {"error": str(e)})
        if path == "/api/log":
            return self._send(200, recent_log())
        if path == "/api/signals":
            return self._send(200, signals.for_forms())
        if path == "/api/planned":
            day = (self.path.split("day=")[1][:10] if "day=" in self.path else date.today().isoformat())
            return self._send(200, planned_session(day) or {})
        name = path.removeprefix("/api/")
        if name in DOCS:
            return self._send(200, read_doc(name))
        self._send(404, {"error": "not found"})

    def do_POST(self):
        if not self._allowed():
            return self._send(401, {"error": "passcode required"})
        name = self.path.split("?")[0].removeprefix("/api/")
        if name == "finish":
            self._send(200, {"ok": True})
            if WIZARD and SERVER:  # the person is done: end the process, which tells Claude to carry on
                print("Setup wizard finished.", flush=True)
                threading.Timer(1.0, SERVER.shutdown).start()
            return
        if name not in DOCS and name not in ("checkin", "workout", "settings"):
            return self._send(404, {"error": "not found"})
        length = int(self.headers.get("Content-Length", 0))
        try:
            data = json.loads(self.rfile.read(length).decode("utf-8"))
        except ValueError as e:
            return self._send(400, {"error": f"bad JSON: {e}"})
        if not isinstance(data, dict):
            return self._send(400, {"error": "expected an object"})
        try:
            if name == "checkin":
                save_checkin(data)
                return self._send(200, recent_log())
            if name == "workout":
                save_workout(data)
                return self._send(200, recent_log())
            if name == "settings":
                s = paths.settings()
                s.update({k: data[k] for k in SETTINGS_KEYS if k in data})
                paths.save_settings(s)
                return self._send(200, {k: s.get(k) for k in SETTINGS_KEYS})
        except ValueError as e:
            return self._send(400, {"error": str(e)})
        self._send(200, write_doc(name, data))

    def log_message(self, fmt, *args):
        pass


def lan_passcode():
    if not os.path.exists(PASSCODE_FILE):
        os.makedirs(os.path.dirname(PASSCODE_FILE), exist_ok=True)
        with open(PASSCODE_FILE, "w", encoding="utf-8") as f:
            f.write("".join(secrets.choice("0123456789") for _ in range(8)))
    with open(PASSCODE_FILE, encoding="utf-8") as f:
        return f.read().strip()


def lan_ip():
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        try:
            s.connect(("192.168.0.1", 9))  # no packet is sent; this just picks the Wi-Fi interface
            return s.getsockname()[0]
        except OSError:
            return "this-computer-ip"


def main():
    global SERVER
    url = f"http://localhost:{PORT}" + ("/setup" if WIZARD else "")
    try:
        SERVER = server = ThreadingHTTPServer(("0.0.0.0" if LAN else "127.0.0.1", PORT), Handler)
    except OSError:
        print(f"Port {PORT} is busy: the form is probably already running. Opening {url} in it.")
        if "--no-browser" not in sys.argv:
            webbrowser.open(url)
        return
    print(f"Sylvester {'setup' if WIZARD else 'form'} running at {url}  (Ctrl+C to stop)")
    print(f"Data folder: {paths.DATA}")
    if LAN:
        print(f"On your phone (same Wi-Fi): http://{lan_ip()}:{PORT}{'/setup' if WIZARD else ''}  passcode {lan_passcode()}")
        print("If the firewall asks, allow it on private/home networks only.")
    if "--no-browser" not in sys.argv:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
