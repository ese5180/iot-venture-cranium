# binaries

Every `west build` of this checkout stores its signed image here, by itself. Git ignores
everything in this folder except this file.

| File | What it is |
| --- | --- |
| `latest.signed.bin` | The newest build |
| `latest.json` | Its version, size, SHA-256, git commit and build time |
| `cranium-<version>-<build>.signed.bin` | Each version, the newest ten of them |
| `golden/cranium-<version>-<build>.signed.bin` | The frozen golden image. Only `tools/golden.py freeze` puts it there, and nothing removes it: a build never touches this folder |
| `golden/mcuboot-before-golden.hex` | The bootloader that was on the board before the golden image, kept as the way back |

Two ways to put an image on a board over the air:

- **From the command line:** `scripts/ota.sh` installs the newest build, and
  `scripts/ota.sh binaries/cranium-1.2.0-0.signed.bin` installs that one.
- **From the website:** on the console's Firmware page, choose the file here. The server
  checks its signature against the project's public key before it stores anything, and
  then offers to deploy it.

A release must be newer than every release uploaded before it, so set a new version in
`firmware/app/VERSION` before you build. Images built by the test bench and images with a
test fault built in are not kept here.

## The golden image

`golden/` holds the one image a board can always go back to: see
[`firmware/README.md`](../firmware/README.md#golden-image). Git ignores it like everything else here,
because the repository is public, so `firmware/golden.json` and the bootloader's `prj.conf` are all
that git has of it. They hold its digest, which a build of the bootloader pins. Treat this file as
irreplaceable: a rebuild of the same commit does not need to come out the same, and only a file with
that digest can be restored. Keep a copy with whoever holds the signing key. The console is no place
for a spare: it has no way to give a file back, and it refuses a version older than any it has seen.

`python tools/golden.py check` says whether this file, the manifest and the bootloader's configuration
agree, and `python tools/golden.py restore --reset` checks that first and then sends the file through
serial recovery, with no Wi-Fi.
