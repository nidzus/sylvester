"""Exercise library: choose, swap and progress exercises for one person.

    python coach/library.py find push_h [purpose]   # what this person can do for a pattern, best fit first (with scores)
    python coach/library.py swap <id> [stress ...]  # the closest safe alternative (optionally avoiding more stresses)
    python coach/library.py ladder <id>             # the family's progression, marking what's usable
    python coach/library.py person                  # equipment, limits and level cap as the library sees them
    python coach/library.py unadapted               # plan exercises (and rotation options) with no "your way" for this person

The catalogue is coach/library.json: each exercise's pattern, family and level (progressions),
equipment, styles, purposes, and stresses (what it loads). Conditions there are general guidance
with sources; this person's own limits live in <data>/profile/health_profile.json:

    "limits": {"avoid": ["spine_flex_loaded", ...],   # never picked, swapped out if a plan has one
               "caution": ["knee_deep", ...],          # only when the plan names the exercise itself
               "max_level": 3,                         # optional; otherwise from training experience
               "conditions": ["lumbar_disc", ...],     # library.json conditions: their "prefer" lists count in fit()
               "no_household": ["table"],              # household items they don't have or won't use
               "unused": ["rings"]}                    # owned equipment they don't want programmed
    "coaching": {"focus": ["balance", ...],           # purposes the baseline showed need work (the Coach sets them)
                 "emphasis": ["arms", "shoulder"],     # patterns the goal stresses
                 "prefer": [ids], "dislike": [ids]}
    "adaptations": [{"match": {"ids"|"families"|"patterns": [...]}, "how": "Feet up on the bench, back flat",
                     "removes": [stresses this way of doing it takes away], "adds": [...],
                     "needs": [any one of these must be at hand, e.g. "rack"], "why", "source"}]

Choosing is by fit (fit()): the person's goals, baseline focus, program emphasis, the exercises their
conditions favour, the ways of doing things that work for them (adaptations), and level. Equipment never
counts in favour of an exercise: a wall or floor exercise competes on equal terms with a barbell one, and
"household only" is just a filter for the no-equipment version or someone without the gear.

Used by coach/rolling.py for rotating slots, today's swaps, bodyweight ladders and the
no-equipment version of a session.
"""

import json
import os
import re
import sys
from functools import lru_cache

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from core import paths  # noqa: E402

