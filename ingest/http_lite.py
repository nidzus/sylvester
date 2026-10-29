"""The few parts of `requests` the Oura and Polar pulls use, on the standard library only, so a fresh
Mac Python needs no `pip install`.

    import http_lite as requests
    r = requests.get(url, headers=..., params=..., timeout=30)
    r.status_code, r.json(), r.text, r.raise_for_status()

post() and put() also take data= (a form), json= and auth=(user, password).
"""

import base64
import json as _json
import ssl
import sys
import urllib.error
import urllib.request
from urllib.parse import urlencode

UA = "Sylvester/1 (personal training coach)"


class HTTPError(Exception):
    def __init__(self, msg, response=None):
        super().__init__(msg)
        self.response = response


class Response:
    def __init__(self, status, content, url, headers):
        self.status_code, self.content, self.url, self.headers = status, content, url, headers

    @property
    def ok(self):
        return self.status_code < 400

    @property
    def text(self):
        return self.content.decode("utf-8", "replace")

    def json(self):
        return _json.loads(self.content or b"null")

    def raise_for_status(self):
        if not self.ok:
            raise HTTPError(f"{self.status_code} error for {self.url.split('?')[0]}", self)


def request(method, url, params=None, data=None, json=None, headers=None, auth=None, timeout=30):
    if params:
        params = {k: v for k, v in params.items() if v is not None}
        url += ("&" if "?" in url else "?") + urlencode(params)
    h = {"User-Agent": UA, **(headers or {})}
    body = None
    if json is not None:
        body = _json.dumps(json).encode()
        h.setdefault("Content-Type", "application/json")
    elif data is not None:
        body = urlencode(data).encode()
        h.setdefault("Content-Type", "application/x-www-form-urlencoded")
    elif method in ("POST", "PUT"):
        body = b""  # an empty body still sends Content-Length: 0, as some APIs require
    if auth:
        h["Authorization"] = "Basic " + base64.b64encode(f"{auth[0]}:{auth[1]}".encode()).decode()
    req = urllib.request.Request(url, data=body, headers=h, method=method)
    try:
        with open_url(req, timeout) as r:
            return Response(r.status, r.read(), url, dict(r.headers))
    except urllib.error.HTTPError as e:
        return Response(e.code, e.read() or b"", url, dict(e.headers or {}))


def open_url(req, timeout):
    """urlopen, with a clear fix for the python.org Mac installer, which ships without certificates."""
    try:
        return urllib.request.urlopen(req, timeout=timeout)
    except urllib.error.URLError as e:
        if isinstance(e.reason, ssl.SSLCertVerificationError):
            sys.exit(CERT_FIX)
        raise


CERT_FIX = ("This Python can't verify HTTPS certificates. On a Mac with Python from python.org, open "
            "Applications > Python 3.x and double-click 'Install Certificates.command', then try again.")


def get(url, **kw):
    return request("GET", url, **kw)


def post(url, **kw):
    return request("POST", url, **kw)


def put(url, **kw):
    return request("PUT", url, **kw)
