"""sylvester.py: the data-folder version and the next-step line Claude Code sees at session start."""

import json
import unittest

from tests import DATA, write

import sylvester
from core import paths


class LinkSettings(unittest.TestCase):
    HOOK_OLD = '"/py/python.exe" "/old/app/sylvester.py" next'
    HOOK_NEW = '"/py/python.exe" "/new/app/sylvester.py" next'

    def test_first_link_adds_access_and_the_hook(self):
        cfg = sylvester.link_settings({}, "/home/x/health-data", None, self.HOOK_NEW)
        self.assertEqual(cfg["permissions"]["additionalDirectories"], ["/home/x/health-data"])
        self.assertEqual(cfg["hooks"]["SessionStart"][0]["hooks"][0]["command"], self.HOOK_NEW)

    def test_a_move_replaces_the_old_folder_and_hook(self):
        cfg = {"permissions": {"additionalDirectories": ["/old/data", "/elsewhere"], "allow": ["Bash(git status)"]},
               "hooks": {"SessionStart": [{"hooks": [{"type": "command", "command": self.HOOK_OLD, "timeout": 20}]}]}}
        cfg = sylvester.link_settings(cfg, "/new/data", "/old/data", self.HOOK_NEW)
        self.assertEqual(cfg["permissions"]["additionalDirectories"], ["/elsewhere", "/new/data"])  # others the person added stay
        self.assertEqual(cfg["permissions"]["allow"], ["Bash(git status)"])
        hooks = [h["command"] for s in cfg["hooks"]["SessionStart"] for h in s["hooks"]]
        self.assertEqual(hooks, [self.HOOK_NEW])

    def test_relinking_the_same_folder_changes_nothing(self):
        cfg = sylvester.link_settings({}, "/d", None, self.HOOK_NEW)
        again = sylvester.link_settings(json.loads(json.dumps(cfg)), "/d", "/d", self.HOOK_NEW)
        self.assertEqual(again, cfg)


class Schema(unittest.TestCase):
    def tearDown(self):
        s = paths.settings()
        s["schema"] = paths.SCHEMA
        paths.save_settings(s)

    def test_old_folders_are_upgraded(self):
        s = paths.settings()
        s["schema"] = 0
        paths.save_settings(s)
        self.assertEqual(sylvester.migrate(quiet=True), (0, paths.SCHEMA))
        self.assertEqual(json.loads((DATA / "settings.json").read_text())["schema"], paths.SCHEMA)

    def test_a_newer_folder_asks_for_an_app_update(self):
        s = paths.settings()
        s["schema"] = paths.SCHEMA + 1
        paths.save_settings(s)
        with self.assertRaises(SystemExit) as e:
            sylvester.migrate()
        self.assertIn("git", str(e.exception.code))


class NextStep(unittest.TestCase):
    def setUp(self):
        self.profile = (DATA / "profile" / "health_profile.json").read_text(encoding="utf-8")

    def tearDown(self):
        (DATA / "profile" / "health_profile.json").write_text(self.profile, encoding="utf-8")

    def onboarding(self, **flags):
        prof = json.loads(self.profile)
        prof["onboarding"] = flags
        write("profile/health_profile.json", prof)
        return sylvester.next_step()

    def test_walks_through_setup_in_order(self):
        self.assertIn("setup wizard", self.onboarding())
        self.assertIn("/sylvester:setup", self.onboarding(wizard_completed=True))
        self.assertIn("ready", self.onboarding(wizard_completed=True, completed=True))


if __name__ == "__main__":
    unittest.main()


class Export(unittest.TestCase):
    def test_the_app_export_holds_the_plan_and_logs_but_no_secrets(self):
        write("secrets/oura_tokens.json", {"access_token": "<never-exported-token>"})
        write("records/clinical_summary.md", "# never exported\n")
        out = DATA / "export-test.json"
        sylvester.export_app(out)
        doc = json.loads(out.read_text(encoding="utf-8"))
        out.unlink()
        self.assertEqual((doc["format"], doc["version"], doc["source"]), ("sylvester-export", 1, "desktop"))
        self.assertEqual(doc["plan"]["name"], "test")
        self.assertIn("a", doc["plan"]["routines"])
        self.assertEqual(doc["plan"]["rolling"]["rotation"], ["a", "b"])
        self.assertTrue(any(r["exercise"] == "Goblet squat" for r in doc["workouts"]))
        self.assertIn("limits", doc["profile"]["health_profile"])
        text = json.dumps(doc)
        self.assertNotIn("never-exported-token", text)
        self.assertNotIn("never exported", text)
