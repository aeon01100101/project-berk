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
# Plain-language strings. Berk rule: a 1st grader must understand every word
# shown on screen. Banned anywhere user-visible: terminal, kernel, partition,
# repository, daemon, SSID, UTC, sudo, root, mount, package, dependency,
# bootloader.

S = {
    "title": "Updates",
    "check": "Check for updates",
    "install": "Install updates",
    "up_to_date": "Up to date",
    "update_ready": "Update ready",
    "not_installed": "Not on this computer",
    "check_failed": "Couldn't check \u2014 try again later",
    "checking": "Checking\u2026",
    "downloading": "Getting {name}\u2026",
    "safety": "Making sure {name} is safe\u2026",
    "installing": "Installing {name}\u2026",
    "finishing": "Finishing up\u2026",
    "done": "All done!",
    "nothing": "Everything is already up to date.",
    "generic_error": "Something didn't work. Try again.",
    "no_internet": "Can't reach the internet. Check your connection and try again.",
    "busy": "Busy right now \u2014 try again in a bit.",
    "unsafe": "{name} didn't pass its safety check, so it was not installed.",
    "need_permission": "I need your permission to install. Nothing was changed.",
    "notify_title": "Updates",
    "notify_body": "Updates are ready \u2014 open Updates to install",
}

GITHUB_API_DEFAULT = "https://api.github.com"
USER_AGENT = "aeon-os-berk-updater/1.0"

# Test hook: map component id -> fake version file path.
_VERSION_FILE_OVERRIDES = {}


# ---------------------------------------------------------------------------
# Manifest

def find_manifest():
    override = os.environ.get("BERK_MANIFEST")
    if override and os.path.isfile(override):
        return override
    here = os.path.join(os.path.dirname(os.path.abspath(__file__)), "apps.json")
    if os.path.isfile(here):
        return here
    system = "/usr/share/berk-updater/apps.json"
    if os.path.isfile(system):
        return system
    return here


def load_manifest(path=None):
    """Load and validate apps.json. Returns (owner, api_base, [components])."""
    path = path or find_manifest()
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    owner = data.get("github_owner", "").strip()
    if not owner:
        raise ValueError("apps.json: github_owner is empty")
    api_base = (
        os.environ.get("BERK_GH_API")
        or data.get("api_base", "").strip()
        or GITHUB_API_DEFAULT
    ).rstrip("/")
    comps = data.get("components", [])
    if not comps:
        raise ValueError("apps.json: no components listed")
    required = ("id", "menu_name", "type", "repo", "asset_pattern",
                "install_dir", "version_file")
    for c in comps:
        for key in required:
            if not c.get(key):
                raise ValueError(
                    "apps.json: component %r is missing %r"
                    % (c.get("id", "?"), key)
                )
        if c["type"] not in ("app", "system"):
            raise ValueError(
                "apps.json: component %r has bad type %r"
                % (c["id"], c["type"])
            )
    return owner, api_base, comps


# ---------------------------------------------------------------------------
# Versions: numeric segments, so 1.10 > 1.9; a pre-release (1.0.5-beta)
# always compares lower than its release (1.0.5).

def _version_key(version):
    v = version.strip()
    if v[:1].lower() == "v":
        v = v[1:]
    parts = re.split(r"[-+]", v, maxsplit=1)
    core, pre = parts[0], (parts[1] if len(parts) > 1 else "")
    nums = []
    for seg in re.split(r"[._]", core):
        nums.append(int(seg) if seg.isdigit() else 0)
    # release (no pre part) sorts above any pre-release of the same numbers
    return (nums, 1 if pre == "" else 0, pre)


def compare_versions(a, b):
    """Return -1 if a<b, 0 if a==b, 1 if a>b."""
    ka, kb = _version_key(a), _version_key(b)
    na, nb = ka[0], kb[0]
    width = max(len(na), len(nb))
    na = na + [0] * (width - len(na))
    nb = nb + [0] * (width - len(nb))
    left = (na, ka[1], ka[2])
    right = (nb, kb[1], kb[2])
    if left < right:
        return -1
    if left > right:
        return 1
    return 0


