#!/usr/bin/env python3
"""Tests for the Aeon Store. No real network, no real installs."""

import importlib.util
import json
import os
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
STORE_PY = os.path.join(HERE, "..", "aeon-store.py")
UPDATER_DIR = os.path.join(HERE, "..", "..", "updater")


def load_store():
    # aeon-store.py inserts its own dir on sys.path and imports aeon_github;
    # make sure the import resolves to the repo copy.
    import sys
    for p in (os.path.join(HERE, ".."), UPDATER_DIR):
        if p not in sys.path:
            sys.path.insert(0, p)
    spec = importlib.util.spec_from_file_location("aeon_store", STORE_PY)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


st = load_store()

BANNED_WORDS = ("terminal", "kernel", "partition", "repository", "daemon",
                "ssid", "utc", "sudo", "root", "mount", "package",
                "dependency", "bootloader")


class ManifestTests(unittest.TestCase):
    def test_find_manifest_env_override(self):
        with tempfile.NamedTemporaryFile("w", suffix=".json",
                                         delete=False) as f:
            json.dump({"github_owner": "x", "components": []}, f)
            path = f.name
        try:
            os.environ["BERK_MANIFEST"] = path
            self.assertEqual(st.find_store_manifest(), path)
        finally:
            del os.environ["BERK_MANIFEST"]
            os.unlink(path)

    def test_find_manifest_bundled_fallback(self):
        # With no env override and (almost certainly) no system copy, the
        # bundled apps.json beside aeon-store.py must be returned.
        os.environ.pop("BERK_MANIFEST", None)
        got = st.find_store_manifest()
        self.assertTrue(got.endswith("apps.json"))
        data = json.load(open(got, encoding="utf-8"))
        self.assertTrue(data["github_owner"])

    def test_catalog_apps_all_have_blurbs(self):
        data = json.load(open(st.find_store_manifest(), encoding="utf-8"))
        apps = [c for c in data["components"] if c.get("type") == "app"]
        self.assertGreaterEqual(len(apps), 6)
        for c in apps:
            self.assertTrue(c.get("menu_name"), c["id"])
            self.assertTrue(c.get("blurb"), c["id"])
            # blurbs are plain words, not jargon
            low = c["blurb"].lower()
            for banned in BANNED_WORDS:
                self.assertNotIn(banned, low)

    def test_system_component_not_listed_as_app(self):
        data = json.load(open(st.find_store_manifest(), encoding="utf-8"))
        ids = [c["id"] for c in data["components"]]
        self.assertIn("berk-system", ids)  # catalog has it...
        # ...but the store UI filters to type == "app" (checked in code by
        # _load_all; here we assert the catalog marks it non-app)
        by_id = {c["id"]: c for c in data["components"]}
        self.assertNotEqual(by_id["berk-system"].get("type"), "app")


class LaunchTests(unittest.TestCase):
    def test_launch_command_parses_exec(self):
        d = tempfile.mkdtemp()
        with open(os.path.join(d, "berk-music.desktop"), "w") as f:
            f.write("[Desktop Entry]\nName=Music\n"
                    "Exec=/opt/aeonradio/run.sh\n")
        argv = st.launch_command_for({"id": "music"}, applications_dir=d)
        self.assertEqual(argv, ["/opt/aeonradio/run.sh"])

    def test_launch_command_strips_field_codes(self):
        d = tempfile.mkdtemp()
        with open(os.path.join(d, "berk-x.desktop"), "w") as f:
            f.write("[Desktop Entry]\nExec=/opt/x/run.sh %U\n")
        argv = st.launch_command_for({"id": "x"}, applications_dir=d)
        self.assertEqual(argv, ["/opt/x/run.sh"])

    def test_launch_command_missing_desktop(self):
        d = tempfile.mkdtemp()
        self.assertIsNone(st.launch_command_for({"id": "nope"},
                                                applications_dir=d))


class LanguageTests(unittest.TestCase):
    def test_no_banned_words_in_ui_strings(self):
        for key, val in st.S.items():
            low = val.lower()
            for banned in BANNED_WORDS:
                self.assertNotIn(banned, low,
                                 "banned word %r in store string %r"
                                 % (banned, key))

    def test_action_words_are_plain(self):
        for word in (st.S["get"], st.S["update"], st.S["open"],
                     st.S["check_again"]):
            self.assertLessEqual(len(word.split()), 2)


class ModuleTests(unittest.TestCase):
    def test_imports_and_main_pieces_exist(self):
        self.assertTrue(hasattr(st, "StoreWindow"))
        self.assertTrue(hasattr(st, "find_store_manifest"))
        self.assertTrue(hasattr(st, "launch_command_for"))
        self.assertTrue(hasattr(st, "main"))
        # The store installs through the shared, tested safety machinery:
        # SHA256SUMS verification is mandatory inside install_app_update.
        self.assertEqual(st.install_app_update.__module__, "aeon_github")


if __name__ == "__main__":
    unittest.main()
