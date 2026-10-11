# apps/ — Linux builds for Aeon OS Berk

Finished Linux builds land here, **one subdirectory per app**, placed by the
build agents working on each app. Do not hand-edit another agent's build
output.

Each app directory should contain the distributable build artifacts
(`.deb` preferred — they feed `repo/pool/` — plus any build notes).

The per-app Linux support matrix is [`APP_SUPPORT.md`](APP_SUPPORT.md)
(**DRAFT** — the coordinator finalizes it).

Packagers: the exact plain-language `Name=` / `Comment=` for your app's
`.desktop` file is specified in [`../UX.md`](../UX.md) §2. Set it at build
time.