def strip_v(tag):
    t = tag.strip()
    return t[1:] if t[:1].lower() == "v" else t


# ---------------------------------------------------------------------------
# GitHub API (urllib only)

def api_get(url):
    """GET url, parse JSON. Returns (data, error_code). error_code is None on
    success, else one of: rate, notfound, net, httpNNN."""
    req = urllib.request.Request(
        url,
        headers={"User-Agent": USER_AGENT,
                 "Accept": "application/vnd.github+json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.load(resp), None
    except urllib.error.HTTPError as e:
        if e.code in (403, 429):
            return None, "rate"
        if e.code == 404:
            return None, "notfound"
        return None, "http%d" % e.code
    except Exception:
        return None, "net"


def fetch_latest(api_base, owner, repo):
    url = "%s/repos/%s/%s/releases/latest" % (api_base, owner, repo)
    return api_get(url)


def pick_asset(release, pattern):
    """Pick the first asset whose file name matches the fnmatch pattern."""
    for asset in release.get("assets", []):
        name = asset.get("name", "")
        if name and fnmatch.fnmatch(name, pattern):
            return asset
    return None


def download_file(url, dest_path, progress=None):
    """Download url to dest_path. progress(downloaded, total_or_None)."""
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=120) as resp:
        total = resp.getheader("Content-Length")
        total = int(total) if total and total.isdigit() else None
        downloaded = 0
        with open(dest_path, "wb") as out:
            while True:
                chunk = resp.read(256 * 1024)
                if not chunk:
                    break
                out.write(chunk)
                downloaded += len(chunk)
                if progress:
                    progress(downloaded, total)


# ---------------------------------------------------------------------------
# Safety: SHA256SUMS is mandatory. No sums, or a mismatch, means no install.

def verify_sha256(file_path, sums_path, asset_name):
    """True only if sums_path lists asset_name (by base file name) and the
    hash of file_path matches."""
    want = os.path.basename(asset_name)
    try:
        with open(sums_path, "r", encoding="utf-8", errors="replace") as f:
            lines = f.read().splitlines()
    except OSError:
        return False
    expected = None
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        bits = line.split()
        if len(bits) < 2:
            continue
        listed = os.path.basename(bits[-1].lstrip("*"))
        if listed == want:
            expected = bits[0].lower()
            break
    if not expected or len(expected) != 64:
        return False
    digest = hashlib.sha256()
    with open(file_path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest() == expected


# ---------------------------------------------------------------------------
# Check + install logic (shared by GUI, --auto and --dry-run)

def installed_version(comp):
    path = _VERSION_FILE_OVERRIDES.get(comp["id"], comp["version_file"])
    try:
        with open(path, "r", encoding="utf-8") as f:
            v = f.read().strip()
            return v or None
    except OSError:
        return None


def check_component(api_base, owner, comp):
    """Returns a dict: status in up_to_date|update_ready|not_installed|error,
    plus message / latest / asset / download_url."""
    have = installed_version(comp)
    if have is None and not os.path.isdir(comp["install_dir"]):
        return {"comp": comp, "status": "not_installed",
                "message": S["not_installed"]}
    release, err = fetch_latest(api_base, owner, comp["repo"])
    if err == "rate":
        return {"comp": comp, "status": "error", "message": S["busy"]}
    if err == "net":
        return {"comp": comp, "status": "error", "message": S["no_internet"]}
    if err:
        return {"comp": comp, "status": "error", "message": S["generic_error"]}
    asset = pick_asset(release, comp["asset_pattern"])
    if asset is None:
        return {"comp": comp, "status": "error", "message": S["generic_error"]}
    latest = strip_v(release.get("tag_name", ""))
    if have is not None and compare_versions(have, latest) >= 0:
        return {"comp": comp, "status": "up_to_date",
                "message": S["up_to_date"], "latest": latest, "have": have}
    return {"comp": comp, "status": "update_ready",
            "message": S["update_ready"], "latest": latest, "have": have,
            "asset": asset,
            "download_url": asset.get("browser_download_url")}


def _pkexec(*args):
    if shutil.which("pkexec") is None:
        return None  # caller turns this into a plain-language message
    return subprocess.run(["pkexec"] + list(args))


def ensure_version_file(comp, version):
    """The .deb already ships version.txt; this is belt and suspenders."""
    path = comp["version_file"]
    try:
        with open(path, "r", encoding="utf-8") as f:
            if f.read().strip() == version:
                return True
    except OSError:
        pass
    res = _pkexec("sh", "-c",
                  "mkdir -p %s && printf '%%s' %s > %s"
                  % (_shq(os.path.dirname(path)), _shq(version), _shq(path)))
    return res is not None and res.returncode == 0


def _shq(s):
    return "'" + s.replace("'", "'\\''") + "'"


def install_app_update(comp, asset_url, sums_url, version, tmpdir,
                       dry_run=False, progress=None):
    """Download -> safety check -> install a .deb app update."""
    if not asset_url.lower().endswith(".deb"):
        return False, S["generic_error"]
    deb_path = os.path.join(tmpdir, os.path.basename(asset_url))
    sums_path = os.path.join(tmpdir, "SHA256SUMS")
    if progress:
        progress(S["downloading"].format(name=comp["menu_name"]), 0.1)
    download_file(asset_url, deb_path)
    download_file(sums_url, sums_path)
    if progress:
        progress(S["safety"].format(name=comp["menu_name"]), 0.5)
    if not verify_sha256(deb_path, sums_path, os.path.basename(asset_url)):
        return False, S["unsafe"].format(name=comp["menu_name"])
    if dry_run:
        return True, "dry-run ok"
    if progress:
        progress(S["installing"].format(name=comp["menu_name"]), 0.8)
    res = _pkexec("dpkg", "-i", deb_path)
    if res is None or res.returncode != 0:
        return False, S["need_permission"]
    ensure_version_file(comp, version)
    return True, "ok"


def install_system_update(comp, asset_url, sums_url, version, tmpdir,
                          dry_run=False, progress=None):
    """Download -> safety check -> re-run the idempotent system scripts."""
    tgz_path = os.path.join(tmpdir, os.path.basename(asset_url))
    sums_path = os.path.join(tmpdir, "SHA256SUMS")
    if progress:
        progress(S["downloading"].format(name=comp["menu_name"]), 0.1)
    download_file(asset_url, tgz_path)
    download_file(sums_url, sums_path)
    if progress:
        progress(S["safety"].format(name=comp["menu_name"]), 0.4)
    if not verify_sha256(tgz_path, sums_path, os.path.basename(asset_url)):
        return False, S["unsafe"].format(name=comp["menu_name"])
    extract = os.path.join(tmpdir, "system")
    os.makedirs(extract, exist_ok=True)
    with tarfile.open(tgz_path, "r:gz") as tf:
        tf.extractall(extract)
    harden = os.path.join(extract, "harden-mint.sh")
    ux = os.path.join(extract, "apply-ux.sh")
    if not (os.path.isfile(harden) and os.path.isfile(ux)):
        return False, S["generic_error"]
    if dry_run:
        return True, "dry-run ok"
    if progress:
        progress(S["installing"].format(name=comp["menu_name"]), 0.7)
    res = _pkexec("bash", "-c",
                  "bash %s && bash %s && mkdir -p %s && printf '%%s' %s > %s"
                  % (_shq(harden), _shq(ux),
                     _shq(comp["install_dir"]), _shq(version),
                     _shq(comp["version_file"])))
    if res is None or res.returncode != 0:
        return False, S["need_permission"]
    return True, "ok"


def sums_url_for(api_base, owner, comp, release):
    for asset in release.get("assets", []):
        if asset.get("name") == comp.get("sums_asset", "SHA256SUMS"):
            return asset.get("browser_download_url")
    return None


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
            self.root.after(0, lambda: done(out) if done else None)
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
                self.root.after(0, lambda i=i: self.set_progress(
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
                    self.root.after(0, lambda c=comp: self.set_row(
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
        self.root.after(0, lambda: self.set_progress(text, frac))

    def _say_threadsafe(self, text, frac):
        # called from the worker thread already via _say; direct call is fine
        # because set_progress only touches widgets through after().
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
