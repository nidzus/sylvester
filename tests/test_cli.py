"""sylvester.py: the data-folder version and the next-step line Claude Code sees at session start."""

import json
import unittest

from tests import DATA, write

import sylvester
from core import paths


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
        self.assertIn("/setup", self.onboarding(wizard_completed=True))
        self.assertIn("ready", self.onboarding(wizard_completed=True, completed=True))


if __name__ == "__main__":
    unittest.main()
