#!/usr/bin/env python3
"""Aeon Store — the one and only app store for Aeon OS Berk.

Big friendly buttons, plain words, zero jargon. Lists every Aeon app,
shows which ones are on this computer, and gets new ones with one tap.

How installs stay safe (same rule as the Updates app):
  every download is checked against the app's SHA256SUMS file first.
  No checksums, or a mismatch, means no install, ever. Installing asks
  for permission with a graphical prompt (pkexec).

Standard library only: tkinter, urllib, json, hashlib, etc.
No third-party packages, so it can never break from a dependency update.

Usage:
    aeon-store.py            open the Aeon Store window

Environment (mainly for testing):
    BERK_GH_API       override the GitHub API base URL
    BERK_MANIFEST     override the path to apps.json
"""

import os as _os
import queue
import shlex
import subprocess
import sys as _sys
import tempfile
import threading

_here = _os.path.dirname(_os.path.abspath(__file__))
_sys.path.insert(0, _here)
# Repo checkout layout: the shared module lives in ../updater. In the
# installed .deb it sits beside this script, so that copy wins there.
_updater_dir = _os.path.normpath(_os.path.join(_here, "..", "updater"))
if _os.path.isfile(_os.path.join(_updater_dir, "aeon_github.py")):
    _sys.path.insert(0, _updater_dir)
del _here, _updater_dir
from aeon_github import (  # noqa: E402
    S as _S,
    check_component,
    fetch_latest,
    install_app_update,
    load_manifest,
    pick_asset,
    strip_v,
    sums_url_for,
)

# ---------------------------------------------------------------------------
# Plain-language strings. Berk rule: a 1st grader must understand every word
# shown on screen. Banned anywhere user-visible: terminal, kernel, partition,
# repository, daemon, SSID, UTC, sudo, root, mount, package, dependency,
# bootloader.

S = {
    "title": "Aeon Store",
    "subtitle": "Get more apps for your computer.",
    "check_again": "Check again",
    "checking": "Looking for apps\u2026",
    "get": "Get",
    "update": "Update",
    "open": "Open",
    "getting": "Getting {name}\u2026",
    "safety": "Making sure {name} is safe\u2026",
    "installing": "Putting {name} on your computer\u2026",
    "done": "{name} is ready!",
    "on_computer": "On this computer",
    "not_on_computer": "Not on this computer yet",
    "update_ready": "A newer one is ready",
    "check_failed": "Couldn't reach the store \u2014 try again later.",
    "no_internet": "Can't reach the internet. Check your connection and try again.",
    "busy": "Busy right now \u2014 try again in a bit.",
    "unsafe": "{name} didn't pass its safety check, so it was not installed.",
    "need_permission": "I need your permission to install. Nothing was changed.",
    "generic_error": "Something didn't work. Try again.",
    "cant_open": "Couldn't open {name}. Find it in the start menu.",
}

SYSTEM_MANIFEST = "/usr/share/berk-updater/apps.json"


def find_store_manifest():
    """The updater's copy of apps.json is the freshest catalog; the copy
    shipped beside this script (in its .deb) is next; the repo checkout
    layout (store/../updater/apps.json) is the dev fallback."""
    override = _os.environ.get("BERK_MANIFEST")
    if override and _os.path.isfile(override):
        return override
    if _os.path.isfile(SYSTEM_MANIFEST):
        return SYSTEM_MANIFEST
    here = _os.path.dirname(_os.path.abspath(__file__))
    for cand in (_os.path.join(here, "apps.json"),
                 _os.path.join(here, "..", "updater", "apps.json")):
        if _os.path.isfile(cand):
            return _os.path.normpath(cand)
    return _os.path.join(here, "apps.json")


