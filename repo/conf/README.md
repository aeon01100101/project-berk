# repo/conf/ — client configuration and notes

## For Berk machines: adding the Aeon repo

1. Get the repo signing key (`aeon-berk-archive-keyring.gpg`) from Isaiah's
   distribution channel and verify its fingerprint out-of-band before
   trusting it.
2. Install it:
   ```bash
   sudo install -m 0644 aeon-berk-archive-keyring.gpg /usr/share/keyrings/
   ```
3. Install the sources entry:
   ```bash
   sudo install -m 0644 conf/aeon-berk.sources /etc/apt/sources.list.d/aeon-berk.sources
   sudo apt update
   ```

## For repo maintainers

- Drop first-party `.deb` files into `repo/pool/` and run
  `repo/build-repo.sh` (set `GPGKEY=` to sign). Metadata lands in
  `repo/dists/` — never hand-edit it.
- Serve the `repo/` directory over HTTPS with any static web server.
- `aeon-berk.sources` (next to this file) is the DEB822 client entry.
  `URIs:` must be updated to the real repo URL before distribution —
  `https://repo.aeon.example/berk` is a placeholder domain.
