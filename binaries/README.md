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
  `scripts/ota.sh binaries/cranium-1.7.0-0.signed.bin` installs that one.
- **From the website:** on the console's Firmware page, choose the file here. The server
  checks its signature against the project's public key before it stores anything, and
  then offers to deploy it.

A release must be newer than every release uploaded before it, so set a new version in
`firmware/app/VERSION` before you build. Images built by the test bench, images with a
test fault built in and images built for Bluetooth are not kept here.

**Before a demo on the website.** A file dropped on the console's Firmware page must be newer than
every release ever registered, revoked ones included. Otherwise the console refuses it and names the
highest version it has seen. `latest.signed.bin` is only the newest build, and the same file cannot be
uploaded twice, so it is refused once it has been uploaded, or once anything higher has. So
`latest.signed.bin` needs a higher build first: raise the version in `firmware/app/VERSION`, run
`west build`, and check the version in `latest.json`. Do this before the demo starts.

## From GitHub

A published release on [GitHub](https://github.com/ese5180/f26-t07-the-cranium/releases) holds a signed
image, its `latest.json` and `SHA256SUMS`, made by whoever holds the signing key with
`scripts/github-release.sh`. None has been published yet at the time of this writing. A board and the
console take such an image like one from this folder. To fetch one, for example `v1.7.0`:

```sh
gh release download v1.7.0 --dir release && cd release && shasum -a 256 -c SHA256SUMS
```

The artifacts of the workflow runs in the Actions tab are named `...-ci-key-not-installable`, and
that is what they are. GitHub Actions never has the signing key, so it signs what it builds with a
throwaway key, and MCUboot and the console both refuse those images. They show that a commit builds
and what size it is. [`docs/ci.md`](../docs/ci.md) has the rest.

## `scripts/ota.sh`

```sh
scripts/ota.sh                                      # install binaries/latest.signed.bin
scripts/ota.sh binaries/cranium-1.7.0-0.signed.bin  # install that image
scripts/ota.sh --real-button                        # wait for a person to press Button 1
```

The script needs a signed-in AWS profile. It invokes the console's API function directly. This
bypasses API Gateway and sign-in: there is no token check, no password and no authenticator code.
The function's own checks still run: it asks Cognito whether the named person is an active release
manager, and it checks the signature before it stores anything. The script acts in that person's
name, and the audit entry names them. [`docs/aws-iot.md`](../docs/aws-iot.md#known-limits) has more.

It deploys the image to the board and follows the update until the new firmware has confirmed
itself. Without `--real-button` it presses Button 1 through the board's serial console, so the board
must be on USB. The way with a sign-in is by hand, on the console's Firmware page.
`scripts/open-console.sh` signs in to AWS and opens the console.

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