def launch_command_for(comp, applications_dir="/usr/share/applications"):
    """Parse Exec= from the app's .desktop file. Returns argv list or None."""
    desktop = _os.path.join(applications_dir, "berk-%s.desktop" % comp["id"])
    try:
        with open(desktop, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                if line.startswith("Exec="):
                    cmd = line[5:].strip()
                    break
            else:
                return None
    except OSError:
        return None
    # Drop freedesktop field codes (%f, %u, ...) — our apps take no files.
    parts = [p for p in shlex.split(cmd)
             if not (len(p) == 2 and p.startswith("%"))]
    return parts or None


class StoreWindow(object):
    def __init__(self, tk):
        self._tk = tk
        self.root = tk.Tk()
        self.root.title(S["title"])
        self.root.geometry("780x600")
        self.root.minsize(640, 480)
        # Gentle warm background; big readable text everywhere.
        self.root.configure(bg="#fdf6ec")
        self._cards = {}   # comp id -> dict of widgets + state
        self._comps = []
        self._owner = ""
        self._api_base = ""

        header = tk.Frame(self.root, bg="#0b5ed7", padx=20, pady=14)
        header.pack(fill="x")
        tk.Label(header, text=S["title"], font=("TkDefaultFont", 30, "bold"),
                 fg="white", bg="#0b5ed7").pack(side="left")
        tk.Label(header, text=S["subtitle"], font=("TkDefaultFont", 14),
                 fg="#dbeafe", bg="#0b5ed7").pack(side="left", padx=(16, 0))
        self.refresh_btn = tk.Button(
            header, text=S["check_again"], font=("TkDefaultFont", 14, "bold"),
            bg="#ffd83d", activebackground="#ffdf6b",
            padx=14, pady=6, command=self.refresh)
        self.refresh_btn.pack(side="right")

        # Scrollable app list.
        self.canvas = tk.Canvas(self.root, bg="#fdf6ec",
                                highlightthickness=0)
        scrollbar = tk.Scrollbar(self.root, orient="vertical",
                                 command=self.canvas.yview)
        self.canvas.configure(yscrollcommand=scrollbar.set)
        scrollbar.pack(side="right", fill="y")
        self.canvas.pack(side="left", fill="both", expand=True)
        self.list_frame = tk.Frame(self.canvas, bg="#fdf6ec")
        self.canvas.create_window((0, 0), window=self.list_frame,
                                  anchor="nw", tags="list")
        self.list_frame.bind(
            "<Configure>",
            lambda e: self.canvas.configure(
                scrollregion=self.canvas.bbox("all")))
        self.canvas.bind(
            "<Configure>",
            lambda e: self.canvas.itemconfig("list", width=e.width))

        self.status = tk.Label(
            self.root, text="", font=("TkDefaultFont", 13),
            bg="#ece9d8", fg="#0b3d91", anchor="w", padx=14, pady=8)
        self.status.pack(side="bottom", fill="x")

        self.set_status(S["checking"])
        # Worker threads never touch Tkinter directly (it is not
        # thread-safe): they post callables here, and _poll_queue runs
        # them on the main thread.
        self._queue = queue.Queue()
        self._poll_queue()
        threading.Thread(target=self._load_all, daemon=True).start()

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

    # -- data ----------------------------------------------------------
    def _load_all(self):
        try:
            owner, api_base, comps = load_manifest(find_store_manifest())
        except Exception:
            self._post(self._show_load_error)
            return
        # The store lists installable apps only, never the system layer.
        comps = [c for c in comps if c.get("type") == "app"]
        self._owner, self._api_base, self._comps = owner, api_base, comps
        self._post(self._build_cards)
        for comp in comps:
            threading.Thread(target=self._check_one, args=(comp,),
                             daemon=True).start()

    def _show_load_error(self):
        self.set_status(S["check_failed"])

    def _check_one(self, comp):
        try:
            result = check_component(self._api_base, self._owner, comp)
        except Exception:
            result = {"comp": comp, "status": "error",
                      "message": S["generic_error"]}
        self._post(lambda: self._update_card(comp["id"], result))

    # -- cards ---------------------------------------------------------
    def _build_cards(self):
        for comp in self._comps:
            card = self._tk.Frame(self.list_frame, bg="white",
                                  padx=18, pady=14,
                                  highlightbackground="#c9d6f2",
                                  highlightthickness=2)
            card.pack(fill="x", padx=16, pady=8)
            top = self._tk.Frame(card, bg="white")
            top.pack(fill="x")
            name = self._tk.Label(top, text=comp["menu_name"],
                                  font=("TkDefaultFont", 24, "bold"),
                                  fg="#0b3d91", bg="white", anchor="w")
            name.pack(side="left", fill="x", expand=True)
            action = self._tk.Button(
                top, text="\u2026", font=("TkDefaultFont", 18, "bold"),
                state="disabled", padx=26, pady=10)
            action.pack(side="right")
            blurb = self._tk.Label(
                card, text=comp.get("blurb", ""),
                font=("TkDefaultFont", 14), fg="#334155", bg="white",
                anchor="w", wraplength=640, justify="left")
            blurb.pack(fill="x", pady=(4, 0))
            status = self._tk.Label(card, text=S["checking"],
                                    font=("TkDefaultFont", 13, "bold"),
                                    fg="#64748b", bg="white", anchor="w")
            status.pack(fill="x", pady=(6, 0))
            self._cards[comp["id"]] = {
                "comp": comp, "card": card, "action": action,
                "status": status, "result": None, "busy": False,
            }
            action.configure(command=lambda c=comp["id"]: self._on_action(c))

    def _update_card(self, comp_id, result):
        info = self._cards.get(comp_id)
        if not info:
            return
        info["result"] = result
        info["busy"] = False
        status, action = info["status"], info["action"]
        st = result["status"]
        if st == "not_installed":
            status.configure(text=S["not_on_computer"], fg="#b45309")
            action.configure(text=S["get"], state="normal",
                             bg="#37b24d", activebackground="#40c057",
                             fg="white")
        elif st == "update_ready":
            have = result.get("have")
            status.configure(
                text="%s%s" % (S["update_ready"],
                               " (you have %s)" % have if have else ""),
                fg="#0b5ed7")
            action.configure(text=S["update"], state="normal",
                             bg="#2b9bf6", activebackground="#4aa8f7",
                             fg="white")
        elif st == "up_to_date":
            status.configure(text=S["on_computer"], fg="#2f9e44")
            action.configure(text=S["open"], state="normal",
                             bg="#ffd83d", activebackground="#ffdf6b",
                             fg="#3a2c00")
        else:
            status.configure(text=result.get("message", S["generic_error"]),
                             fg="#c92a2a")
            action.configure(text="\u2026", state="disabled")
        self._refresh_status_line()

    def _refresh_status_line(self):
        if any(i["busy"] for i in self._cards.values()):
            return
        ready = sum(1 for i in self._cards.values()
                    if i["result"] and i["result"]["status"] == "update_ready")
        missing = sum(1 for i in self._cards.values()
                      if i["result"] and i["result"]["status"] == "not_installed")
        if ready or missing:
            self.set_status(
                "%d app%s ready to get, %d update%s ready."
                % (missing, "" if missing == 1 else "s",
                   ready, "" if ready == 1 else "s"))
        elif all(i["result"] for i in self._cards.values()):
            self.set_status("Everything is already on this computer.")

    # -- actions -------------------------------------------------------
    def _on_action(self, comp_id):
        info = self._cards[comp_id]
        if info["busy"]:
            return
        result = info["result"] or {}
        st = result.get("status")
        if st == "up_to_date":
            self._open_app(info["comp"])
        elif st in ("not_installed", "update_ready"):
            self._get_app(info)
        # "error" cards: nothing to do; "Check again" retries.

    def _open_app(self, comp):
        argv = launch_command_for(comp)
        if not argv:
            self.set_status(S["cant_open"].format(name=comp["menu_name"]))
            return
        try:
            subprocess.Popen(argv, start_new_session=True,
                             stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL)
        except OSError:
            self.set_status(S["cant_open"].format(name=comp["menu_name"]))

    def _get_app(self, info):
        comp = info["comp"]
        info["busy"] = True
        info["action"].configure(state="disabled", text="\u2026")
        info["status"].configure(text=S["checking"], fg="#64748b")
        threading.Thread(target=self._install_thread, args=(info,),
                         daemon=True).start()

    def _install_thread(self, info):
        comp = info["comp"]
        name = comp["menu_name"]
        tmpdir = tempfile.mkdtemp(prefix="aeon-store-")

        def prog(msg, _frac):
            self._post(lambda m=msg: self.set_status(m))

        try:
            release, err = fetch_latest(self._api_base, self._owner,
                                        comp["repo"])
            if err:
                msg = {"rate": S["busy"], "net": S["no_internet"]}.get(
                    err, S["generic_error"])
                self._post(lambda: self._install_done(info, False, msg))
                return
            asset = pick_asset(release, comp["asset_pattern"])
            sums_url = sums_url_for(self._api_base, self._owner, comp,
                                    release)
            if asset is None or not sums_url:
                self._post(lambda: self._install_done(info, False,
                                                      S["generic_error"]))
                return
            version = strip_v(release.get("tag_name", ""))
            ok, msg = install_app_update(
                comp, asset["browser_download_url"], sums_url, version,
                tmpdir,
                progress=lambda m, f: prog(m, f))
            if not ok:
                # Map the updater's messages onto store wording.
                self._post(lambda: self._install_done(info, False, msg))
                return
            self._post(lambda: self._install_done(info, True,
                                          S["done"].format(name=name)))
        except Exception:
            self._post(lambda: self._install_done(info, False,
                                          S["generic_error"]))
        finally:
            import shutil
            shutil.rmtree(tmpdir, ignore_errors=True)

    def _install_done(self, info, ok, msg):
        self.set_status(msg)
        # Re-check this app so its card shows the new state.
        info["busy"] = True
        threading.Thread(target=self._check_one, args=(info["comp"],),
                         daemon=True).start()

    # -- misc ----------------------------------------------------------
    def set_status(self, text):
        self.status.configure(text=text or "")

    def refresh(self):
        for info in self._cards.values():
            if info["busy"]:
                continue
            info["busy"] = True
            info["action"].configure(state="disabled", text="\u2026")
            info["status"].configure(text=S["checking"], fg="#64748b")
            threading.Thread(target=self._check_one, args=(info["comp"],),
                             daemon=True).start()

    def run(self):
        self.root.mainloop()


def main():
    import tkinter
    try:
        win = StoreWindow(tkinter)
    except tkinter.TclError:
        print("Aeon Store needs a desktop to show its window.",
              file=_sys.stderr)
        return 1
    win.run()
    return 0


if __name__ == "__main__":
    _sys.exit(main())
