"""Small OAuth2 helper for the wearable pulls, standard library only (no `requests`, so it works on a
fresh Mac Python too).

- authorize(): opens the browser and catches the redirect on http://localhost:<port>/... itself. If the
  app's registered redirect isn't on localhost, it asks you to paste the address you landed on.
- post_form() / get_json(): JSON over HTTPS.
- Tokens live in <data>/secrets/<name>_tokens.json (owner-only). Refresh tokens rotate: always save the
  new one, and never print them.
"""

import json
import os
import secrets
import sys
import threading
import time
import urllib.error
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlencode, urlparse

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from core import paths  # noqa: E402
from http_lite import open_url  # noqa: E402

UA = {"User-Agent": "Sylvester/1 (personal training coach)"}


def config(name):
    p = paths.SECRETS / f"{name}_config.json"
    if not p.exists():
        sys.exit(f"Missing {p}. See docs/CONNECT.md, or ask your Coach to set up {name.title()}.")
    return json.loads(p.read_text(encoding="utf-8"))


def save_tokens(name, tokens):
    p = paths.SECRETS / f"{name}_tokens.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    tokens = {**tokens, "expires_at": int(time.time()) + int(tokens.get("expires_in") or 3600) - 120}
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(tokens, indent=2), encoding="utf-8")
    os.replace(tmp, p)
    try:
        os.chmod(p, 0o600)
    except OSError:
        pass
    return tokens


def load_tokens(name):
    p = paths.SECRETS / f"{name}_tokens.json"
    if not p.exists():
        sys.exit(f"Not connected yet. Run: python sylvester.py connect {name}")
    return json.loads(p.read_text(encoding="utf-8"))


def post_form(url, data, token=None):
    body = urlencode(data).encode()
    headers = {**UA, "Content-Type": "application/x-www-form-urlencoded"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with open_url(req, 30) as r:
            return r.status, json.loads(r.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode() or "{}")
        except ValueError:
            return e.code, {}


def get_json(url, token, params=None):
    full = url + ("?" + urlencode({k: v for k, v in (params or {}).items() if v is not None}) if params else "")
    req = urllib.request.Request(full, headers={**UA, "Authorization": f"Bearer {token}"})
    try:
        with open_url(req, 30) as r:
            return r.status, json.loads(r.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        return e.code, {}


def authorize(auth_url, params, redirect_uri, timeout=180):
    """Send the person to the provider's consent page and return the authorization code."""
    state = secrets.token_urlsafe(16)
    url = f"{auth_url}?{urlencode({**params, 'redirect_uri': redirect_uri, 'state': state})}"
    target = urlparse(redirect_uri)
    if target.hostname not in ("localhost", "127.0.0.1"):
        print("Open this address, approve, then paste the full address you land on:\n" + url)
        webbrowser.open(url)
        got = parse_qs(urlparse(input("Address: ").strip()).query)
        if got.get("state", [None])[0] != state:
            sys.exit("That address doesn't belong to this sign-in (state mismatch). Try again.")
        return got.get("code", [None])[0] or sys.exit("No code in that address.")

    result = {}

    class Callback(BaseHTTPRequestHandler):
        def do_GET(self):
            qs = parse_qs(urlparse(self.path).query)
            ok = qs.get("state", [None])[0] == state and qs.get("code")
            if ok:
                result["code"] = qs["code"][0]
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            msg = "Connected. You can close this tab and go back to Claude." if ok else "That didn't work. Go back to Claude and try again."
            self.wfile.write(f"<!doctype html><body style='font:18px system-ui;padding:32px'><h2>{msg}</h2>".encode())

        def log_message(self, *a):
            pass

    server = HTTPServer(("localhost", target.port or 80), Callback)
    server.timeout = 1
    print("Opening your browser to sign in. If it doesn't open, visit:\n" + url)
    webbrowser.open(url)
    end = time.time() + timeout
    while "code" not in result and time.time() < end:
        server.handle_request()
    server.server_close()
    return result.get("code") or sys.exit("No sign-in came back within 3 minutes. Run the connect step again.")


def upsert_csv(path, fields, rows, key="date"):
    """Merge rows into a CSV by key (new values win), sorted by key."""
    import csv
    existing = {}
    if path.exists():
        with open(path, newline="", encoding="utf-8") as f:
            for r in csv.DictReader(f):
                existing[r[key]] = r
    for r in rows:
        existing[r[key]] = {**existing.get(r[key], {}), **{k: v for k, v in r.items() if v not in (None, "")}}
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    with open(tmp, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        w.writeheader()
        for k in sorted(existing):
            w.writerow(existing[k])
    os.replace(tmp, path)
    return len(rows)
