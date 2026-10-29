#!/usr/bin/env python3
"""Privacy check: stop personal data and secrets from entering the repository.

    python tools/check_clean.py --staged   # what's about to be committed (the pre-commit hook)
    python tools/check_clean.py --all      # every tracked file

Blocks:
- files that belong in a data folder (profiles, logs, CSVs, tokens, settings, pictures);
- secrets (OAuth tokens and client secrets, API keys);
- links to someone's own phone page (claude.ai/artifact/...);
- paths inside someone's home folder, and email addresses;
- any word in ~/.sylvester-private-words (one per line, never committed): put your name,
  your conditions, your street, anything that must never appear in shared files.
Exit code 1 when anything is found.
"""

import re
import subprocess
import sys
from pathlib import Path

APP = Path(__file__).resolve().parent.parent
PRIVATE_WORDS = Path.home() / ".sylvester-private-words"
MAX_BYTES = 2_000_000
BIG_OK = {"coach/exercises/exercises.json"}  # third-party catalogues

BLOCKED_PATH = re.compile(
    r"(^|/)(health-data|profile|records|sources|imports|secrets|media|phone|logs|plans|data|apple_health_export)/"
    r"|_tokens\.json$|_config\.json$|\.csv$|\.jsonl$|(^|/)export\.(xml|zip)$|lan_passcode|(^|/)settings\.json$"
    r"|\.sylvester\.json$|settings\.local\.json$|\.(jpe?g|png|gif|webp|heic|mp4|mov|svg)$",
    re.I)
TEMPLATE_OK = re.compile(r"^templates/")

CONTENT = [
    ("secret value", re.compile(r'"(access_token|refresh_token|client_secret|api_key)"\s*:\s*"(?!\.\.\.|…|<)[^"]{8,}"')),
    ("GitHub token", re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}")),
    ("Anthropic key", re.compile(r"\bsk-ant-[A-Za-z0-9_-]{10,}")),
    ("AWS key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("someone's phone page link", re.compile(r"claude\.ai/(code/)?artifact/[A-Za-z0-9-]{8,}")),
    ("a home-folder path", re.compile(r"([A-Za-z]:\\\\?[Uu]sers\\\\?|/Users/|/home/)(?!<|\$|%|name\b|you\b|me\b)[A-Za-z0-9._-]{2,}")),
    ("an email address", re.compile(r"\b[A-Za-z0-9._%+-]+@(?!example\.(com|org)\b|anthropic\.com\b|users\.noreply\.github\.com\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")),
]


def files(staged):
    if staged:
        out = subprocess.run(["git", "diff", "--cached", "--name-only", "--diff-filter=ACMR"], cwd=APP, capture_output=True, text=True)
    else:
        out = subprocess.run(["git", "ls-files"], cwd=APP, capture_output=True, text=True)
    return [f for f in out.stdout.splitlines() if f]


def staged_text(path, staged):
    if staged:
        r = subprocess.run(["git", "show", f":{path}"], cwd=APP, capture_output=True)
        return r.stdout
    return (APP / path).read_bytes()


def private_words():
    if not PRIVATE_WORDS.exists():
        return []
    words = [w.strip() for w in PRIVATE_WORDS.read_text(encoding="utf-8").splitlines()]
    return [w for w in words if len(w) >= 3 and not w.startswith("#")]


def main():
    staged = "--all" not in sys.argv
    words = private_words()
    problems = []
    for f in files(staged):
        if f.startswith("tools/check_clean.py"):
            continue  # holds the patterns themselves
        if BLOCKED_PATH.search(f) and not TEMPLATE_OK.match(f):
            problems.append(f"{f}: this kind of file belongs in a data folder, not the app")
            continue
        data = staged_text(f, staged)
        if len(data) > MAX_BYTES and f not in BIG_OK:
            problems.append(f"{f}: {len(data) // 1000} kB is suspiciously large for the app")
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError:
            continue
        for label, rx in CONTENT:
            for m in rx.finditer(text):
                line = text.count("\n", 0, m.start()) + 1
                problems.append(f"{f}:{line}: {label}")
        low = text.lower()
        for w in words:
            i = low.find(w.lower())
            if i >= 0:
                problems.append(f"{f}:{text.count(chr(10), 0, i) + 1}: a word from ~/.sylvester-private-words")
    if problems:
        print("Privacy check failed. Nothing personal goes into the app repository:\n")
        for p in problems:
            print("  -", p)
        print("\nMove personal content to the data folder (see CLAUDE.md), then try again.")
        return 1
    print(f"Privacy check passed ({'staged' if staged else 'all tracked'} files).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
