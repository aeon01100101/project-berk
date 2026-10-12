#!/usr/bin/env python3
"""Berk Updates — the friendly updater for Aeon OS Berk.

Checks each Aeon app (and the Berk system layer) for new releases on
GitHub, verifies every download with SHA256SUMS before touching anything,
and installs with a graphical permission prompt.

Standard library only: urllib, json, hashlib, tkinter, etc.
No third-party packages, so it can never break from a dependency update.

Usage:
    berk-updater.py            open the Updates window
    berk-updater.py --auto     silent check (for autostart): notify if updates
                               are ready, no window. Exit 0 = updates found,
                               2 = nothing new, 1 = could not check.
    berk-updater.py --dry-run  check + download + safety-check everything,
                               but stop before installing anything.

Environment (mainly for testing):
    BERK_GH_API       override the GitHub API base URL
    BERK_MANIFEST     override the path to apps.json
"""

import argparse
import fnmatch
import hashlib
import json
import os
import queue
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import threading
import urllib.error
import urllib.request

# ---------------------------------------------------------------------------
# Shared GitHub machinery lives in aeon_github.py (also used by Aeon Store).
# The sys.path bootstrap keeps `from aeon_github import ...` working whether
# this file runs as a script or is loaded via importlib (as the tests do).
import os as _os
import sys as _sys
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
from aeon_github import (
    S, GITHUB_API_DEFAULT, USER_AGENT, _VERSION_FILE_OVERRIDES, find_manifest, load_manifest, _version_key, compare_versions, strip_v, api_get, fetch_latest, pick_asset, download_file, verify_sha256, installed_version, check_component, _pkexec, ensure_version_file, _shq, install_app_update, install_system_update, sums_url_for,
)
del _os, _sys


# ---------------------------------------------------------------------------
# GUI

class UpdatesWindow(object):
    def __init__(self, tk, ttk):
        self._tk, self._ttk = tk, ttk
        self.root = tk.Tk()
        self.root.title(S["title"])
        self.root.minsize(520, 560)
        try:
            self.root.tk.call("tk", "scaling", 1.4)
        except Exception:
            pass

        big = ("TkDefaultFont", 22, "bold")
        med = ("TkDefaultFont", 16)
        small = ("TkDefaultFont", 13)

        tk.Label(self.root, text=S["title"], font=big).pack(pady=(24, 6))
        self.top_status = tk.Label(self.root, text="", font=small,
                                   wraplength=460, justify="center")
        self.top_status.pack(pady=(0, 12))

        self.rows = {}
        list_frame = tk.Frame(self.root)
        list_frame.pack(fill="x", padx=32)
        self._list_frame = list_frame
        self._med, self._small = med, small

        self.check_button = tk.Button(
            self.root, text=S["check"], font=med, padx=28, pady=14,
            command=self.on_check)
        self.check_button.pack(pady=14)

        self.install_button = tk.Button(
            self.root, text=S["install"], font=med, padx=28, pady=14,
            command=self.on_install, state="disabled")
        self.install_button.pack(pady=(0, 14))

        self.progress = ttk.Progressbar(self.root, mode="determinate",
                                        maximum=100, length=420)
        self.progress.pack(pady=(6, 4))
        self.prog_label = tk.Label(self.root, text="", font=small,
                                   wraplength=460, justify="center")
        self.prog_label.pack(pady=(0, 24))

        self.results = []
        self._busy = False
        # Worker threads never touch Tkinter directly (it is not
        # thread-safe): they post callables here, and _poll_queue runs
        # them on the main thread.
        self._queue = queue.Queue()
        self._poll_queue()

    def _post(self, fn):
        """Call from a worker thread: schedule fn to run on the UI thread."""
        self._queue.put(fn)

    def _poll_queue(self):
        try:
            while True:
                fn = self._queue.get_nowait()
                try:
                    fn()
                except Exception:
                    pass  # a bad callback must not kill the poll loop
        except queue.Empty:
            pass
        self.root.after(120, self._poll_queue)

    # -- rows ---------------------------------------------------------------
    def build_rows(self, comps):
        for child in self._list_frame.winfo_children():
            child.destroy()
        self.rows = {}
        for comp in comps:
            row = self._tk.Frame(self._list_frame)
            row.pack(fill="x", pady=8)
            name = self._tk.Label(row, text=comp["menu_name"],
                                  font=self._med, anchor="w")
            name.pack(side="left")
            status = self._tk.Label(row, text="", font=self._small,
                                    anchor="e", wraplength=220, justify="right")
            status.pack(side="right")
            self.rows[comp["id"]] = status

    def set_row(self, comp_id, text):
        w = self.rows.get(comp_id)
        if w is not None:
            w.config(text=text)

    def set_progress(self, text, frac=None):
        self.prog_label.config(text=text)
        if frac is not None:
            self.progress["value"] = int(frac * 100)
        self.root.update_idletasks()

    # -- worker plumbing -----------------------------------------------------
    def _run_async(self, fn, done=None):
        def wrapper():
            try:
                out = fn()
            except Exception:
                out = ("__error__", S["generic_error"])
            self._post(lambda: done(out) if done else None)
        threading.Thread(target=wrapper, daemon=True).start()

    # -- check ---------------------------------------------------------------
    def on_check(self):
        if self._busy:
            return
        self._busy = True
        self.check_button.config(state="disabled")
        self.install_button.config(state="disabled")
        self.set_progress(S["checking"], 0)
        for cid in self.rows:
            self.set_row(cid, S["checking"])

        def work():
            owner, api_base, comps = load_manifest()
            results = []
            for i, comp in enumerate(comps):
                self._post(lambda i=i: self.set_progress(
                    S["checking"], i / max(1, len(comps))))
                results.append(check_component(api_base, owner, comp))
            return results

        def done(results):
            self._busy = False
            self.results = results
            if results and results[0] == "__error__":
                self.top_status.config(text=results[1])
                self.check_button.config(state="normal")
                self.set_progress("", 0)
                return
            any_ready = False
            for r in results:
                self.set_row(r["comp"]["id"], r["message"])
                if r["status"] == "update_ready":
                    any_ready = True
            if any_ready:
                self.install_button.config(state="normal")
                self.top_status.config(text="")
            else:
                self.top_status.config(text=S["nothing"])
            self.check_button.config(state="normal")
            self.set_progress("", 0)

        self._run_async(work, done)

    # -- install --------------------------------------------------------------
    def on_install(self):
        if self._busy:
            return
        ready = [r for r in self.results if r["status"] == "update_ready"]
        if not ready:
            return
        self._busy = True
        self.check_button.config(state="disabled")
        self.install_button.config(state="disabled")

        def work():
            owner, api_base, _ = load_manifest()
            tmpdir = tempfile.mkdtemp(prefix="berk-update-")
            try:
                for r in ready:
                    comp = r["comp"]
                    self._say(S["downloading"].format(name=comp["menu_name"]),
                              0.05)
                    release, err = fetch_latest(api_base, owner, comp["repo"])
                    if err or release is None:
                        return (comp, False, S["generic_error"])
                    sums_url = sums_url_for(api_base, owner, comp, release)
                    if not sums_url:
                        return (comp, False,
                                S["unsafe"].format(name=comp["menu_name"]))
                    if comp["type"] == "system":
                        ok, msg = install_system_update(
                            comp, r["download_url"], sums_url, r["latest"],
                            tmpdir, progress=self._say_threadsafe)
                    else:
                        ok, msg = install_app_update(
                            comp, r["download_url"], sums_url, r["latest"],
                            tmpdir, progress=self._say_threadsafe)
                    if not ok:
                        return (comp, False, msg)
                    self._post(lambda c=comp: self.set_row(
                        c["id"], S["up_to_date"]))
                return (None, True, S["done"])
            finally:
                shutil.rmtree(tmpdir, ignore_errors=True)

        def done(out):
            self._busy = False
            comp, ok, msg = out
            if ok:
                self.set_progress(S["done"], 1.0)
                self.top_status.config(text="")
            else:
                self.set_progress("", 0)
                if comp is not None:
                    self.set_row(comp["id"], msg)
                else:
                    self.top_status.config(text=msg)
            self.check_button.config(state="normal")

        self._run_async(work, done)

    def _say(self, text, frac):
        self._post(lambda: self.set_progress(text, frac))

    def _say_threadsafe(self, text, frac):
        # Called from worker threads: _say posts to the UI queue, so this
        # is safe. (Direct widget access from a worker would race.)
        self._say(text, frac)

    def run(self):
        owner, _, comps = load_manifest()
        self.build_rows(comps)
        self.root.mainloop()


