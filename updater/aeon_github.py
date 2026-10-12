#!/usr/bin/env python3
"""aeon_github — shared GitHub release machinery for Aeon OS Berk tools.

Used by the Updates app (berk-updater.py) and the Aeon Store (aeon-store.py).
Pure standard library: no third-party packages.

Contents:
  manifest loading (apps.json), version comparison, GitHub API access,
  file download, mandatory SHA256SUMS verification, and the
  download -> safety-check -> pkexec-install flows for app .debs and the
  Berk system layer.

Safety rule (shared by every tool that imports this): SHA256SUMS is
mandatory. No sums file, or a hash mismatch, means no install, ever.
"""

import fnmatch
import hashlib
import json
import os
import re
import shutil
import subprocess
import tarfile
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
