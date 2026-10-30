"""Daily check-in scales: the common ones, plus each person's own warning signals.

A personal signal lives in profile/health_profile.json under "signals", for example a nerve
symptom, a joint that flares, or a headache. The check-in forms show it as a scale, the
snapshot reports it, and the rolling plan reacts to it through "levels":

    {"key": "knee_ache", "label": "Right-knee ache", "lo": 0, "hi": 3,
     "hint": "0 none · 1 usual · 2 more than usual · 3 strong",
     "help": "Shown under the scale on the phone.",
     "levels": {"2": {"day": "easy", "avoid_tags": ["knee_dominant"], "add_routine": "knee-care",
                      "rpe_cap": 6, "note": "Knee-friendly day."},
                "3": {"day": "recovery", "note": "Easy walking and the knee routine only."}},
     "stop": "When to stop and see a professional (shown on the phone on a recovery day this signal causes)."}

Level actions (all optional): day "easy" | "recovery" | "rest"; avoid_tags (drop exercises
carrying any of these tags); add_routine (a routine file name in the plan's routines/);
rpe_cap; note. The highest level reached applies.
"""

from core import paths

BASE = [
    {"key": "mood", "label": "Mood", "lo": 1, "hi": 5, "hint": "1 low · 5 great"},
    {"key": "energy", "label": "Energy", "lo": 1, "hi": 5, "hint": "1 drained · 5 full"},
    {"key": "stress", "label": "Stress", "lo": 1, "hi": 5, "hint": "1 calm · 5 overloaded"},
    {"key": "motivation", "label": "Motivation to train", "lo": 1, "hi": 5, "hint": "1 none · 5 eager"},
    {"key": "soreness", "label": "Muscle soreness", "lo": 1, "hi": 5, "hint": "1 none · 5 very sore"},
    {"key": "pain", "label": "Pain", "lo": 0, "hi": 10, "hint": "0 none · 10 worst"},
]
BASE_KEYS = [s["key"] for s in BASE]


def personal():
    prof = paths.read_json(paths.PROFILE / "health_profile.json", {}) or {}
    out = []
    for s in prof.get("signals") or []:
        if s.get("key") and s["key"] not in BASE_KEYS and s.get("label"):
            out.append({"lo": 0, "hi": 3, "hint": "", **s})
    return out


def checkin_fields():
    return ["date", *BASE_KEYS, "pain_where", *[s["key"] for s in personal()], "bp", "notes"]


def for_forms():
    """What the phone page and the local form need: no `levels` or `stop` text."""
    keep = ("key", "label", "lo", "hi", "hint", "help")
    return [{k: s[k] for k in keep if k in s} for s in personal()]


def level_actions(signal, value):
    """The action dict for the highest level at or below value, or None."""
    try:
        v = float(value)
    except (TypeError, ValueError):
        return None
    best = None
    for lvl, action in (signal.get("levels") or {}).items():
        try:
            if v >= float(lvl) and (best is None or float(lvl) > best[0]):
                best = (float(lvl), action)
        except ValueError:
            continue
    return best[1] if best else None