LIBRARY = paths.APP / "coach" / "library.json"
# Goal words (goals.json "type" and "title") -> library purposes. The main active goal counts double, a paused one a little.
GOAL_PURPOSES = [("strength", ["strength"]), ("muscle", ["hypertrophy"]), ("hypertroph", ["hypertrophy"]), ("tone", ["hypertrophy"]),
                 ("mobility", ["mobility"]), ("flexib", ["mobility"]), ("stability", ["balance", "core"]), ("balance", ["balance"]),
                 ("functional", ["athletic", "balance"]), ("endurance", ["endurance"]), ("cardio", ["conditioning"]),
                 ("fat", ["conditioning", "glucose"]), ("weight", ["conditioning", "glucose"]), ("blood pressure", ["bp"]),
                 ("bone", ["bone"]), ("posture", ["posture"]), ("back", ["injury_prevention", "rehab"]), ("injur", ["injury_prevention"]),
                 ("fall", ["balance"]), ("sport", ["athletic", "power"])]
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
WORDS = [("trap bar", "trap_bar"), ("hex bar", "trap_bar"), ("dumbbell", "dumbbell"), ("kettlebell", "kettlebell"), ("barbell", "barbell"),
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
                if re.search(r"\b" + re.escape(word), text):  # word starts only: a heart-rate "strap" is no trap bar
                    have.add(eid)
    return have


def goal_purposes():
    """{purpose: weight} from goals.json: the first active goal 2, other active goals 1, paused ones 0.5."""
    goals = (paths.read_json(paths.PROFILE / "goals.json", {}) or {}).get("goals") or []
    out, first = {}, True
    for g in goals:
        status = (g.get("status") or "active").lower()
        if status in ("done", "dropped"):
            continue
        w = 0.5 if status == "paused" else (2 if first else 1)
        first = first and status == "paused"
        text = f"{g.get('type', '')} {g.get('title', '')}".lower()
        for word, purposes in GOAL_PURPOSES:
            if word in text:
                for x in purposes:
                    out[x] = max(out.get(x, 0), w)
    return out


def person():
    prof = paths.read_json(paths.PROFILE / "health_profile.json", {}) or {}
    lim = prof.get("limits") or {}
    coach = prof.get("coaching") or {}
    exp = ((prof.get("training_background") or {}).get("experience") or "").strip()
    conds = load().get("conditions") or {}
    prefer = set(coach.get("prefer") or [])
    for c in lim.get("conditions") or []:
        prefer |= set((conds.get(c) or {}).get("prefer") or [])
    return {
        "limits": lim,
        "avoid": set(lim.get("avoid") or []),
        "caution": set(lim.get("caution") or []),
        "max_level": int(lim.get("max_level") or LEVEL_BY_EXPERIENCE.get(exp, 3)),
        "equipment": (equipment_owned() - set(lim.get("unused") or [])) | household(prof),
        "household": household(prof),
        "purposes": goal_purposes(),
        "focus": list(coach.get("focus") or []),
        "emphasis": list(coach.get("emphasis") or []),
        "prefer": prefer,
        "dislike": set(coach.get("dislike") or []),
        "adaptations": list(prof.get("adaptations") or []),
    }


def adaptations_for(ex, who=None, equipment=None):
    """The person's own ways of doing this exercise (health_profile.json "adaptations"); one that needs gear
    applies only where that gear is at hand (equipment None: anywhere)."""
    out = []
    for a in (who or {}).get("adaptations") or []:
        if a.get("needs") and equipment is not None and not set(a["needs"]) & set(equipment):
            continue
        m = a.get("match") or {}
        if ex["id"] in (m.get("ids") or []) or ex["family"] in (m.get("families") or []) or ex["pattern"] in (m.get("patterns") or []):
            out.append(a)
    return out


def stresses(ex, who=None, equipment=None):
    """What the exercise loads, the way this person does it with this equipment."""
    s = set(ex.get("stresses") or [])
    for a in adaptations_for(ex, who, equipment):
        s = (s - set(a.get("removes") or [])) | set(a.get("adds") or [])
    return s


def fit(ex, who=None, slot=None):
    """How well an exercise serves this person here; higher is better. Equipment never counts."""
    who, slot = who or {}, slot or {}
    purposes = set(ex.get("purposes") or [])
    score = 3.0 if slot.get("purpose") in purposes else 0.0
    score += sum(w for x, w in (who.get("purposes") or {}).items() if x in purposes)
    score += 1.5 * len(purposes & set(who.get("focus") or []))
    score += 1.0 if ex["pattern"] in (who.get("emphasis") or ()) else 0.0
    score += 2.0 if ex["id"] in (who.get("prefer") or ()) else 0.0
    score -= 6.0 if ex["id"] in (who.get("dislike") or ()) else 0.0
    score += 1.0 if adaptations_for(ex, who) else 0.0  # a way of doing it that's known to work for them
    cap = min(who.get("max_level", 5), slot.get("max_level", 5))
    score -= 0.5 * max(0, cap - ex["level"])  # the highest rung they're ready for progresses best
    score += 0.25 if ex.get("picture") else 0.0
    return round(score, 2)


def has_equipment(ex, equipment):
    for req in ex.get("equipment") or []:
        alts = req if isinstance(req, list) else [req]
        if not any(a in equipment for a in alts):
            return False
    return True


def usable(ex, equipment, avoid, max_level=5, caution=(), who=None):
    """Can this exercise be picked automatically? (A plan may still name a caution exercise itself.)"""
    s = stresses(ex, who, equipment)
    return has_equipment(ex, equipment) and not (s & set(avoid)) and not (s & set(caution)) and ex["level"] <= max_level


def candidates(pattern, equipment, avoid, max_level=5, purpose=None, styles=None, caution=(), only=None, who=None):
    """What this person can do for a pattern, best fit first."""
    lib = load()
    out = [e for e in lib["exercises"] if e["pattern"] == pattern and usable(e, equipment, avoid, max_level, caution, who)]
    if only:
        out = [e for e in out if e["id"] in only]
    if styles:
        out = [e for e in out if set(styles) & set(e["styles"])] or out
    slot = {"purpose": purpose} if purpose else {}
    return sorted(out, key=lambda e: (-fit(e, who, slot), e["level"], e["id"]))


def substitute(ex_id, equipment, avoid, max_level=5, caution=(), prefer_level=None, who=None):
    """Closest safe alternative: same family first, then one-sided for one-sided (a two-leg lift isn't
    replaced by a one-leg one), then nearest level, then best fit; then the same pattern, then a related
    pattern (FALLBACK). Within the family never harder than the exercise it replaces or the person's level cap,
    whichever is higher; from another family never above the person's level cap."""
    ex = get(ex_id)
    if not ex:
        return None
    lvl = prefer_level or min(ex["level"], max_level)  # a barbell lift's level isn't a bodyweight one's
    cap = max(max_level, ex["level"])
    pool = []
    for pattern in [ex["pattern"], *FALLBACK.get(ex["pattern"], [])]:
        pool = [e for e in load()["exercises"] if e["id"] != ex_id and e["pattern"] == pattern
                and usable(e, equipment, avoid, cap if e["family"] == ex["family"] else max_level, caution, who)]
        if pool:
            break
    if not pool:
        return None

    def score(e):
        shared = len(set(e["purposes"]) & set(ex["purposes"]))
        return (e["family"] != ex["family"], e.get("unilateral") != ex.get("unilateral"),
                abs(e["level"] - lvl) + (0.5 if e["level"] > lvl else 0), -shared, -fit(e, who), e.get("picture") is None, e["id"])
    return min(pool, key=score)


def ladder(ex_id):
    ex = get(ex_id)
    return sorted((e for e in load()["exercises"] if e["family"] == ex["family"]), key=lambda e: (e["level"], e["id"])) if ex else []


def step_rung(ex_id, direction, equipment, avoid, max_level=5, caution=(), who=None):
    """The next usable exercise one rung harder (+1) or easier (-1) in the same family, or None. A caution
    stress the current exercise already carries (the plan named it) doesn't block; a new one does."""
    ex = get(ex_id)
    if not ex:
        return None
    caution = set(caution) - stresses(ex, who, equipment)
    rungs = [e for e in ladder(ex_id) if e["id"] != ex_id and usable(e, equipment, avoid, max_level, caution, who)]
    if direction > 0:
        up = [e for e in rungs if e["level"] > ex["level"]]
        new = lambda e: len(stresses(e, who, equipment) - stresses(ex, who, equipment))  # prefer the step that loads nothing new
        return min(up, key=lambda e: (e["level"], new(e), e.get("picture") is None, e["id"])) if up else None
    down = [e for e in rungs if e["level"] < ex["level"]]
    return max(down, key=lambda e: (e["level"], e.get("picture") is not None, e["id"])) if down else None


def pick(slot, block, equipment, avoid, max_level=5, caution=(), who=None):
    """A rotating slot's exercise for this block of weeks: the best fits for this person, taking turns.

    Ranked by fit() (goals, baseline focus, emphasis, what their conditions favour, their adaptations, level;
    never equipment). Each block takes the next of the top choices: at most slot "choices" (default 3), only
    those within slot "margin" (default 2) points of the best, one per family unless the slot lists them in
    "from". Exercises in "from" were chosen by the plan (and its safety review), so a caution stress or the level
    cap doesn't rule them out; avoid always does."""
    named = set(slot.get("from") or [])
    level = min(max_level, slot.get("max_level", 5))
    pool = [e for e in load()["exercises"] if e["pattern"] == slot["pattern"] and (
        usable(e, equipment, avoid, 5, (), who) if e["id"] in named else
        (not named and usable(e, equipment, avoid, level, caution, who)))]
    if slot.get("styles") and not named:
        pool = [e for e in pool if set(slot["styles"]) & set(e["styles"])] or pool
    if not pool:
        return None
    score = {e["id"]: fit(e, who, slot) for e in pool}
    if named:
        choices = pool
    else:
        best = {}
        for e in pool:  # one per family: its best-fitting rung (the ladder takes it from there)
            b = best.get(e["family"])
            if b is None or (score[e["id"]], e["level"]) > (score[b["id"]], b["level"]):
                best[e["family"]] = e
        choices = list(best.values())
    order = {x: i for i, x in enumerate(slot.get("from") or [])}  # a tie goes to the plan's own order
    choices.sort(key=lambda e: (-score[e["id"]], order.get(e["id"], len(order)), e["id"]))
    top = [e for e in choices if score[e["id"]] >= score[choices[0]["id"]] - slot.get("margin", 2)][:slot.get("choices", 3)]
    return top[block % len(top)]


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    a = sys.argv[1:]
    p = person()
    if not a or a[0] == "person":
        print("equipment:", ", ".join(sorted(p["equipment"])))
        print("avoid:", ", ".join(sorted(p["avoid"])) or "-", "| caution:", ", ".join(sorted(p["caution"])) or "-",
              "| max level:", p["max_level"])
        print("goal purposes:", ", ".join(f"{k} {v:g}" for k, v in sorted(p["purposes"].items(), key=lambda x: -x[1])) or "-",
              "| focus:", ", ".join(p["focus"]) or "-", "| emphasis:", ", ".join(p["emphasis"]) or "-")
        print("adaptations:", "; ".join(x.get("how", "") for x in p["adaptations"]) or "-")
    elif a[0] == "find":
        slot = {"purpose": a[2]} if len(a) > 2 else {}
        for e in candidates(a[1], p["equipment"], p["avoid"], p["max_level"], a[2] if len(a) > 2 else None, caution=p["caution"], who=p):
            print(f"fit {fit(e, p, slot):5.2f}  L{e['level']} {e['id']:28} {e['name']}  [{', '.join(sorted(stresses(e, p))) or 'no stresses'}]")
    elif a[0] == "swap":
        s = substitute(a[1], p["equipment"], p["avoid"] | set(a[2:]), p["max_level"], p["caution"], who=p)
        print(f"{a[1]} -> {s['id']} ({s['name']})" if s else "no safe alternative with this equipment")
    elif a[0] == "unadapted":
        # Every exercise the active plan can put in front of them: fixed ones, rotation options, no-equipment stand-ins.
        plan = paths.active_plan_dir()
        ids = []
        for f in sorted((plan / "routines").glob("*.json")) if plan else []:
            for e in (paths.read_json(f) or {}).get("exercises", []):
                if e.get("ex"):
                    ids.append(e["ex"])
                if e.get("anywhere_ex") and e["anywhere_ex"] != "skip":
                    ids.append(e["anywhere_ex"])
                slot = e.get("slot")
                if slot:
                    ids += [x["id"] for x in candidates(slot["pattern"], p["equipment"], p["avoid"], p["max_level"],
                                                        caution=p["caution"], only=slot.get("from"), who=p)]
        missing = [i for i in dict.fromkeys(ids) if get(i) and not adaptations_for(get(i), p)]
        for i in missing:
            print(f"{i:28} {get(i)['name']}")
        if not missing:
            print("Every exercise in the plan has a way of doing it for this person.")
    elif a[0] == "ladder":
        for e in ladder(a[1]):
            ok = usable(e, p["equipment"], p["avoid"], p["max_level"], p["caution"], p)
            print(f"{'ok' if ok else '--'} L{e['level']} {e['id']:28} {e['name']}")
    else:
        print(__doc__)


if __name__ == "__main__":
    main()
