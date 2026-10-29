"""The exercise library and the rolling 14-day plan."""

import unittest
from datetime import date

from tests import remove, write

import library
import rolling

FRIDAY = date(2026, 11, 6)  # the third session: A again, after A on Monday and B on Wednesday


def first_session(today, routine=None):
    for d in rolling.build(today)["days"]:
        s = d.get("session")
        if s and (routine is None or s["routine"] == routine):
            return s
    raise AssertionError("no session in the next 14 days")


def by_ex(session):
    return {e.get("ex"): e for e in session["exercises"]}


class Library(unittest.TestCase):
    def test_every_entry_is_complete(self):
        lib = library.load()
        patterns = set(lib["patterns"])
        stresses = set(lib["stresses"])
        for ex in lib["exercises"]:
            with self.subTest(ex["id"]):
                self.assertIn(ex["pattern"], patterns)
                self.assertTrue(1 <= ex["level"] <= 5)
                self.assertTrue(ex["purposes"])
                self.assertLessEqual(set(ex["stresses"]), stresses)
                self.assertIn(ex.get("unit") or "reps", ("reps", "s", "m", "min"))
        for name, c in lib["conditions"].items():
            with self.subTest(condition=name):
                self.assertLessEqual(set(c.get("avoid", [])) | set(c.get("caution", [])), stresses)

    def test_ids_are_unique_and_mixes_name_real_patterns(self):
        lib = library.load()
        ids = [e["id"] for e in lib["exercises"]]
        self.assertEqual(len(ids), len(set(ids)))
        for mix in lib["mixes"]:
            for slot in mix["slots"]:
                with self.subTest(mix=mix["id"]):
                    self.assertIn(slot["pattern"], lib["patterns"])

    def test_substitute_respects_limits(self):
        who = library.person()
        alt = library.substitute("crunch", who["equipment"], set(who["avoid"]), who["max_level"], who["caution"])
        self.assertIsNotNone(alt)
        self.assertFalse(set(alt["stresses"]) & set(who["avoid"]))

    def test_household_only_needs_no_gear(self):
        who = library.person()
        for pattern in ("squat", "push_h", "pull_h", "hinge"):
            got = library.candidates(pattern, who["household"], set(), 5)
            self.assertTrue(got, pattern)
            for ex in got:
                self.assertTrue(library.has_equipment(ex, who["household"]), ex["id"])

    def test_slots_rotate_by_block(self):
        who = library.person()
        slot = {"pattern": "core_rot", "purpose": "core"}
        picks = {library.pick(slot, b, who["equipment"], who["avoid"], who["max_level"], who["caution"])["family"] for b in range(3)}
        self.assertGreater(len(picks), 1)


class Plan(unittest.TestCase):
    def tearDown(self):
        remove("records/checkins.csv")
        remove("records/snapshot.json")

    def test_load_goes_up_after_top_of_range(self):
        squat = by_ex(first_session(FRIDAY))["goblet_squat"]
        self.assertEqual(squat["load_kg"], 15)

    def test_bodyweight_climbs_a_rung_without_new_stresses(self):
        s = by_ex(first_session(FRIDAY))
        self.assertNotIn("push_up", s)
        up = next(e for k, e in s.items() if k and k != "push_up" and library.get(k)["family"] == library.get("push_up")["family"])
        self.assertEqual(library.get(up["ex"])["level"], library.get("push_up")["level"] + 1)
        self.assertLessEqual(set(library.get(up["ex"])["stresses"]), set(library.get("push_up")["stresses"]))

    def test_limits_swap_instead_of_drop(self):
        s = first_session(FRIDAY)
        self.assertNotIn("crunch", by_ex(s))
        self.assertEqual(len(s["exercises"]), 6)
        self.assertIn("Swapped for your limits", s["coach_note"])

    def test_slot_changes_after_three_weeks(self):
        early = by_ex(first_session(FRIDAY, "a"))
        later = by_ex(first_session(date(2026, 11, 23), "a"))
        core = lambda s: next(k for k in s if k and library.get(k)["pattern"] == "core_rot")  # noqa: E731
        self.assertNotEqual(library.get(core(early))["family"], library.get(core(later))["family"])

    def test_signal_day_is_easy_and_swaps_keep_the_weight(self):
        write("records/checkins.csv", "date,mood,energy,stress,pain,knee\n2026-11-06,3,3,2,1,2\n")
        s = first_session(FRIDAY)
        self.assertEqual(s["intensity"], "easy")
        squat = s["exercises"][0]
        self.assertNotEqual(squat["ex"], "goblet_squat")
        self.assertFalse(set(squat["tags"]) & {"knee_deep", "kneeling"})
        self.assertEqual(library.get(squat["ex"])["family"], library.get("goblet_squat")["family"])
        self.assertIsNotNone(squat.get("load_kg"))

    def test_no_equipment_version_uses_household_items_only(self):
        s = first_session(FRIDAY)
        house = library.person()["household"]
        for e in s["anywhere"]["exercises"]:
            with self.subTest(e["name"]):
                self.assertTrue(library.has_equipment(library.get(e["ex"]), house))
                self.assertNotIn("load_kg", e)
                self.assertNotIn("implement", e)

    def test_red_recovery_turns_the_day_into_recovery(self):
        write("records/snapshot.json", {"recovery": {"latest_date": "2026-11-06", "status": "red"}})
        days = rolling.build(FRIDAY)["days"]
        self.assertTrue(any("recovery is red" in "; ".join(d.get("reasons") or []) for d in days if d["date"] == "2026-11-06"))

    def test_plain_routines_still_build_and_progress_by_name(self):
        plan = rolling.Plan(rolling.paths.active_plan_dir())
        s = rolling.plan_session(plan, "c", FRIDAY, "normal", rolling.history(plan), {}, rolling.catalogue.load_steps(), {"avoid_tags": set()})
        self.assertEqual(s["exercises"][0]["name"], "Goblet squat")
        self.assertEqual(s["exercises"][0]["load_kg"], 15)  # the log has Goblet squat 3 x 12 at 12.5 kg, RPE 7


if __name__ == "__main__":
    unittest.main()
