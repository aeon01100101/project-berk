#!/usr/bin/env python3
"""Tests for the Berk updater. No real network: everything GitHub-shaped is
served by a tiny local HTTP server in-process."""

import hashlib
import importlib.util
import json
import os
import shutil
import socket
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
UPDATER = os.path.join(HERE, "..", "berk-updater.py")


def load_updater():
    spec = importlib.util.spec_from_file_location("berk_updater", UPDATER)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


bu = load_updater()

BANNED_WORDS = ("terminal", "kernel", "partition", "repository", "daemon",
                "ssid", "utc", "sudo", "root", "mount", "package",
                "dependency", "bootloader")


# ---------------------------------------------------------------------------
# Fake GitHub API

class FakeGHHandler(BaseHTTPRequestHandler):
    payload = b"{}"
    mode = "ok"  # ok | rate | notfound

    def log_message(self, *a):
        pass

    def _send(self, body, code=200, ctype="application/json"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.endswith("/releases/latest"):
            if self.mode == "rate":
                self._send(b'{"message":"API rate limit exceeded"}', 403)
            elif self.mode == "notfound":
                self._send(b'{"message":"Not Found"}', 404)
            else:
                self._send(self.payload)
        elif self.path.startswith("/assets/"):
            name = self.path[len("/assets/"):]
            body = self.server.assets.get(name)
            if body is None:
                self._send(b"nope", 404, "text/plain")
            else:
                self._send(body, 200, "application/octet-stream")
        else:
            self._send(b"nope", 404, "text/plain")


def start_server(payload_obj, assets):
    srv = HTTPServer(("127.0.0.1", 0), FakeGHHandler)
    srv.assets = assets
    FakeGHHandler.payload = json.dumps(payload_obj).encode()
    FakeGHHandler.mode = "ok"
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    return srv


def release_payload(base, tag, deb_name, sums_name="SHA256SUMS"):
    return {
        "tag_name": tag,
        "assets": [
            {"name": deb_name,
             "browser_download_url": base + "/assets/" + deb_name},
            {"name": sums_name,
             "browser_download_url": base + "/assets/" + sums_name},
        ],
    }


def write_manifest(tmpdir, comps, owner="test-owner"):
    path = os.path.join(tmpdir, "apps.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"github_owner": owner, "components": comps}, f)
    return path


def music_comp(tmpdir, **kw):
    c = {"id": "music", "menu_name": "Music", "type": "app",
         "repo": "aeonradio", "asset_pattern": "music_*_amd64.deb",
         "sums_asset": "SHA256SUMS",
         "install_dir": os.path.join(tmpdir, "opt", "aeonradio"),
         "version_file": os.path.join(tmpdir, "opt", "aeonradio", "version.txt")}
    c.update(kw)
    return c


# ---------------------------------------------------------------------------

class VersionTests(unittest.TestCase):
    def test_numeric_segments(self):
        self.assertEqual(bu.compare_versions("1.10", "1.9"), 1)
        self.assertEqual(bu.compare_versions("1.9", "1.10"), -1)

    def test_equal(self):
        self.assertEqual(bu.compare_versions("1.0.5", "1.0.5"), 0)
        self.assertEqual(bu.compare_versions("1.0", "1.0.0"), 0)
        self.assertEqual(bu.compare_versions("2.0.0", "2"), 0)

    def test_v_prefix(self):
        self.assertEqual(bu.compare_versions("v1.0.5", "1.0.5"), 0)
        self.assertEqual(bu.strip_v("v1.2.3"), "1.2.3")
        self.assertEqual(bu.strip_v("1.2.3"), "1.2.3")

    def test_prerelease_is_older(self):
        self.assertEqual(bu.compare_versions("1.0.5-beta", "1.0.5"), -1)
        self.assertEqual(bu.compare_versions("1.0.5", "1.0.5-beta"), 1)
        self.assertEqual(bu.compare_versions("1.0.5-beta", "1.0.5-alpha"), 1)

    def test_major_minor(self):
        self.assertEqual(bu.compare_versions("2.0", "1.99.99"), 1)
        self.assertEqual(bu.compare_versions("1.0.5", "1.0.6"), -1)


class AssetMatchTests(unittest.TestCase):
    def test_picks_matching_asset(self):
        rel = {"assets": [
            {"name": "music_1.0.6_amd64.deb", "browser_download_url": "x"},
            {"name": "SHA256SUMS", "browser_download_url": "y"},
            {"name": "music_1.0.6_arm64.deb", "browser_download_url": "z"},
        ]}
        a = bu.pick_asset(rel, "music_*_amd64.deb")
        self.assertIsNotNone(a)
        self.assertEqual(a["name"], "music_1.0.6_amd64.deb")

    def test_no_match(self):
        rel = {"assets": [{"name": "SHA256SUMS"}]}
        self.assertIsNone(bu.pick_asset(rel, "music_*_amd64.deb"))

    def test_sums_url(self):
        rel = {"assets": [
            {"name": "music_1.0.6_amd64.deb",
             "browser_download_url": "http://x/d.deb"},
            {"name": "SHA256SUMS",
             "browser_download_url": "http://x/SHA256SUMS"},
        ]}
        comp = {"sums_asset": "SHA256SUMS"}
        self.assertEqual(bu.sums_url_for("b", "o", comp, rel),
                         "http://x/SHA256SUMS")
        self.assertIsNone(bu.sums_url_for("b", "o", comp, {"assets": []}))


class ShaTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _files(self, content=b"hello berk"):
        f = os.path.join(self.tmp, "music_1.0.6_amd64.deb")
        with open(f, "wb") as fh:
            fh.write(content)
        h = hashlib.sha256(content).hexdigest()
        s = os.path.join(self.tmp, "SHA256SUMS")
        with open(s, "w") as fh:
            fh.write("%s  music_1.0.6_amd64.deb\n" % h)
        return f, s

    def test_accept(self):
        f, s = self._files()
        self.assertTrue(bu.verify_sha256(f, s, "music_1.0.6_amd64.deb"))

    def test_reject_tampered(self):
        f, s = self._files()
        with open(f, "ab") as fh:
            fh.write(b"evil")
        self.assertFalse(bu.verify_sha256(f, s, "music_1.0.6_amd64.deb"))

    def test_reject_missing_entry(self):
        f, _ = self._files()
        s = os.path.join(self.tmp, "SHA256SUMS")
        with open(s, "w") as fh:
            fh.write("deadbeef  something-else.deb\n")
        self.assertFalse(bu.verify_sha256(f, s, "music_1.0.6_amd64.deb"))

    def test_reject_missing_sums_file(self):
        f, _ = self._files()
        self.assertFalse(bu.verify_sha256(
            f, os.path.join(self.tmp, "nope"), "music_1.0.6_amd64.deb"))

    def test_star_prefix_format(self):
        f = os.path.join(self.tmp, "a.deb")
        with open(f, "wb") as fh:
            fh.write(b"data")
        h = hashlib.sha256(b"data").hexdigest()
        s = os.path.join(self.tmp, "SHA256SUMS")
        with open(s, "w") as fh:
            fh.write("%s *a.deb\n" % h)
        self.assertTrue(bu.verify_sha256(f, s, "a.deb"))


class ManifestTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.old = os.environ.get("BERK_MANIFEST")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)
        if self.old is None:
            os.environ.pop("BERK_MANIFEST", None)
        else:
            os.environ["BERK_MANIFEST"] = self.old

    def test_valid(self):
        p = write_manifest(self.tmp, [music_comp(self.tmp)])
        os.environ["BERK_MANIFEST"] = p
        owner, api_base, comps = bu.load_manifest()
        self.assertEqual(owner, "test-owner")
        self.assertEqual(len(comps), 1)
        self.assertTrue(api_base.startswith("http"))

    def test_missing_field(self):
        c = music_comp(self.tmp)
        del c["repo"]
        p = write_manifest(self.tmp, [c])
        os.environ["BERK_MANIFEST"] = p
        with self.assertRaises(ValueError):
            bu.load_manifest()

    def test_bad_type(self):
        p = write_manifest(self.tmp, [music_comp(self.tmp, type="nope")])
        os.environ["BERK_MANIFEST"] = p
        with self.assertRaises(ValueError):
            bu.load_manifest()

    def test_empty_owner(self):
        p = write_manifest(self.tmp, [music_comp(self.tmp)], owner="  ")
        os.environ["BERK_MANIFEST"] = p
        with self.assertRaises(ValueError):
            bu.load_manifest()

    def test_real_manifest_loads(self):
        real = os.path.join(HERE, "..", "apps.json")
        owner, api_base, comps = bu.load_manifest(real)
        self.assertTrue(owner and owner.strip(), "github_owner must be set")
        self.assertEqual(len(comps), 7)
        ids = [c["id"] for c in comps]
        for want in ("music", "code-maker", "picture-maker", "3d-maker",
                     "aeoncraft", "minecraft", "berk-system"):
            self.assertIn(want, ids)


class CheckFlowTests(unittest.TestCase):
    """End-to-end check logic against the fake local GitHub API."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.old_manifest = os.environ.get("BERK_MANIFEST")
        self.old_api = os.environ.get("BERK_GH_API")
        self.deb_bytes = b"fake-deb-bytes-" * 100
        self.srv = None

    def tearDown(self):
        if self.srv:
            self.srv.shutdown()
        shutil.rmtree(self.tmp, ignore_errors=True)
        bu._VERSION_FILE_OVERRIDES.clear()
        for k, v in (("BERK_MANIFEST", self.old_manifest),
                     ("BERK_GH_API", self.old_api)):
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def _serve(self, tag, tamper=False):
        deb = self.deb_bytes + (b"X" if tamper else b"")
        sums = ("%s  music_1.0.6_amd64.deb\n"
                % hashlib.sha256(self.deb_bytes).hexdigest()).encode()
        base = "http://127.0.0.1:%d" % self.srv.server_address[1]
        payload = release_payload(base, tag, "music_1.0.6_amd64.deb")
        self.srv.assets = {"music_1.0.6_amd64.deb": deb,
                           "SHA256SUMS": sums}
        FakeGHHandler.payload = json.dumps(payload).encode()

    def _setup(self, installed, tag="v1.0.6"):
        comp = music_comp(self.tmp)
        p = write_manifest(self.tmp, [comp])
        os.environ["BERK_MANIFEST"] = p
        self.srv = start_server({}, {})
        os.environ["BERK_GH_API"] = \
            "http://127.0.0.1:%d" % self.srv.server_address[1]
        self._serve(tag)
        if installed is not None:
            vf = os.path.join(self.tmp, "vf.txt")
            with open(vf, "w") as f:
                f.write(installed)
            bu._VERSION_FILE_OVERRIDES["music"] = vf
        return comp

    def test_update_detected(self):
        comp = self._setup("1.0.5")
        owner, api_base, comps = bu.load_manifest()
        r = bu.check_component(api_base, owner, comps[0])
        self.assertEqual(r["status"], "update_ready")
        self.assertEqual(r["latest"], "1.0.6")
        self.assertTrue(r["download_url"].startswith("http://127.0.0.1"))

    def test_up_to_date(self):
        self._setup("1.0.6")
        owner, api_base, comps = bu.load_manifest()
        r = bu.check_component(api_base, owner, comps[0])
        self.assertEqual(r["status"], "up_to_date")
        self.assertEqual(r["message"], "Up to date")

    def test_not_installed(self):
        comp = self._setup(None)
        comp["install_dir"] = "/nonexistent-berk-test-dir-xyz"
        owner, api_base, _ = bu.load_manifest()
        r = bu.check_component(api_base, owner, comp)
        self.assertEqual(r["status"], "not_installed")

    def test_rate_limit_plain_message(self):
        self._setup("1.0.5")
        FakeGHHandler.mode = "rate"
        owner, api_base, comps = bu.load_manifest()
        r = bu.check_component(api_base, owner, comps[0])
        self.assertEqual(r["status"], "error")
        self.assertNotIn("403", r["message"])
        self.assertIn("try again", r["message"].lower())

    def test_dry_run_installs_nothing(self):
        comp = self._setup("1.0.5")
        owner, api_base, comps = bu.load_manifest()
        r = bu.check_component(api_base, owner, comps[0])
        release, err = bu.fetch_latest(api_base, owner, comp["repo"])
        self.assertIsNone(err)
        sums_url = bu.sums_url_for(api_base, owner, comp, release)
        tmpd = tempfile.mkdtemp()
        try:
            called = []
            orig = bu._pkexec
            bu._pkexec = lambda *a: called.append(a) or (_ for _ in ()).throw(
                AssertionError("pkexec must not run in dry-run"))
            try:
                ok, msg = bu.install_app_update(
                    comp, r["download_url"], sums_url, "1.0.6", tmpd,
                    dry_run=True)
            finally:
                bu._pkexec = orig
            self.assertTrue(ok)
            self.assertEqual(called, [])
        finally:
            shutil.rmtree(tmpd, ignore_errors=True)

    def test_tampered_deb_refused(self):
        comp = self._setup("1.0.5", tag="v1.0.6")
        self._serve("v1.0.6", tamper=True)
        owner, api_base, comps = bu.load_manifest()
        r = bu.check_component(api_base, owner, comps[0])
        release, _ = bu.fetch_latest(api_base, owner, comp["repo"])
        sums_url = bu.sums_url_for(api_base, owner, comp, release)
        tmpd = tempfile.mkdtemp()
        try:
            ok, msg = bu.install_app_update(
                comp, r["download_url"], sums_url, "1.0.6", tmpd,
                dry_run=True)
            self.assertFalse(ok)
            self.assertIn("safety", msg.lower())
        finally:
            shutil.rmtree(tmpd, ignore_errors=True)


class PlainLanguageTests(unittest.TestCase):
    def test_no_banned_words_in_ui(self):
        for key, text in bu.S.items():
            low = text.lower()
            for word in BANNED_WORDS:
                self.assertNotIn(word, low,
                                 "banned word %r in UI string %r" % (word, key))

    def test_buttons_are_plain(self):
        self.assertEqual(bu.S["check"], "Check for updates")
        self.assertEqual(bu.S["install"], "Install updates")


class GuiTests(unittest.TestCase):
    def test_window_builds(self):
        try:
            import tkinter as tk
            from tkinter import ttk
        except Exception as e:
            self.skipTest("tkinter unavailable: %s" % e)
        try:
            win = bu.UpdatesWindow(tk, ttk)
        except tk.TclError as e:
            self.skipTest("no display: %s" % e)
        try:
            self.assertEqual(win.root.title(), "Updates")
            self.assertEqual(win.check_button["text"], "Check for updates")
            self.assertEqual(win.install_button["text"], "Install updates")
            self.assertEqual(str(win.install_button["state"]), "disabled")
            comps = [{"id": "a", "menu_name": "Music"},
                     {"id": "b", "menu_name": "Berk system"}]
            win.build_rows(comps)
            self.assertEqual(set(win.rows.keys()), {"a", "b"})
            win.set_row("a", "Update ready")
            self.assertEqual(win.rows["a"]["text"], "Update ready")
            win.set_progress("Getting Music\u2026", 0.5)
            win.root.update()
            self.assertTrue(win.root.winfo_exists())
            self.assertGreater(win.root.winfo_width(), 100)
        finally:
            win.root.destroy()


if __name__ == "__main__":
    unittest.main(verbosity=2)
