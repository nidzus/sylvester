"""Rolling 14-day plan: the next two weeks, rebuilt from what actually happened.

    python coach/rolling.py            # -> <plan>/schedule.json and schedule.md
    python coach/rolling.py 2026-11-09 # as if today were that date (testing)

The Coach writes the plan once (program.md + routines/ + rolling.json, safety-reviewed).
This script re-lays the next 14 days every time it runs (the daily task and every sync):

- Rotation: routines follow rolling.json "rotation". A missed session is not skipped; it
  moves to the next free day.
- Hard days ease what follows: a session with RPE >= rules.hard_rpe or pain >= rules.pain_stop
  makes the next session easy; two hard sessions in four days add a rest day.
- Recovery and check-ins adjust today: wearable status red -> recovery day, amber -> easy;
  temperature +0.5 °C -> rest; check-in pain >= 6 -> recovery; personal signals apply their
  own levels (see core/signals.py).
- Loads: per exercise, from the last time it was logged. Top of the rep range on every set at
  RPE <= 8 -> one load step up; RPE >= 9.5, missed reps or pain -> hold or one step down.
- Phases: rolling.json "phases" (weeks from "start"); deload weeks cut sets.
- Library (coach/library.json, coach/library.py): an exercise may name a library id ("ex") instead of
  spelling everything out; it then gets its name, picture, cues and stresses from the library.
  * Rotating slots: {"slot": {"pattern": "core_rot", "purpose": "core", "every_weeks": 3}, "sets", "reps"}
    takes turns among the best fits for this person every few weeks ("every_weeks": "phase" = once per phase):
    library.fit() ranks by goals, baseline focus, emphasis, their conditions' preferred exercises, their own
    adaptations and level, never by equipment. Main lifts stay fixed: name them with "ex".
  * Adaptations (health_profile.json "adaptations"): the person's own way of doing an exercise ("feet up on the
    bench, back flat") leads its cues and changes what it's taken to load, for every check above.
  * "anywhere_ex": the plan's own no-equipment stand-in for an exercise ("skip" leaves it out there), used
    instead of an automatic swap; "anywhere_note" adds a line to the no-equipment version only.
    A slot's "reps" may be a dict by unit, e.g. {"reps": "8–12", "s": "20–30", "m": "30"}, since the
    pick can be a hold or a carry.
  * Swaps instead of drops: when a signal or the person's limits rule an exercise out, the closest
    safe alternative from the same pattern stands in (same family first), and the note says so.
  * Bodyweight ladders: an exercise without a load moves one rung up its family (wall -> incline ->
    full push-up) after the top of the rep range at RPE <= progress_rpe, one rung down after pain or
    RPE >= regress_rpe; easy days use one rung easier.
  * No-equipment version: every session also carries "anywhere", rebuilt from household items only
    (wall, floor, chair, stairs, towel, backpack, door frame), for the phone's "No equipment" switch.

Bounds, so automatic changes stay inside what the safety review approved: it never adds an
exercise the plan doesn't contain, never moves more than one load step at a time, never
exceeds the phase's RPE cap, and anything else goes back to the Coach.

Plan folder (<data>/plans/<plan>/):
  program.md      the direction: goal, constraints, phases, gates (the Coach writes it)
  rolling.json    {"start", "weekdays", "rotation", "optional", "rest_day", "recovery_routine",
                   "min_rest_days", "phases": [{"name", "weeks", "rpe_cap", "deload"}], "rules"}
  routines/*.json session templates (format in coach/phone.py); exercises may carry
                  "implement" ("barbell" | "dumbbell" | ... keys of equipment.json load_steps)
                  and "tags" (e.g. "spine_load") that signals can avoid.
  phases may set "sets_max" (e.g. 2 in a first week).
  overrides/YYYY-MM-DD.json  a day the Coach set by hand (a session spec, or {"kind": "rest", "title", "note"});
                  used as written. "routine" names the rotation routine it stands in for.
                  "battery" (a calibration battery id) makes the day that battery's tests on the phone.
"""

