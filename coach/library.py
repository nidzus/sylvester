"""Exercise library: choose, swap and progress exercises for one person.

    python coach/library.py find push_h [purpose]   # what this person can do for a pattern, easiest first
    python coach/library.py swap <id> [stress ...]  # the closest safe alternative (optionally avoiding more stresses)
    python coach/library.py ladder <id>             # the family's progression, marking what's usable
    python coach/library.py person                  # equipment, limits and level cap as the library sees them

The catalogue is coach/library.json: each exercise's pattern, family and level (progressions),
equipment, styles, purposes, and stresses (what it loads). Conditions there are general guidance
with sources; this person's own limits live in <data>/profile/health_profile.json:

    "limits": {"avoid": ["spine_flex_loaded", ...],   # never picked, swapped out if a plan has one
               "caution": ["knee_deep", ...],          # only when the plan names the exercise itself
               "max_level": 3,                         # optional; otherwise from training experience
               "no_household": ["table"]}              # household items they don't have or won't use

Used by coach/rolling.py for rotating slots, today's swaps, bodyweight ladders and the
no-equipment version of a session.
"""

import json
import os
import sys
from functools import lru_cache

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from core import paths  # noqa: E402

LIBRARY = paths.APP / "coach" / "library.json"
LEVEL_BY_EXPERIENCE = {"none": 2, "beginner (< 1 yr)": 2, "returning after a long break": 3,
                       "intermediate (1–3 yrs)": 4, "advanced (3+ yrs)": 5}
# Equipment ids from what the setup wizard and the form record (item "kind", or words in the name).
KIND = {
    "dumbbells": ["dumbbell"], "kettlebells": ["kettlebell"], "barbell": ["barbell"], "rack": ["rack"], "bench": ["bench"],
    "pullup": ["pullup_bar"], "bands": ["band"], "rings": ["rings"], "cable": ["cable"], "box": ["box"],
    "recovery": ["foam_roller"], "dip": ["dip"], "vest": ["vest"], "ball": ["medball"], "landmine": ["landmine"],
}
# Where a swap may look when nothing in the same pattern is safe (closest first).
FALLBACK = {"core_flex": ["core_ext", "core_lat", "core_rot"], "rotation": ["core_rot", "core_lat"],
            "push_v": ["shoulder", "push_h"], "pull_v": ["pull_h"], "power": ["squat", "hinge"],
            "carry": ["core_lat", "core_rot"], "locomotion": ["core_ext"], "conditioning": ["locomotion"]}
GYM_FULL = ["dumbbell", "kettlebell", "barbell", "rack", "bench", "pullup_bar", "cable", "machine", "box", "landmine", "dip",
            "medball", "band", "trap_bar", "ab_wheel", "bike", "rower", "treadmill", "elliptical", "foam_roller"]
GYM_SMALL = ["dumbbell", "bench", "cable", "machine", "treadmill", "bike", "elliptical"]
WORDS = [("trap", "trap_bar"), ("hex", "trap_bar"), ("dumbbell", "dumbbell"), ("kettlebell", "kettlebell"), ("barbell", "barbell"),
         ("rack", "rack"), ("squat stand", "rack"), ("bench", "bench"), ("pull-up", "pullup_bar"), ("pullup", "pullup_bar"),
         ("chin", "pullup_bar"), ("mini band", "mini_band"), ("band", "band"), ("ring", "rings"), ("trx", "rings"),
         ("suspension", "rings"), ("cable", "cable"), ("pulley", "cable"), ("lat pulldown", "cable"), ("landmine", "landmine"),
         ("dip", "dip"), ("box", "box"), ("vest", "vest"), ("medicine", "medball"), ("slam", "medball"), ("sled", "sled"),
         ("ab wheel", "ab_wheel"), ("foam", "foam_roller"), ("rope", "jump_rope"), ("bike", "bike"), ("rower", "rower"),
         ("rowing", "rower"), ("treadmill", "treadmill"), ("walking pad", "treadmill"), ("air bike", "air_bike"),
         ("elliptical", "elliptical"), ("smith", "machine"), ("leg press", "machine"), ("leg extension", "machine")]


@lru_cache(maxsize=1)
def load():
    data = json.loads(LIBRARY.read_text(encoding="utf-8"))
    data["by_id"] = {e["id"]: e for e in data["exercises"]}
    return data


def get(ex_id):
    return load()["by_id"].get(ex_id)


def household(person=None):
    skip = set(((person or {}).get("limits") or {}).get("no_household") or [])
    return {h for h in load()["household"] if h not in skip}


def equipment_owned():
    """Equipment ids from <data>/profile/equipment.json (wizard kinds first, then words in item names)."""
    eq = paths.read_json(paths.PROFILE / "equipment.json", {}) or {}
    have = set()
    for it in eq.get("items") or []:
        kind = it.get("kind")
        if kind == "gym":
            have |= set(GYM_FULL if "Commercial" in (it.get("name") or "") else GYM_SMALL)
        elif kind in KIND:
            have |= set(KIND[kind])
            spec = (it.get("spec") or "").lower()
            if kind == "bands" and "mini" in spec:
                have.add("mini_band")
        text = f"{it.get('name', '')} {it.get('spec', '')}".lower()
        if kind == "cardio" or not kind:
            for word, eid in WORDS:
                if word in text:
                    have.add(eid)
    return have


def person():
    prof = paths.read_json(paths.PROFILE / "health_profile.json", {}) or {}
    lim = prof.get("limits") or {}
    exp = ((prof.get("training_background") or {}).get("experience") or "").strip()
    return {
        "limits": lim,
        "avoid": set(lim.get("avoid") or []),
        "caution": set(lim.get("caution") or []),
        "max_level": int(lim.get("max_level") or LEVEL_BY_EXPERIENCE.get(exp, 3)),
        "equipment": equipment_owned() | household(prof),
        "household": household(prof),
    }


