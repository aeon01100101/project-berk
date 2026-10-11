# Shipping an update for Aeon OS Berk

This is the whole playbook. Follow it exactly and the "Updates" app on
every Berk machine will find the new version, safety-check it, and offer
it to the user.

## What the updater expects (the contract)

For each app, the updater looks at the **latest GitHub release** of that
app's repository and needs exactly two attached files:

| File | Example | Rule |
|---|---|---|
| The install file | `music_1.0.5_amd64.deb` | Name must match the `asset_pattern` in `updater/apps.json` (e.g. `music_*_amd64.deb`). **Only `.deb` files are ever installed.** |
| The checksum file | `SHA256SUMS` | Must list the `.deb`'s SHA-256 hash. **No checksums = no install, ever.** |

The release **tag** must be `v` + the version, e.g. `v1.0.5`. The updater
compares it against `/opt/<app>/version.txt` on the machine. A pre-release
tag like `v1.0.6-beta` counts as *older* than `v1.0.6`, so beta testers
upgrade cleanly to the final.

For the **Berk system** entry the same contract holds, except the install
file is a tarball named `berk-system_<version>.tar.gz` whose top level
contains exactly: `harden-mint.sh`, `apply-ux.sh`, `version.txt`.

## Your GitHub setup (one time)

1. In `updater/apps.json`, set `github_owner` to your real GitHub user or
   organization name. That is the only place it appears.
2. Create one repository per app, named as the `repo` field says
   (`aeonradio`, `aeoncodenet`, `aeonphoto`, `aeonobj`, `aeoncraft`,
   `enigma-launcher`, plus `project-berk` for the system layer).

## Shipping an app update (every time)

Say Music (Aeon Radio) is at 1.0.5 and you fixed something:

```bash
cd ~/workspace/aeonos-berk/updater

# 1. Build the .deb (this also stamps version.txt inside it)
./make-deb.sh music 1.0.6 --out debs/

# 2. Make the checksum file (name it exactly SHA256SUMS)
cd debs
sha256sum berk-music_1.0.6_amd64.deb > SHA256SUMS
cd ..

# 3. On GitHub: that repo -> Releases -> "Draft a new release"
#    - Tag: v1.0.6   (the v matters)
#    - Title: anything friendly, e.g. "Music 1.0.6"
#    - Attach BOTH files: the .deb and SHA256SUMS
#    - Publish.
```

Done. Within the hour, Berk machines running the updater will see
"Update ready" next to Music.

App ids for step 1: `music`, `code-maker`, `picture-maker`, `3d-maker`,
`aeoncraft`, `minecraft`. The file names must match `asset_pattern` in
`apps.json` (e.g. `code-maker_2.1.0_amd64.deb`).

## Shipping a Berk system update

```bash
cd ~/workspace/aeonos-berk
mkdir -p /tmp/sysrel
cp scripts/harden-mint.sh cubic/berk-simple/apply-ux.sh /tmp/sysrel/
echo -n "1.3.0" > /tmp/sysrel/version.txt
tar -czf updater/debs/berk-system_1.3.0.tar.gz -C /tmp/sysrel \
    harden-mint.sh apply-ux.sh version.txt
cd updater/debs
sha256sum berk-system_1.3.0.tar.gz > SHA256SUMS
# attach both files to a new release tagged v1.3.0 in the project-berk repo
```

On the machine, the updater downloads the tarball, checks the hash, then
re-runs `harden-mint.sh` and `apply-ux.sh` (both are idempotent — safe to
run again). Progress is shown in plain words.

## Rules that keep everyone safe

- **Never attach a `.deb` without `SHA256SUMS`.** The updater will refuse
  to install it, and users will see that it "didn't pass its safety check".
- **Never rename the assets.** The patterns in `apps.json` are the contract;
  if you change a name, update `apps.json` in the same release.
- **Always build with `make-deb.sh`.** It stamps `version.txt`, fixes the
  menu entry to the plain-language name, and sets permissions. A hand-made
  `.deb` that forgets `version.txt` will look "not installed" forever.
- Test the release first: point `BERK_GH_API` at a local copy if you want,
  or just run `berk-updater.py --dry-run` on a Berk machine — it downloads
  and safety-checks everything without installing.