# ---------------------------------------------------------------------------
# --auto and --dry-run

def notify_updates_ready():
    try:
        if shutil.which("notify-send"):
            subprocess.run(
                ["notify-send", S["notify_title"], S["notify_body"]],
                timeout=10)
            return
    except Exception:
        pass
    print("%s: %s" % (S["notify_title"], S["notify_body"]))


def run_auto():
    owner, api_base, comps = load_manifest()
    found = False
    checkable = False
    for comp in comps:
        r = check_component(api_base, owner, comp)
        if r["status"] == "error":
            continue
        checkable = True
        if r["status"] == "update_ready":
            found = True
    if found:
        notify_updates_ready()
        return 0
    if not checkable:
        print(S["generic_error"])
        return 1
    return 2


def run_dry_run():
    owner, api_base, comps = load_manifest()
    tmpdir = tempfile.mkdtemp(prefix="berk-update-dry-")
    try:
        for comp in comps:
            r = check_component(api_base, owner, comp)
            print("%s: %s" % (comp["menu_name"], r["message"]))
            if r["status"] != "update_ready":
                continue
            release, err = fetch_latest(api_base, owner, comp["repo"])
            sums_url = sums_url_for(api_base, owner, comp,
                                    release) if not err else None
            if err or not sums_url:
                print("  -> %s" % S["unsafe"].format(name=comp["menu_name"]))
                continue
            if comp["type"] == "system":
                ok, msg = install_system_update(
                    comp, r["download_url"], sums_url, r["latest"], tmpdir,
                    dry_run=True)
            else:
                ok, msg = install_app_update(
                    comp, r["download_url"], sums_url, r["latest"], tmpdir,
                    dry_run=True)
            print("  -> download + safety check: %s"
                  % ("OK, would install now" if ok else msg))
        print("Dry run finished. Nothing was installed.")
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


# ---------------------------------------------------------------------------

def main(argv=None):
    parser = argparse.ArgumentParser(description="Berk Updates")
    parser.add_argument("--auto", action="store_true",
                        help="silent check; notify if updates are ready")
    parser.add_argument("--dry-run", action="store_true",
                        help="check, download and safety-check, but do not install")
    args = parser.parse_args(argv)

    if args.auto:
        return run_auto()
    if args.dry_run:
        run_dry_run()
        return 0

    import tkinter as tk
    from tkinter import ttk
    win = UpdatesWindow(tk, ttk)
    win.run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