def has_equipment(ex, equipment):
    for req in ex.get("equipment") or []:
        alts = req if isinstance(req, list) else [req]
        if not any(a in equipment for a in alts):
            return False
    return True


def usable(ex, equipment, avoid, max_level=5, caution=()):
    """Can this exercise be picked automatically? (A plan may still name a caution exercise itself.)"""
    s = set(ex.get("stresses") or [])
    return has_equipment(ex, equipment) and not (s & set(avoid)) and not (s & set(caution)) and ex["level"] <= max_level


def candidates(pattern, equipment, avoid, max_level=5, purpose=None, styles=None, caution=(), only=None):
    lib = load()
    out = [e for e in lib["exercises"] if e["pattern"] == pattern and usable(e, equipment, avoid, max_level, caution)]
    if only:
        out = [e for e in out if e["id"] in only]
    if purpose:
        out = [e for e in out if purpose in e["purposes"]] or out
    if styles:
        out = [e for e in out if set(styles) & set(e["styles"])] or out
    return out


def substitute(ex_id, equipment, avoid, max_level=5, caution=(), prefer_level=None):
    """Closest safe alternative: same family first (same level, then easier), then the same pattern
    sharing a purpose, then a related pattern (FALLBACK). Never harder than the exercise it replaces
    or the person's level cap, whichever is higher."""
    ex = get(ex_id)
    if not ex:
        return None
    lvl = prefer_level or ex["level"]
    cap = max(max_level, ex["level"])
    pool = []
    for pattern in [ex["pattern"], *FALLBACK.get(ex["pattern"], [])]:
        pool = [e for e in load()["exercises"] if e["id"] != ex_id and e["pattern"] == pattern
                and usable(e, equipment, avoid, cap, caution)]
        if pool:
            break
    if not pool:
        return None

    def score(e):
        shared = len(set(e["purposes"]) & set(ex["purposes"]))
        return (e["family"] != ex["family"], abs(e["level"] - lvl) + (0.5 if e["level"] > lvl else 0), -shared,
                e.get("unilateral") != ex.get("unilateral"), e.get("picture") is None, e["id"])
    return min(pool, key=score)


def ladder(ex_id):
    ex = get(ex_id)
    return sorted((e for e in load()["exercises"] if e["family"] == ex["family"]), key=lambda e: (e["level"], e["id"])) if ex else []


def step_rung(ex_id, direction, equipment, avoid, max_level=5, caution=()):
    """The next usable exercise one rung harder (+1) or easier (-1) in the same family, or None."""
    ex = get(ex_id)
    if not ex:
        return None
    rungs = [e for e in ladder(ex_id) if e["id"] != ex_id and usable(e, equipment, avoid, max_level, caution)]
    if direction > 0:
        up = [e for e in rungs if e["level"] > ex["level"]]
        new = lambda e: len(set(e["stresses"]) - set(ex["stresses"]))  # prefer the step that loads nothing new
        return min(up, key=lambda e: (e["level"], new(e), e.get("picture") is None, e["id"])) if up else None
    down = [e for e in rungs if e["level"] < ex["level"]]
    return max(down, key=lambda e: (e["level"], e.get("picture") is not None, e["id"])) if down else None


def pick(slot, block, equipment, avoid, max_level=5, caution=()):
    """A rotating slot's exercise for this block of weeks: a different family each block where possible."""
    pool = candidates(slot["pattern"], equipment, avoid, min(max_level, slot.get("max_level", 5)), slot.get("purpose"),
                      slot.get("styles"), caution, slot.get("from"))
    if not pool:
        return None
    families = {}
    for e in sorted(pool, key=lambda e: (e["family"], e["level"])):
        families.setdefault(e["family"], []).append(e)
    # within a family start from the highest rung allowed (the ladder takes it from there)
    choices = sorted((max(fs, key=lambda e: (e["level"], e.get("picture") is not None)) for fs in families.values()),
                     key=lambda e: (e.get("picture") is None, e["id"]))
    if slot.get("from"):
        order = {x: i for i, x in enumerate(slot["from"])}
        choices.sort(key=lambda e: order.get(e["id"], 99))
    return choices[block % len(choices)]


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    a = sys.argv[1:]
    p = person()
    if not a or a[0] == "person":
        print("equipment:", ", ".join(sorted(p["equipment"])))
        print("avoid:", ", ".join(sorted(p["avoid"])) or "-", "| caution:", ", ".join(sorted(p["caution"])) or "-",
              "| max level:", p["max_level"])
    elif a[0] == "find":
        for e in sorted(candidates(a[1], p["equipment"], p["avoid"], p["max_level"], a[2] if len(a) > 2 else None, caution=p["caution"]),
                        key=lambda e: (e["level"], e["id"])):
            print(f"L{e['level']} {e['id']:28} {e['name']}  [{', '.join(e['stresses']) or 'no stresses'}]")
    elif a[0] == "swap":
        s = substitute(a[1], p["equipment"], p["avoid"] | set(a[2:]), p["max_level"], p["caution"])
        print(f"{a[1]} -> {s['id']} ({s['name']})" if s else "no safe alternative with this equipment")
    elif a[0] == "ladder":
        for e in ladder(a[1]):
            ok = usable(e, p["equipment"], p["avoid"], p["max_level"], p["caution"])
            print(f"{'ok' if ok else '--'} L{e['level']} {e['id']:28} {e['name']}")
    else:
        print(__doc__)


if __name__ == "__main__":
    main()
