# scripts

## The ones you run

| Script | What it does |
| --- | --- |
| `build.sh` | Builds the firmware with the next unused version, and leaves the signed image in `binaries/` |
| `ota.sh` | Installs an image from `binaries/` on the board over the air, and follows it to the end. With no USB, it follows through the cloud |
| `open-console.sh` | Signs in to AWS and opens the console |
| `github-release.sh` | Publishes a signed image as a GitHub Release, for whoever holds the signing key |

A normal update is:

```sh
scripts/build.sh    # makes binaries/cranium-<version>-0.signed.bin
scripts/ota.sh      # installs the newest one, or upload it on the console's Firmware page
```

`build.sh --help` lists its options. Run them from a normal terminal: they load the nRF Connect SDK toolchain themselves.

## Used by CI and the other scripts

| Script | What it does |
| --- | --- |
| `scan-tracked-files.sh` | Fails if a tracked file holds a private key or Wi-Fi secrets |
| `check-west-workspace.sh` | Checks CI's cached SDK against the pinned version |
| `verify-github-release.sh` | Checks a published release's files |
| `release-lib.sh` | Checks shared by the two release scripts |

## Where things go

| Folder | What's in it | In git? |
| --- | --- | --- |
| `binaries/` | Every build's signed image, and `latest.*` pointing at the newest | No, only its README |
| `binaries/golden/` | The frozen golden image. Irreplaceable: see `binaries/README.md` | No |
| `build/` | The last build's working files, and `last-build.log` | No |
| `build-bench/` | Test images and their builds | No |
| `build-hil/` | Test bench logs and results | No |
| `ota-demo/` | Demo images and the checkoff study guide, on this Mac only | No |
