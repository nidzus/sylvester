"""Which days a default pull asks for, so a computer that was off for a few days misses nothing.

A pull without dates starts at the last day already in its CSV (that day is fetched again, since it may
have been incomplete) and always covers at least the last REFETCH_DAYS days, because a ring or strap can
sync to its own app days later. It never reaches back more than MAX_DAYS on its own: for an older gap,
the note says which range to pull by hand.
"""

import csv
from datetime import date, timedelta
from pathlib import Path

REFETCH_DAYS = 7
MAX_DAYS = 60


def last_date(csv_path, column="date"):
    """The latest date in the CSV, or None if it doesn't exist or holds no rows."""
    p = Path(csv_path)
    if not p.exists():
        return None
    with open(p, newline="", encoding="utf-8") as f:
        days = [r.get(column) or "" for r in csv.DictReader(f)]
    days = [d[:10] for d in days if len(d) >= 10]
    return max(days) if days else None


def window(csv_path, today=None, refetch=REFETCH_DAYS, max_days=MAX_DAYS, column="date"):
    """(start, end, note) for a default pull: ISO dates, both inclusive; note is "" or a line to print."""
    today = today or date.today()
    start = today - timedelta(days=refetch)
    last = last_date(csv_path, column)
    if last:
        start = min(start, date.fromisoformat(last))
    floor = today - timedelta(days=max_days)
    note = ""
    if start < floor:
        note = (f"The last stored day is {last}, more than {max_days} days ago. Pulling from {floor}; "
                f"for the rest, pull the range {last} {floor - timedelta(days=1)}.")
        start = floor
    return start.isoformat(), today.isoformat(), note


def ranges(days):
    """Sorted ISO dates as text, consecutive runs joined: "2026-11-05 to 2026-11-08, 2026-11-12"."""
    out, run = [], []
    for d in sorted(days):
        if run and date.fromisoformat(d) - date.fromisoformat(run[-1]) == timedelta(days=1):
            run.append(d)
        else:
            if run:
                out.append(run)
            run = [d]
    if run:
        out.append(run)
    return ", ".join(r[0] if len(r) == 1 else f"{r[0]} to {r[-1]}" for r in out)


def days_between(start, end):
    """Every ISO date from start to end, inclusive."""
    d, e = date.fromisoformat(start), date.fromisoformat(end)
    out = []
    while d <= e:
        out.append(d.isoformat())
        d += timedelta(days=1)
    return out