import csv
import json
import os
import re
import sys
from datetime import date, datetime, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.dirname(HERE))
from core import paths, signals  # noqa: E402
import catalogue  # noqa: E402
import library  # noqa: E402

DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
HORIZON = 14
RULES = {
    "hard_rpe": 9, "easy_rpe": 7, "pain_stop": 3,
    "easy_day": {"sets_minus": 1, "load_steps_down": 1, "rpe_cap": 7},
    "deload": {"sets_pct": 60},
    "progress_rpe": 8, "regress_rpe": 9.5,
}


def read_csv(path):
    if not os.path.exists(path):
        return []
    with open(path, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def nums(v):
    """'10/10/9' or '10, 9' or '10' -> [10, 10, 9]."""
    return [float(x) for x in re.findall(r"\d+(?:\.\d+)?", str(v or ""))]


def rep_range(reps):
    """'8–12' -> (8, 12); '10–15 / side' -> (10, 15); '12' -> (12, 12); '30 m / side' -> None."""
    s = str(reps or "")
    if re.search(r"\d\s*m\b", s):
        return None
    xs = nums(s.split("/")[0])
    if not xs:
        return None
    return (xs[0], xs[1] if len(xs) > 1 else xs[0])


def step(load, steps, n):
    """Move n steps (+ up, - down) along the allowed loads from the nearest step at or below load."""
    if not steps or load is None:
        return load
    below = [i for i, s in enumerate(steps) if s <= load + 1e-9]
    i = below[-1] if below else 0
    return steps[max(0, min(len(steps) - 1, i + n))]


class Plan:
    def __init__(self, folder):
        self.dir = folder
        self.cfg = paths.read_json(folder / "rolling.json", {}) or {}
        self.rules = {**RULES, **(self.cfg.get("rules") or {})}
        self.routines = {}
        for d in (folder / "routines", paths.PLANS / "routines"):  # plan routines win over shared ones
            for p in sorted(d.glob("*.json")) if d.exists() else []:
                self.routines.setdefault(p.stem, paths.read_json(p))
        self.rotation = [r for r in self.cfg.get("rotation", []) if r in self.routines]
        self.weekdays = [d[:3].lower() for d in self.cfg.get("weekdays", ["mon", "wed", "fri"])]
        self.start = date.fromisoformat(self.cfg["start"]) if self.cfg.get("start") else None

    def phase(self, day):
        if not self.start or day < self.start:
            return {"name": "Before start", "weeks": 0}
        week = (day - self.start).days // 7
        for i, ph in enumerate(self.cfg.get("phases", [])):
            if week < ph.get("weeks", 0):
                return {**ph, "week": week + 1, "index": i}
            week -= ph.get("weeks", 0)
        return {"name": "Plan finished: time for a review", "done": True}

    def by_title(self, title):
        t = (title or "").strip().lower()
        return next((k for k, r in self.routines.items() if r.get("title", "").strip().lower() == t), None)


def history(plan):
    """Logged sessions: {date: [{"routine", "title", "rows"}]} from records/workout_log.csv."""
    out = {}
    for r in read_csv(paths.RECORDS / "workout_log.csv"):
        day = out.setdefault(r["date"], {})
        s = day.setdefault(r["session"], {"routine": plan.by_title(r["session"]), "title": r["session"], "rows": []})
        s["rows"].append(r)
    return {d: list(v.values()) for d, v in out.items()}


def session_strain(rows, rules):
    rpes = [num(r.get("rpe")) for r in rows if num(r.get("rpe")) is not None]
    pains = [num(r.get("pain")) for r in rows if num(r.get("pain")) is not None]
    if (rpes and max(rpes) >= rules["hard_rpe"]) or (pains and max(pains) >= rules["pain_stop"]):
        return "hard"
    if rpes and max(rpes) <= rules["easy_rpe"] and not (pains and max(pains) > 0):
        return "easy"
    return "normal"


def today_state(today, plan):
    """What today's recovery data and check-in say: {"day": None|"easy"|"recovery"|"rest", ...}."""
    st = {"day": None, "reasons": [], "avoid_tags": set(), "add_routines": [], "rpe_cap": None}
    order = {None: 0, "easy": 1, "recovery": 2, "rest": 3}

    def apply(day, reason):
        if order.get(day, 0) > order[st["day"]]:
            st["day"] = day
        st["reasons"].append(reason)

    snap = paths.read_json(paths.RECORDS / "snapshot.json", {}) or {}
    rec = snap.get("recovery") or {}
    fresh = rec.get("latest_date") and (today - date.fromisoformat(rec["latest_date"])).days <= 1
    if fresh:
        if (rec.get("temperature_deviation") or 0) >= 0.5:
            apply("rest", f"body temperature +{rec['temperature_deviation']} °C")
        elif rec.get("status") == "red":
            apply("recovery", "recovery is red")
        elif rec.get("status") == "amber":
            apply("easy", "recovery is amber")

    rows = read_csv(paths.RECORDS / "checkins.csv")
    ci = next((r for r in reversed(rows) if r["date"] in (today.isoformat(), (today - timedelta(days=1)).isoformat())), None)
    if ci:
        pain = num(ci.get("pain"))
        if pain is not None and pain >= 6:
            apply("recovery", f"pain {pain:g}/10 in the check-in")
        elif pain is not None and pain >= 4:
            apply("easy", f"pain {pain:g}/10 in the check-in")
        if num(ci.get("energy")) is not None and num(ci.get("energy")) <= 1:
            apply("easy", "energy 1/5")
        for sig in signals.personal():
            act = signals.level_actions(sig, ci.get(sig["key"]))
            if not act:
                continue
            apply(act.get("day"), act.get("note") or f"{sig['label']} {ci.get(sig['key'])}")
            st["avoid_tags"] |= set(act.get("avoid_tags") or [])
            if act.get("add_routine"):
                st["add_routines"].append(act["add_routine"])
            if act.get("rpe_cap"):
                st["rpe_cap"] = min(st["rpe_cap"] or 10, act["rpe_cap"])
    return st


def last_performance(name, hist, before):
    for d in sorted(hist, reverse=True):
        if d >= before:
            continue
        for s in hist[d]:
            for r in s["rows"]:
                if r["exercise"].strip().lower() == name.strip().lower():
                    return r
    return None


UNIT_REPS = {"reps": "8–12", "s": "20–40", "m": "20–30", "min": "10–20"}


def use_exercise(e, ex, swapped=False, who=None, equipment=None):
    """Fill an exercise entry from a library exercise, or replace it (keeping sets, rest and the plan's intent).
    The person's own way of doing it (an adaptation) leads the cues."""
    e["ex"] = ex["id"]
    if swapped or not e.get("name"):
        e["name"] = ex["name"]
    if swapped or not e.get("lib"):
        e.pop("lib", None)
        if ex.get("picture"):
            e["lib"] = ex["picture"]
    if swapped or not e.get("cues"):
        e.pop("cues", None)
        if ex.get("cues"):
            e["cues"] = list(ex["cues"])
    if swapped:
        for k in ("load_kg", "implement", "note", "instructions"):
            e.pop(k, None)
        if (ex.get("unit") or "reps") != (e.get("unit") or "reps"):
            e["reps"] = UNIT_REPS.get(ex.get("unit") or "reps", e.get("reps"))
        e["tags"] = sorted(library.stresses(ex, who, equipment))
    else:
        e["tags"] = sorted(set(e.get("tags") or []) | library.stresses(ex, who, equipment))
    ways = library.adaptations_for(ex, who, equipment)
    for a in ways:
        cue = "Your way: " + a["how"]
        if a.get("how") and cue not in (e.get("cues") or []):
            e["cues"] = [cue, *(e.get("cues") or [])]
    if ways or ex.get("picture_only"):
        e["instructions"] = False  # the picture source's step-by-step describes another way of doing it
    if ex.get("implement") and not e.get("implement"):
        e["implement"] = ex["implement"]
    if (ex.get("unit") or "reps") != "reps":
        e["unit"] = ex["unit"]
    else:
        e.pop("unit", None)
    return e


def slot_block(plan, slot, day):
    every = slot.get("every_weeks", 3)
    if every == "phase":
        return plan.phase(day).get("index", 0)
    weeks = max(0, (day - plan.start).days // 7) if plan.start else 0
    return weeks // max(1, int(every))


def ladder_now(ex, e, hist, day, rules, cap, who):
    """Where this person is on a bodyweight ladder: the family member logged last, moved one rung
    up or down by how that session went."""
    names = {m["name"].strip().lower(): m for m in library.ladder(ex["id"])}
    names[(e.get("name") or "").strip().lower()] = ex
    cur, last = ex, None
    for d in sorted(hist, reverse=True):
        if d >= day.isoformat():
            continue
        for sess in hist[d]:
            for row in sess["rows"]:
                m = names.get(row["exercise"].strip().lower())
                if m:
                    cur, last = m, row
                    break
            if last:
                break
        if last:
            break
    if not last:
        return cur, ""
    reps, rpe, pain = nums(last.get("reps")), num(last.get("rpe")), num(last.get("pain"))
    rng = rep_range(e.get("reps"))
    move = 0
    if (pain is not None and pain >= rules["pain_stop"]) or (rpe is not None and rpe >= rules["regress_rpe"]):
        move = -1
    elif rng and reps and len(reps) >= max(1, int(num(e.get("sets")) or 1)) and min(reps) >= rng[1] \
            and rpe is not None and rpe <= min(rules["progress_rpe"], cap):  # no RPE logged: hold
        move = +1
    if move:
        # earned by performance, so a rung above the level cap is fine (one at a time)
        nxt = library.step_rung(cur["id"], move, who["equipment"], who["avoid"], max(who["max_level"], cur["level"] + 1),
                                who["caution"], who)
        if nxt:
            return nxt, ("a rung harder: top of the range last time" if move > 0 else "a rung easier: last time was too hard")
    return cur, ""


def plan_session(plan, key, day, intensity, hist, lib, steps, extra, who=None, anywhere=False):
    """One dated session from a routine: loads progressed from the log, adjusted for intensity.
    anywhere=True rebuilds it from household items only (the phone's "No equipment" version)."""
    r = plan.routines[key]
    rules, ph = plan.rules, plan.phase(day)
    who = who or library.person()
    equipment = who["household"] if anywhere else who["equipment"]
    avoid = set(who["avoid"]) | set(extra.get("avoid_tags") or [])
    cap = min(x for x in (ph.get("rpe_cap"), extra.get("rpe_cap"),
                          rules["easy_day"]["rpe_cap"] if intensity == "easy" else None, 10) if x)
    exercises, notes = [], []
    for e in r.get("exercises", []):
        e = dict(e)
        ex = None
        if e.get("slot"):
            slot = e.pop("slot")
            # picked against standing limits only, so a bad day swaps the pick rather than reshuffling the rotation
            ex = library.pick(slot, slot_block(plan, slot, day), equipment, who["avoid"], who["max_level"], who["caution"], who)
            if not ex:
                notes.append(f"Nothing for the {slot.get('pattern', '')} slot fits today.")
                continue
            use_exercise(e, ex, who=who, equipment=equipment)
            unit = ex.get("unit") or "reps"
            if isinstance(e.get("reps"), dict):
                e["reps"] = e["reps"].get(unit) or UNIT_REPS.get(unit)
            elif unit != "reps":
                e["reps"] = UNIT_REPS.get(unit, e.get("reps"))
        elif e.get("ex"):
            ex = library.get(e["ex"])
            if ex:
                use_exercise(e, ex, who=who, equipment=equipment)
        name = e.get("name") or (lib.get(e.get("lib", "")) or {}).get("name") or e.get("lib", "")
        e["name"] = name
        why = rung = ""
        # Bodyweight ladders: move along the family from what the log shows.
        if ex and not e.get("implement") and e.get("ladder", True) and e.get("unit", "reps") == "reps":
            cur, rung = ladder_now(ex, e, hist, day, rules, cap, who)
            if cur["id"] != ex["id"]:
                ex = cur
                use_exercise(e, ex, swapped=True, who=who, equipment=equipment)
            if intensity == "easy":
                easier = library.step_rung(ex["id"], -1, equipment, avoid, who["max_level"], who["caution"], who)
                if easier:
                    ex, rung = easier, "a rung easier today"
                    use_exercise(e, ex, swapped=True, who=who, equipment=equipment)
            name = e["name"]
        stand_in_id, anywhere_note = e.pop("anywhere_ex", ""), e.pop("anywhere_note", "")
        if anywhere and stand_in_id == "skip":
            notes.append(f"Without equipment: {name} is left out.")
            continue
        if anywhere and anywhere_note:
            e["note"] = (e.get("note", "") + " " if e.get("note") else "") + anywhere_note
        stand_in = library.get(stand_in_id or "")
        if anywhere and stand_in and stand_in["id"] != (ex or {}).get("id"):
            notes.append(f"Without equipment: {name} → {stand_in['name']}.")
            ex = stand_in
            use_exercise(e, ex, swapped=True, who=who, equipment=equipment)
            name = e["name"]
        # Ruled out today (a signal's avoid_tags, the person's limits) or impossible without equipment: swap, don't drop.
        blocked = set(e.get("tags") or []) & avoid
        mine = blocked and blocked <= set(who["avoid"])  # the person's standing limits, not just today's check-in
        missing = anywhere and ((ex and not library.has_equipment(ex, equipment)) or (not ex and e.get("implement")))
        if blocked or missing:
            alt = library.substitute(ex["id"], equipment, avoid, who["max_level"], who["caution"], who=who) if ex else None
            if alt:
                notes.append(f"{'Swapped for your limits' if mine else 'Swapped today' if blocked else 'Without equipment'}: {name} → {alt['name']}.")
                same_tool = alt["family"] == ex["family"] and alt.get("implement") and alt.get("implement") == e.get("implement")
                kept = e.get("load_kg") if same_tool else None  # same family, same tool: the weight carries over
                ex = alt
                use_exercise(e, ex, swapped=True, who=who, equipment=equipment)
                if kept is not None:
                    e["load_kg"] = kept
                name = e["name"]
            else:
                notes.append(f"Left out today: {name}.")
                continue
        if anywhere and ex:
            # Kept because a household item can stand in (a backpack for the dumbbells, a chair for the bench): say which,
            # and drop a weight that belonged to the real implement.
            for group in ex.get("equipment") or []:
                if isinstance(group, list) and group and group[0] not in equipment:
                    use = next((g for g in group if g in equipment), None)
                    if use:
                        e["note"] = (e.get("note", "") + " " if e.get("note") else "") + f"Use a {use} for the {group[0]}."
            if e.get("implement") and e["implement"] not in equipment:
                e.pop("implement")
                e.pop("load_kg", None)
        load = num(e.get("load_kg"))
        st = steps.get(e.get("implement", ""), [])
        rng = rep_range(e.get("reps")) if e.get("unit") != "s" else None
        last = last_performance(name, hist, day.isoformat())
        if last and load is None and e.get("implement") and nums(last.get("load_kg")):
            load = max(nums(last.get("load_kg")))  # a swapped-in or rotated exercise picks up where it was last time
        if last and load is not None:
            done_loads = nums(last.get("load_kg"))
            load = max(done_loads) if done_loads else load
            reps, rpe, pain = nums(last.get("reps")), num(last.get("rpe")), num(last.get("pain"))
            want = int(num(e.get("sets")) or 0)
            if pain is not None and pain >= rules["pain_stop"]:
                load, why = step(load, st, -1), f"down a step: pain {pain:g} last time"
            elif rpe is not None and rpe >= rules["regress_rpe"]:
                why = f"same load: RPE {rpe:g} last time"
            elif rng and reps and len(reps) >= max(1, want) and min(reps) >= rng[1] and rpe is None:
                why = "same load: log the RPE so the plan can move it up"
            elif rng and reps and len(reps) >= max(1, want) and min(reps) >= rng[1] and rpe <= min(rules["progress_rpe"], cap):
                load, why = step(load, st, +1), "up a step: top of the range last time"
            elif rng and reps and min(reps) < rng[0]:
                why = "same load: reps below the range last time"
        if intensity == "easy":
            e["sets"] = max(1, int(num(e.get("sets")) or 1) - rules["easy_day"]["sets_minus"])
            if load is not None and st:
                load = step(load, st, -rules["easy_day"]["load_steps_down"])
        if intensity == "deload":
            e["sets"] = max(1, round((num(e.get("sets")) or 1) * rules["deload"]["sets_pct"] / 100))
        if ph.get("sets_max") and num(e.get("sets")):
            e["sets"] = min(int(num(e["sets"])), int(ph["sets_max"]))
        if load is not None:
            e["load_kg"] = int(load) if float(load).is_integer() else round(load, 1)
        elif e.get("implement"):  # a rotated-in or newly reached loaded exercise with nothing logged yet
            why = why or "not set yet: pick one that leaves 2–3 reps (or a few metres) in reserve, and log it"
        if why:
            e["note"] = (e.get("note", "") + " " if e.get("note") else "") + f"Load {why}."
        if rung:
            e["note"] = (e.get("note", "") + " " if e.get("note") else "") + f"{rung[0].upper()}{rung[1:]}."
        exercises.append(e)
    warmup = list(r.get("warmup", []))
    for add in extra.get("add_routines", []):
        if add in plan.routines:
            warmup.insert(0, f"First: your {plan.routines[add]['title']} routine")
    note = r.get("coach_note", "")
    lead = {"easy": f"Easier today (RPE ≤ {cap:g}, one set fewer, lighter).", "deload": "Deload week: fewer sets, same technique."}.get(intensity)
    if lead:
        note = lead + (" " + note if note else "")
    if notes:
        note = " ".join(notes) + (" " + note if note else "")
    if anywhere:
        note = "No-equipment version. " + note
    return {"id": f"day-{day.isoformat()}", "routine": key, "title": r["title"], "date": day.isoformat(),
            "intensity": intensity, "rpe_cap": cap, "focus": r.get("focus", ""), "duration": r.get("duration", ""),
            "coach_note": note, "warmup": warmup, "exercises": exercises}


def build(today=None):
    today = today or date.today()
    folder = paths.active_plan_dir()
    if not folder:
        raise SystemExit("No active plan yet: the Coach writes one with /coach plan.")
    plan = Plan(folder)
    if not plan.rotation:
        raise SystemExit(f"{folder / 'rolling.json'}: 'rotation' names no routine in routines/.")
    rules, hist, steps = plan.rules, history(plan), catalogue.load_steps()
    import exercise_lib
    lib = exercise_lib.load()
    who = library.person()

    def variants(key, day, intensity, extra):
        """A session plus its easier and no-equipment versions, for the phone to switch between."""
        sess = plan_session(plan, key, day, intensity, hist, lib, steps, extra, who)
        keep = ("rpe_cap", "coach_note", "exercises")
        if intensity == "normal":  # the phone switches to this if the morning check-in says so
            easy = plan_session(plan, key, day, "easy", hist, lib, steps, extra, who)
            sess["easy"] = {k: easy[k] for k in keep}
            easy_any = plan_session(plan, key, day, "easy", hist, lib, steps, extra, who, anywhere=True)
            if easy_any["exercises"] != easy["exercises"]:
                sess["easy"]["anywhere"] = {k: easy_any[k] for k in keep}
        anyw = plan_session(plan, key, day, intensity, hist, lib, steps, extra, who, anywhere=True)
        if anyw["exercises"] != sess["exercises"]:
            sess["anywhere"] = {k: anyw[k] for k in keep}
        return sess

    # Where the rotation stands, and the last main session (logged).
    main_dates = sorted(d for d, ss in hist.items() if any(s["routine"] in plan.rotation for s in ss) and d <= today.isoformat())
    nxt = 0
    if main_dates:
        last = [s for s in hist[main_dates[-1]] if s["routine"] in plan.rotation][-1]
        nxt = (plan.rotation.index(last["routine"]) + 1) % len(plan.rotation)
    last_main = date.fromisoformat(main_dates[-1]) if main_dates else None

    recent = [(d, session_strain([r for s in hist[d] for r in s["rows"]], rules))
              for d in main_dates if date.fromisoformat(d) >= today - timedelta(days=7)]
    hard = [d for d, k in recent if k == "hard"]
    carry_easy = bool(recent and recent[-1][1] == "hard") or len(hard) >= 2
    extra_rest = len([d for d in hard if date.fromisoformat(d) >= today - timedelta(days=4)]) >= 2
    easy_streak = len(recent) >= 2 and all(k == "easy" for _, k in recent[-2:])

    now = today_state(today, plan)
    gap = int(plan.cfg.get("min_rest_days", 1))
    opt = plan.cfg.get("optional") or {}
    days, owed = [], False
    for k in (1, 2):  # a training day in the last two days that wasn't done is still owed
        d = today - timedelta(days=k)
        if DAYS[d.weekday()] in plan.weekdays and (not plan.start or d >= plan.start) and (last_main is None or last_main < d):
            owed = True
    for i in range(HORIZON):
        day = today + timedelta(days=i)
        wd = DAYS[day.weekday()]
        ph = plan.phase(day)
        entry = {"date": day.isoformat(), "weekday": wd, "phase": ph.get("name"), "reasons": []}
        logged = hist.get(day.isoformat()) if i == 0 else None
        if logged:
            entry.update(kind="done", title=" + ".join(s["title"] for s in logged))
            days.append(entry)
            if any(s["routine"] in plan.rotation for s in logged):
                last_main = day
            continue
        if ph.get("done"):
            entry.update(kind="review", title="Plan finished: run /coach review")
            days.append(entry)
            continue
        override = paths.read_json(folder / "overrides" / f"{day.isoformat()}.json")
        if override:  # the Coach fixed this day by hand: use it as written
            kind = override.get("kind", "session")
            entry.update(kind=kind, title=override.get("title", ""), note=override.get("note", ""),
                         reasons=["set by the Coach"], intensity=override.get("intensity", "normal"))
            if kind in ("session", "optional"):
                entry["session"] = {**override, "id": f"day-{day.isoformat()}", "date": day.isoformat(),
                                    "intensity": entry["intensity"]}
            if override.get("routine") in plan.rotation:
                nxt, last_main, owed = (plan.rotation.index(override["routine"]) + 1) % len(plan.rotation), day, False
            days.append(entry)
            continue
        rest_needed = gap + (1 if extra_rest and i <= 2 else 0)
        free = last_main is None or (day - last_main).days > rest_needed
        want = wd in plan.weekdays or owed
        blocked = i == 0 and now["day"] in ("recovery", "rest")
        if free and want and not blocked and (not plan.start or day >= plan.start):
            key = plan.rotation[nxt]
            intensity = "deload" if ph.get("deload") else "normal"
            if i == 0 and now["day"] == "easy":
                intensity, entry["reasons"] = "easy", now["reasons"]
                carry_easy = False  # one easy session also absorbs a hard last session
            elif carry_easy and intensity == "normal":
                intensity = "easy"
                entry["reasons"].append("the last sessions were hard" if len(hard) >= 2 else "last session was hard")
                carry_easy = False
            elif easy_streak and intensity == "normal":
                entry["reasons"].append("the last two sessions were easy: go for the top of the ranges")
                easy_streak = False
            sess = variants(key, day, intensity, now if i == 0 else {})
            entry.update(kind="session", intensity=intensity, title=plan.routines[key]["title"], session=sess)
            nxt, last_main, owed = (nxt + 1) % len(plan.rotation), day, False
        else:
            if wd in plan.weekdays and (blocked or not free) and (not plan.start or day >= plan.start):
                owed = True  # the session moves to the next free day instead of being skipped
            if i == 0 and now["day"] in ("recovery", "rest"):
                rr = plan.cfg.get("recovery_routine")
                entry.update(kind=now["day"], title="Rest" if now["day"] == "rest" else "Recovery day",
                             reasons=now["reasons"],
                             note=(f"Easy walk and your {plan.routines[rr]['title']} routine." if rr in plan.routines
                                   else "Easy walk, mobility, or rest."))
            elif opt.get("routine") in plan.routines and wd in [d[:3].lower() for d in opt.get("weekdays", [])] \
                    and (last_main is None or day != last_main):
                key = opt["routine"]
                entry.update(kind="optional", intensity="normal", title=plan.routines[key]["title"],
                             session=variants(key, day, "normal", now if i == 0 else {}))
            else:
                rd = plan.cfg.get("rest_day") or {}
                entry.update(kind="rest", title=rd.get("title", "Rest or easy walk"), note=rd.get("note", ""))
        days.append(entry)

    out = {"generated": datetime.now().isoformat(timespec="seconds"), "plan": folder.name,
           "today": {"date": today.isoformat(), "adjust": now["day"], "reasons": now["reasons"]},
           "phase": plan.phase(today), "days": days}
    paths.write_json(folder / "schedule.json", out)
    (folder / "schedule.md").write_text(to_markdown(out), encoding="utf-8")
    return out


def to_markdown(s):
    L = [f"# Next 14 days — {s['plan']} (built {s['generated'][:16].replace('T', ' ')})", ""]
    ph = s.get("phase") or {}
    if ph.get("name"):
        L.append(f"Phase: **{ph['name']}**" + (f", week {ph['week']}" if ph.get("week") else "") + "\n")
    if s["today"]["adjust"]:
        L.append(f"Today is adjusted ({s['today']['adjust']}): " + "; ".join(s["today"]["reasons"]) + "\n")
    L += ["| Date | Day | What | Intensity | Why |", "|---|---|---|---|---|"]
    for d in s["days"]:
        L.append(f"| {d['date']} | {d['weekday'].title()} | {d.get('title', '')} | {d.get('intensity', '')} | {'; '.join(d.get('reasons') or [])} |")
    for d in s["days"]:
        x = d.get("session")
        if not x:
            continue
        L += ["", f"## {d['date']} · {x['title']} ({x['intensity']})", ""]
        if x.get("coach_note"):
            L += [x["coach_note"], ""]
        if x.get("battery"):
            L += [f"Calibration battery `{x['battery']}`: the tests are on the phone page.", ""]
            continue
        L += ["| Exercise | Sets × reps | Load | Note |", "|---|---|---|---|"]
        for e in x["exercises"]:
            L.append(f"| {e['name']} | {e.get('sets', '')} × {e.get('reps', '')}{' s' if e.get('unit') == 's' else ''} | "
                     f"{str(e['load_kg']) + ' kg' if e.get('load_kg') else ''} | {e.get('note', '')} |")
    return "\n".join(L) + "\n"


if __name__ == "__main__":
    t = date.fromisoformat(sys.argv[1]) if len(sys.argv) > 1 else None
    s = build(t)
    sys.stdout.reconfigure(encoding="utf-8")
    print(to_markdown(s).split("\n## ")[0])
