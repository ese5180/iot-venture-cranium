# Raspberry Pi: operating system and over-the-air updates

The Raspberry Pi runs the DJ software, [Mixxx](https://github.com/mixxxdj/mixxx), and the
screen; the nRF board handles the rest. This page lists the ways to run Linux on the Pi so
that it can be updated over the air (OTA) as safely as the nRF board, checks each one
against what Mixxx needs, and records the choice. **Status: decided.** The Pi runs
Raspberry Pi OS and is updated with RAUC through the AWS IoT console that already updates
the nRF board (option 7, see [Decision](#decision)). Nothing of it is built yet, and boot
time still has to be measured (see [Open questions](#open-questions)).

## The problem

Raspberry Pi OS (Debian-based) runs the software today, but its normal update path is
`apt upgrade`: many files replaced in place on the running system. If power or
Wi-Fi drops halfway, the Pi can be left unbootable with no copy to fall back to. That
fails the bar the nRF board already meets with MCUboot: a new image is checked before it
runs, and a bad one is rolled back.

Debian itself is not the obstacle. What is missing is an *image-based* update with two
copies of the system, which every option below adds in some form.

## Requirements

Taken from the README's requirement tables and manual section 3.5.5. The manual asks for
FOTA on the nRF board only; applying 3.5.5 to the Pi is our own choice.

| ID | Requirement | Source |
| --- | --- | --- |
| P1 | Runs Mixxx with two decks and effects, and drives the built-in screen. | SRS 02, HW 02 |
| P2 | Talks to the nRF board over UART (heartbeat, battery level). | SRS 03 |
| P3 | Ready to use within 30 s of power-on. | SRS 01 |
| P4 | A shutdown on low battery leaves no filesystem corruption. | SRS 05 |
| P5 | Installs an update only if it is signed with our key. | 3.5.5, invalid signature |
| P6 | Returns to the previous version by itself if a signed update fails to boot or start. | 3.5.5, faulty code with a valid signature |
| P7 | A corrupted or interrupted download leaves the running system untouched. | 3.5.5, corrupted download |
| P8 | Keeps the music library and settings across updates. | SRS 04 |
| P9 | Updated over Wi-Fi, ideally from the same console as the nRF board. | [aws-iot.md](aws-iot.md) |
| P10 | Starts an update only after the user confirms it, and never while audio is playing. | SEC 04 |

## How an A/B update works

Options 1 to 5 and 7 all follow the same pattern (Figure 1).

```
  SD card
  ┌────────┬──────────────┬──────────────┬─────────────────────┐
  │ boot   │ system A     │ system B     │ data                │
  │        │ (running)    │ (spare)      │ Mixxx settings and  │
  │        │              │              │ library (~/.mixxx)  │
  └────────┴──────────────┴──────────────┴─────────────────────┘

  1. Download the update, check its signature, write it to B.   A is never touched.
  2. Reboot into B once, on trial.
  3. A health check (Mixxx has opened its audio outputs, UART heartbeat answered)
     marks B good. No boot, or no "good" within the time limit: the next boot goes
     back to A.
```

*Figure 1: two copies of the system plus a data partition that updates never overwrite.*

With the Pi's own A/B booting (option 7) each copy also has its own boot partition,
because the kernel and `config.txt` live on the boot partition.

Step 1 covers P5 and P7; steps 2 and 3 cover P6; the data partition covers P8. Step 1
starts only after the user confirms the update and no deck is playing (P10). A system
partition that is mounted read-only also helps P4, since a sudden power cut can then only
affect the data partition. It does not protect what Mixxx has not yet saved (see
[Shutdown and power loss](#shutdown-and-power-loss)).

## What Mixxx needs

Mixxx is a Qt 6 desktop application under GPL-2.0-or-later. Its README names its
platforms as GNU/Linux, Windows and macOS; the Raspberry Pi is not one it tests on, so
problems specific to the Pi are ours to find. The points below change the options that
follow. Source files are cited from Mixxx's `main` branch on 2026-10-24 unless a version
is named.

### Version and where to get it

The latest stable release is 2.5.6 (tagged 2026-03-25). 2.5.7 is being prepared; it fixes
analysis data lost at shutdown (#16064) and finds rekordbox exports in a hidden `.PIONEER`
folder (#16895). 2.6 exists only as a beta, and mixxx.org says beta snapshots "are not
intended for live use". The DDJ-FLX4 mapping has been built in since 2.4.0. Ship 2.5.4 or
later: 2.5.2 and 2.5.4 fix problems with rekordbox USB drives, which SRS 04 relies on.

| Source | Version | Notes |
| --- | --- | --- |
| Debian 13 trixie (`apt` on Raspberry Pi OS) | 2.5.0 | Lacks the 2.5.2 and 2.5.4 rekordbox fixes; built without the KeyFinder key detector. Raspberry Pi's own archive has no Mixxx. |
| Debian testing (forky) | 2.5.6 | Not a stable Debian release. |
| Mixxx PPA | 2.5.6 | arm64, but built for Ubuntu, not Raspberry Pi OS. |
| Flathub | 2.5.6 | aarch64. mixxx.org calls it "currently unmaintained". The KDE runtime it needs adds about 1.1 GB installed. |
| Built from a release tag | Any | `fayaaz/mixxx-pi-gen` builds a .deb on Raspberry Pi OS trixie with Debian's libraries. |
| Yocto | None maintained | Newest in the OpenEmbedded index: 2.3.2 on Qt 5 (`meta-musicians`, last changed 2022). See option 2 for a one-person Qt 6 layer. |
| Buildroot | None | No package, and none ever submitted. |
| Snap Store | 2.5.6 | Only `mixxx-unofficial`, from an unverified publisher (2026-10-23). See option 5. |

*Table 1: where an arm64 build of Mixxx comes from, checked on 2026-10-25.*

### Screen

- Mixxx draws its waveforms with OpenGL 2.1 or OpenGL ES 2.0 or later. Mesa's V3D driver
  covers the Pi 4 and Pi 5; a Pi 5 reports OpenGL 3.1 to Mixxx (issue #14072).
- It needs a display server. Without one (Qt's eglfs), Mixxx 2.6 starts without OpenGL,
  and a maintainer calls it "unusable laggy" (#15863); 2.5 does not handle eglfs at all.
  Every option therefore needs X11 or a Wayland compositor such as labwc, sway or Weston.
- Under native Wayland, Mixxx 2.6 warns that waveforms may render badly and recommends
  XWayland (`QT_QPA_PLATFORM=xcb`); Debian's menu entry already starts it that way. On a
  Pi, `mixxx-pi-gen` found the opposite: XWayland gave "terrible waveform and graphical
  performance" and native Wayland fixed it (its issue #102). Both need measuring.
- The bundled skins need at least 1008×500 pixels (the default, LateNight, 1280×668). A
  7-inch 800×480 panel needs a custom skin or UI scaling.

### Where Mixxx keeps its data

- Everything is in one directory, `~/.mixxx/`; Mixxx does not use the XDG folders on
  Linux. `mixxx --settings-path /data/mixxx/` moves it to the data partition (P8). It holds
  `mixxxdb.sqlite` (library, cue points, loops, playlists, crates), `mixxx.cfg`,
  `soundconfig.xml`, `effects.xml`, `samplers.xml`, `controllers/`, `analysis/` and the
  logs. The whole directory belongs on the data partition.
- Outside it, Mixxx writes recordings (`~/Music/Mixxx/Recordings` by default), Qt's file
  dialogs write `~/.config/QtProject.conf`, and Mesa caches shaders in
  `~/.cache/mesa_shader_cache`. With a read-only system partition (P4), `HOME` or the XDG
  variables must point at the data partition or a tmpfs.
- Track locations and library folders are stored as absolute paths, and so is the
  controller mapping chosen in `mixxx.cfg`. Both system copies must mount USB drives at
  the same path and install Mixxx under the same prefix; otherwise, after an update or a
  rollback, tracks show as missing or the FLX4 silently stops working.
- Mixxx looks for rekordbox USB drives only under `/media`, `/media/$USER` and
  `/run/media/$USER`, so the automounter must mount drives there, on a path that stays
  writable when the system partition is read-only.
- Logs grow to 11 files of up to 100 MB each by default; `--log-max-file-size` bounds them.
- If the data partition is not mounted, Mixxx on a writable system partition silently
  creates an empty profile at the `--settings-path` location. The service should depend on
  the mount (systemd `RequiresMountsFor=`).

### Across versions and rollbacks

- The library database is at schema 39 in 2.5 and 2.6 and at 40 on `main`. Every revision
  since 7 declares `min_compatible="3"` (`res/schema.xml`), so an older Mixxx still opens a
  database a newer one has upgraded, and a rollback does not lock the library (P6, P8). A
  future revision could raise that value; check it before shipping a new Mixxx version.
- Settings upgrades are one way. Moving to 2.6 rewrites the waveform settings and runs a
  library repair, and after a rollback to 2.5 and a new update it happens again. The
  manual does not guarantee that settings from a newer version work on an older one.
- Mixxx makes no backup of its own. Before installing an update that changes the Mixxx
  version, the updater should copy the settings directory (without `analysis/`) so that a
  rollback can restore it.
- If the two system copies support different file formats (built with or without FFmpeg,
  for example), Mixxx rescans the whole library at the next start, which slows that boot
  (P3). Keep the build options the same.

### Shutdown and power loss

- Mixxx has no handler for SIGTERM, the signal `systemctl stop` and a normal power-off
  send. It then ends without saving.
- It saves `mixxx.cfg`, `effects.xml` and `samplers.xml` only when it quits cleanly. Hot
  cue and beat grid changes to a track still loaded in a deck reach the database only when
  the track is unloaded or Mixxx quits; a maintainer confirms they are lost if Mixxx is
  killed or crashes (#15767).
- `mixxx.cfg` is saved by writing a temporary file, deleting the old file and renaming,
  with no `fsync` (`src/preferences/configobject.cpp`). A power cut in between leaves no
  `mixxx.cfg`, and Mixxx then starts as if for the first time, with the FLX4 not set up.
- The database itself uses SQLite's defaults (rollback journal, `synchronous=FULL`), so
  committed changes survive a power cut as long as the SD card honours flushes.
- Mixxx quits cleanly only through its window (closing it, or Ctrl+Q). If a deck or
  sampler is playing it first asks "A deck is currently playing. Exit Mixxx?", default No.

The low-battery shutdown (P4, SRS 05) must therefore stop playback, close the Mixxx window,
wait for the process to end, run `sync`, then power off. A Mixxx build of our own could
instead quit cleanly on SIGTERM with a small patch. A factory copy of `mixxx.cfg` and
`soundconfig.xml` on the system partition can be restored when the copy on the data
partition is missing or empty.

### Health check

- Mixxx has no systemd notification, D-Bus or MPRIS service, OSC, or network interface to
  ask whether it is working. Pull requests for OSC and MPRIS are open, not merged.
- A running process is not enough. Mixxx keeps running behind a dialog when its audio
  device is missing or busy, when it starts without a music folder, or when the database
  cannot be opened. On Raspberry Pi OS trixie the FLX4 has appeared on USB after a reboot
  but not as an audio device until it was plugged in again (#16201; a powered hub fixed
  it). Choosing "Exit" in the audio-device dialog ends Mixxx with status 0, which systemd
  counts as success.
- Two signals do show that Mixxx is working:
  - Its log lines "N output sound devices opened" and "Opening controller: ...", written
    at once if Mixxx runs with `--log-flush-level debug`.
  - A small controller mapping on a virtual MIDI port (Linux `snd-virmidi`) whose script
    reports, once a second, `[SoundManager],status` and whether each deck is playing.
    Controller scripts can already do this; it has not been tried on the Pi.
- Mixxx exiting at all during the trial boot counts as a failure.

### Not while audio is playing

Mixxx keeps its audio stream running while idle, so the state of the ALSA or PipeWire
device does not show whether a deck is playing (P10). Either the heartbeat mapping above
reports `[ChannelN],play` and `[SamplerN],play`, or the simpler rule applies: the update
starts only after the user has confirmed it and Mixxx has been quit.

### Kiosk settings

Each image ships a ready-made data partition so that Mixxx starts straight into use
(P1, P3):

- `mixxx.cfg` with the FLX4 enabled and its mapping chosen, full screen
  (`[Config] StartInFullscreen`), `[Config] show_menubar_hint=0` (otherwise a dialog asks
  about the menu bar at start-up) and the library rescan at start-up off.
- `soundconfig.xml` with the audio outputs set.
- A database that already lists the USB mount point as a library folder; otherwise Mixxx
  asks for a music folder at first start.
- The service allowed real-time scheduling; Mixxx asks for priority 82 for its audio
  thread.

### Licence

- Mixxx is GPL-2.0-or-later and its bundled skins are CC BY-SA 3.0, so every image we ship
  must come with Mixxx's source code or a written offer of it.
- A default build also compiles in code that is GPLv3 only (`lib/xwax`, used for vinyl
  control), and Qt is LGPLv3. For consumer devices, GPLv3 and LGPLv3 require "Installation
  Information" that lets the owner install modified versions. That conflicts with
  accepting only images signed with our key (P5). Whether a build with
  `-DVINYLCONTROL=OFF`, using Qt under its GPLv2 option, avoids this needs a legal check.

## Options

### 1. Raspberry Pi OS + Mender

Build a Raspberry Pi OS image with Mixxx, then `mender-convert` turns it into an A/B image
with the Mender client. Updates are signed Mender artifacts; the client rolls back if the
new system does not come up.

**Pros**
- Mixxx installs as on any Pi: `apt install mixxx`, or a .deb built from a newer release
  tag (P1, P2).
- Full-system A/B updates with automatic rollback (P6, P7).
- `mender-convert` 5.3.0 supports the Pi 4 and Pi 5 on 64-bit Raspberry Pi OS bookworm and
  trixie, so the Pi model does not matter.
- The image can be built by script with `pi-gen`, as `fayaaz/mixxx-pi-gen` does for Mixxx,
  so all four MVP devices get the same image.
- Artifact signing is part of every Mender plan, including the free open-source server.
- Server is either self-hosted (open source, free) or hosted by Mender, with a free
  12-month trial.
- Can also send small application-only updates.

**Cons**
- A second update server next to AWS IoT: two consoles, two device identities (P9).
- Signing has to be switched on: each artifact is signed (`mender-artifact sign`) and the
  Pi is given the public key (`ArtifactVerifyKey`) (P5). Use `mender-convert` 5.2.1 or
  later, which fixed artifacts that could not be signed and validated.
- Debian images are large: the `mixxx-pi-gen` images (desktop plus Mixxx) are 1.8 to 2.0 GB
  compressed, and a full update carries the whole system partition.
- Hosted Mender costs $34/month for up to 50 devices (Basic plan) after the trial.
- Boot time is a risk (P3). A stock Raspberry Pi OS desktop took 37 s to boot on a Pi 4
  (Hackaday, bookworm), and Decktano, a product built on a Pi 5, Raspberry Pi OS and Mixxx,
  says it is ready "about a minute" after switch-on. The image needs trimming: Raspberry Pi
  OS Lite plus a kiosk compositor.
- On the Pi 5, `mender-convert` boots through its own U-Boot build with the boot delay
  removed, which it logs as a workaround.
- Root filesystem stays read-write by default (P4). `mender-convert` can change the mount
  options; whether the system and Mixxx run read-only is untested.
- `apt` gives Mixxx 2.5.0, without the rekordbox fixes (SRS 04); 2.5.4 or later means
  building the .deb ourselves.

### 2. Yocto + RAUC

Build a custom Linux with Yocto (lecture L02), using the `meta-raspberrypi` layer and
RAUC (Robust Auto-Update Controller) for A/B updates. `meta-rauc-community` has a
Raspberry Pi example.

**Pros**
- A minimal image built from source files in the repository; every device gets the same
  image. This is the usual approach for commercial Linux products.
- RAUC refuses unsigned bundles; signing is not optional (P5).
- A read-only system partition is one image feature (`read-only-rootfs`) (P4).
- RAUC has no server of its own, so the existing AWS IoT stack can drive it (P9): an AWS
  IoT job tells the Pi to fetch a signed bundle from S3, and an update agent on the Pi
  runs `rauc install`. One console updates both boards.
- Only what we include is on the device, so there is less to attack than on full Debian.
- Qt 6 with every module Mixxx needs comes from `meta-qt6` (open-source branch 6.12, for
  the scarthgap and wrynose releases), and most of Mixxx's other libraries from `meta-oe`.
- Eclipse Oniro's "DJ station" blueprint (2022, Yocto kirkstone, Pi 4) booted straight into
  Mixxx with A/B system partitions and a data partition for Mixxx's settings: the layout of
  Figure 1.
- Covered in lecture L02, which makes it easy to justify in the report.

**Cons**
- Steepest learning curve of the seven.
- No maintained Mixxx recipe. The only Qt 6 one is in `kiki442002/mixxx-os`, a one-person
  layer (Mixxx 2.5.6, scarthgap, Pi 4 only, musl libc, no update support, last changed
  May 2026). It adds eight library recipes that no maintained layer has (portmidi,
  rubberband, chromaprint, libebur128, soundtouch, libkeyfinder, libdjinterop, libmp4v2)
  and patches Mixxx's OpenGL detection. Whether its image runs was not checked. Using it
  means keeping those recipes working across Yocto upgrades.
- Needs a compositor in the image (Weston, as in `mixxx-os` and Oniro); see
  [Screen](#screen).
- `meta-raspberrypi` supports the Pi 5, but the RAUC example layer needs an extra U-Boot
  layer for it and is tested in CI on the Pi 4 only.
- Builds need a Linux host with at least 140 GB free disk and 32 GB of RAM (Yocto Quick
  Build, 6.0 docs; the 5.0 docs ask for 90 GB and 8 GB). The laptop used for nRF builds had
  20 GB free on 2026-10-25, so this means a Linux PC or a cloud build machine. First build
  takes hours.
- The console and an update agent on the Pi need new work (job document for the Pi,
  device group, health check that calls `rauc status mark-good`).
- Every change to the software means rebuilding the image: slow while the app is still
  changing.

### 3. Buildroot + RAUC or SWUpdate

Same idea as option 2 with Buildroot (also in lecture L02). Both RAUC and SWUpdate are
Buildroot packages.

**Pros**
- Simpler than Yocto (one configuration menu and Makefiles); faster builds.
- Small images: small downloads, fast boot (P3), although Mixxx still brings Qt 6, Mesa
  and a compositor.
- Same signed, AWS-driven update path as option 2 (P5, P9). With SWUpdate, signing is a
  build option that must be switched on.
- A read-only system partition is one configuration setting (P4).
- Qt 6.11 with every module Mixxx needs is packaged, as are some audio libraries
  `meta-oe` lacks (lilv, SoundTouch).

**Cons**
- No Mixxx package, and nothing to start from. Besides Mixxx itself we would package
  portmidi, rubberband, chromaprint, libebur128 and Microsoft GSL, plus libkeyfinder,
  libdjinterop and QtKeychain or build Mixxx without them.
- Far fewer ready-made packages than Yocto; anything missing we package ourselves.
- No package manager; many configuration changes need a full clean rebuild.
- Also needs a Linux build host.

### 4. balenaOS + balenaCloud

balena maintains and updates the operating system; our software runs in a Docker
container managed from balenaCloud.

**Pros**
- The container can be Debian-based, so Mixxx installs with `apt` as on a Pi (P1).
- An app update is a new container; only changed layers are downloaded.
- Host OS updates roll back on their own if the new OS does not boot or its health
  check fails.
- Dashboard, remote shell and logs included.
- Fast development loop: push from a laptop.
- Free for the first 10 devices (balena pricing page), enough for four MVP devices.
- balenaOS supports the Pi 4 and Pi 5.

**Cons**
- Devices are managed from balenaCloud, not our AWS console (P9).
- No ready-made Mixxx container exists. The screen needs balena's Weston display block
  (its X11 block was archived in 2023) and the Qt Wayland plugin in our container; audio,
  MIDI and the UART to the nRF board need a privileged container. balena's UART guide
  covers only the Pi 3 (P1, P2).
- We do not hold a signing key; trust rests on balena's servers (P5 not met as written).
- The OS rollback health check looks at balena's own services, not our app; an app
  release that starts but misbehaves is not rolled back by it (P6 partly).
- balenaOS for the Pi is built on Yocto kirkstone, which is past its end of life, so the
  host's security fixes depend on balena's own backports.
- openBalena (self-hosted) has fewer features than balenaCloud.
- Containers add some storage and memory overhead.

### 5. Ubuntu Core + snaps

An operating system made only of signed, read-only snaps. Every update is transactional
and reverts if it fails. Ubuntu Core 24 and 26 support the Raspberry Pi 4 and 5
(Canonical), though Canonical presents its Pi images for evaluation; a product uses its own
image.

**Pros**
- Atomic updates and automatic revert for the OS and for apps (P6, P7).
- Read-only base, sandboxed apps, every snap signed (P4, P5).
- Canonical provides OS security updates for years.
- Ubuntu Frame is Canonical's supported way to run one app full screen.

**Cons**
- No official Mixxx snap. The only one, `mixxx-unofficial` (published 2026-10-23 by an
  unverified publisher), is a desktop snap that cannot run on Ubuntu Core as it is. We
  would write our own: a service under Ubuntu Frame, with access to the screen, audio and
  USB granted by hand or in the device model. `snapcraft` takes time to learn.
- The sandbox must be explicitly opened for the screen, audio and serial port (P1, P2).
- Updates go through the Snap Store; a private store needs paid set-up from Canonical
  (from $3,000, store fee not published), and none of it uses our AWS stack (P9).
- The device model can be signed with our key, but snaps are signed by the store; signing
  them ourselves needs Canonical's paid on-premises store.
- Smaller community for Pi-specific embedded problems.

### 6. Raspberry Pi OS + AWS IoT Greengrass or AWS IoT jobs (application only)

Keep Raspberry Pi OS as it is and update only the DJ software, through AWS IoT
Greengrass components or plain AWS IoT jobs.

**Pros**
- Reuses the AWS stack directly; one console for both boards (P9).
- Mixxx installs and runs as on any Pi (P1, P2).
- An application-only update is small: the Mixxx package is about 15 MB to download.
- Least new work of the seven.

**Cons**
- Updates the application only; the OS and kernel cannot be updated safely or rolled
  back (P6, P7 for the OS).
- OS updates stay the unsafe `apt` kind.
- Root filesystem stays read-write (P4).
- Standard Greengrass runs on Java: 96 MB RAM for Greengrass alone, 512 MB recommended
  for the device (AWS docs). The C-based Greengrass nucleus lite needs about 5 MB.
- Weakest answer to the security part of the assignment.

### 7. Raspberry Pi OS + RAUC, driven by AWS IoT jobs (chosen)

Keep Raspberry Pi OS, lay the SD card out as in Figure 1, and let RAUC install signed
bundles into the spare copy. The Pi's own bootloader switches between the copies: with
`tryboot_a_b=1` in `autoboot.txt`, `reboot "0 tryboot"` starts the other copy once, and a
normal reboot goes back unless the update is committed. The AWS IoT jobs, S3 bucket and
console that update the nRF board deliver the bundles.

**Pros**
- Mixxx installs as on any Pi, as in option 1 (P1, P2).
- One console and one way of identifying devices for both boards (P9).
- RAUC refuses unsigned bundles (P5). Debian 13 packages it (`rauc` 1.13), so it installs
  with `apt`.
- Full-system A/B updates with rollback through the bootloader's trial boot (P6, P7).
- No second server and no subscription.
- The same signed-image approach as MCUboot on the nRF board, which is easy to explain in
  the report.

**Cons**
- More of our own work than option 1: the partition layout, a RAUC bootloader backend
  for the Pi's trial boot (or U-Boot instead), an update agent on the Pi, and changes to
  the console (see [Decision](#decision)).
- The console takes an image as base64 in the API request, up to 1.4 MB
  (`UPLOAD_BODY_LIMIT` in `cloud/api/src/handlers/firmware.mjs`). A Pi bundle of hundreds
  of megabytes has to go straight to S3 and be checked there.
- Each update carries a whole system copy over Wi-Fi.
- The Pi has nothing like the nRF board's TF-M storage, so its device key is a file.
- A read-only system partition is possible but untested with Mixxx and the compositor (P4).

## Comparison

| | Getting Mixxx | Signed with our key | OS rollback | Our AWS console | Read-only system | Effort |
| --- | --- | --- | --- | --- | --- | --- |
| 1. Pi OS + Mender | `apt` or own .deb | Yes, once enabled | Yes | No | No | Low |
| 2. Yocto + RAUC | Third-party recipe only | Yes, required | Yes | Yes | Yes | High |
| 3. Buildroot + RAUC/SWUpdate | Package it ourselves | Yes (SWUpdate: once enabled) | Yes | Yes | Yes | High |
| 4. balenaOS | `apt` in a container | No | Yes | No | Yes (host OS) | Low–medium |
| 5. Ubuntu Core | Write our own snap | Store-signed | Yes | No | Yes | Medium–high |
| 6. Pi OS + Greengrass/jobs | `apt` or own .deb | App only | No | Yes | No | Low |
| **7. Pi OS + RAUC + AWS jobs** | `apt` or own .deb | Yes, required | Yes | Yes | Possible, untested | Medium |

*Table 2: how each option meets the requirements above. The Mixxx work in
[What Mixxx needs](#what-mixxx-needs) is the same for every option, so it has no column.*

## Decision

The team chose **option 7: Raspberry Pi OS, updated with RAUC through the AWS IoT console**
that already updates the nRF board. Yocto (option 2) was the first candidate, but no
maintained Mixxx recipe exists. Mender (option 1) would be quicker to set up, but needs a
second server and console. Option 7 keeps one console for both boards, and RAUC requires
signed bundles.

### On the Pi

- **Image.** `pi-gen` builds it from files in the repository: 64-bit Raspberry Pi OS Lite
  (trixie), a kiosk compositor, and Mixxx 2.5.6 (2.5.7 once released) built as a .deb from
  its release tag. A final step lays out the card: boot A, system A, boot B, system B and
  the data partition.
- **Switching copies.** `autoboot.txt` with `tryboot_a_b=1`. RAUC installs into the spare
  copy and reboots with `reboot "0 tryboot"`. If the health check passes, the update is
  committed by making the new copy the default in `autoboot.txt` and running
  `rauc status mark-good`; otherwise a normal reboot returns to the old copy. The Pi's
  hardware watchdog (systemd `RuntimeWatchdogSec`) turns a hung trial boot into that
  reboot. RAUC needs a small backend for this; U-Boot is the fallback if it proves awkward.
- **Update agent.** A Python service using the AWS IoT Device SDK that follows the nRF
  board's job flow (`firmware/app/src/ota.c`) with the same job states and shadow
  fields ([aws-iot.md](aws-iot.md), "An update, message by message"):
  1. The offer stays queued until the user confirms it on the screen and no deck is
     playing (P10).
  2. The agent downloads the bundle to the data partition and checks its SHA-256 before
     anything is installed (P7).
  3. It runs `rauc install`, which checks the signature (P5).
  4. It announces each step and waits for AWS IoT to accept it, as the nRF board does.
  5. It reboots into the trial copy, runs the health check (Mixxx has opened its audio,
     the UART heartbeat answers), commits, and reports success. A copy that is not
     committed reports `rolled_back` from the old copy.

  The AWS IoT Device Client is not used: it runs a job's handler as soon as the job
  arrives, so it cannot keep an offer waiting for the user.
- **Keys.** A RAUC signing key and certificate of their own, kept off the server like the
  MCUboot key. The Pi holds only the certificate it checks against.
- **Identity.** One thing per Pi, with a key generated on the Pi and a certificate made
  from its signing request, as `tools/provision_device.py` does for the nRF board. The
  `cranium-device` policy works unchanged, because its topics are scoped to the thing name.

### In `cloud/`

- **Upload.** A signed upload link puts the bundle straight into S3. A Lambda function
  then checks it there: its signature against our certificate, a compatible string such
  as `cranium-pi`, and a version newer than the last release.
- **Releases and fleets.** nRF and Pi releases are kept apart, and Pis get their own
  thing group, so the console never offers one board's image to the other.
- **Job document.** A `pi_update` document next to `buildJobDocument` in
  `cloud/api/src/lib/jobs.mjs`.
- **Timing.** A download link lasts 10 minutes (`URL_EXPIRES_SEC`). A download that has
  started may run past that; if it breaks, the agent asks for the document again and gets
  a fresh link, as the nRF board does. The job's in-progress timeout of 30 minutes
  (`IN_PROGRESS_TIMEOUT_MIN`) may need raising for an image this size.

Whatever the update mechanism, the Mixxx work in [What Mixxx needs](#what-mixxx-needs)
stays: settings on the data partition, a clean quit before power-off, a health check that
sees Mixxx's audio open, the P10 rule, ready-made settings, and a settings backup before a
Mixxx version change.

A separate experiment, a Zephyr port of the Mixxx engine for the nRF7002 DK, is on the
`feature/mixxx-zephyr` branch. It does not change this design.

## Open questions

- Which Mixxx version to ship: 2.5.6 now, or 2.5.7 when released (shutdown and rekordbox
  fixes). `[TBD: team]`
- Which Pi model (4 or 5)? The Pi 5 is faster, but on a 3 A supply it gives USB devices
  only 600 mA in total, and the FLX4 is powered over USB. `[TBD: team]`
- Is a RAUC backend for the Pi's trial boot enough, or is U-Boot needed?
  `[TBD: prototype]`
- How large a bundle is, and how long it takes to download over the Wi-Fi at a venue.
  `[TBD: measure]`
- Boot-to-ready time on the chosen image, measured against P3. The only figures found:
  37 s for a stock Pi 4 desktop boot, and about a minute for Decktano. `[TBD: measure]`
- Native Wayland or XWayland: which gives smoother waveforms on the Pi. `[TBD: measure]`
- Screen resolution: the bundled skins need 1008×500 or more. `[TBD: team]`
- Does the virtual-MIDI heartbeat mapping work on the Pi? `[TBD: prototype]`
- How long Mixxx takes to quit cleanly, to set the low-battery threshold. `[TBD: measure]`
- Do the GPLv3 and LGPLv3 parts conflict with signed-only updates (P5)?
  `[TBD: legal check]`

## Test plan

On the chosen option, repeat the failure tests used for the nRF board:

1. Update signed with a different key: refused, system unchanged.
2. Update signed with our key whose DJ software does not start: rolled back after the
   health-check time limit.
3. Download cut off halfway, and a bundle with one byte changed: refused, system
   unchanged.
4. Power removed during an update: Pi boots the previous version.
5. Library and settings present after a successful update and after a rollback.

And the cases Mixxx adds:

6. Update to a different Mixxx version, then roll back: the older Mixxx opens the library,
   cue points and playlists are there, and the settings saved before the update are back.
   Then update again.
7. Low-battery shutdown with a deck playing and new hot cues on a loaded track: Mixxx
   quits cleanly, and the cues and settings are there after the next boot.
8. Trial boot where Mixxx cannot open its audio device: the health check fails and the Pi
   rolls back, although Mixxx is running.
9. Update offered while a deck is playing: nothing is installed until the user confirms
   and playback has stopped.
10. Data partition missing at boot: Mixxx does not start with an empty profile.
11. A trial boot that hangs: the watchdog reboots the Pi, and it returns to the previous
    copy.

## Sources

Checked on 2026-10-25.

Mixxx:

- Mixxx source, release 2.5.6 and `main` at 2f4234b (2026-10-24):
  <https://github.com/mixxxdj/mixxx>
- Mixxx downloads: <https://mixxx.org/download/>
- Mixxx manual, settings directory:
  <https://manual.mixxx.org/2.5/en/chapters/appendix/settings_directory>
- Mixxx issues: Mixxx under eglfs <https://github.com/mixxxdj/mixxx/issues/15863>; FLX4
  missing as an audio device after boot <https://github.com/mixxxdj/mixxx/issues/16201>;
  track changes lost when Mixxx is killed <https://github.com/mixxxdj/mixxx/issues/15767>;
  OpenGL on a Pi 5 <https://github.com/mixxxdj/mixxx/issues/14072>
- Debian packages of Mixxx: <https://tracker.debian.org/pkg/mixxx>
- Flathub: <https://flathub.org/apps/org.mixxx.Mixxx>
- Unofficial snap: <https://snapcraft.io/mixxx-unofficial>
- OpenEmbedded layer index, Mixxx recipes:
  <https://layers.openembedded.org/layerindex/api/recipes/?filter=pn:mixxx>
- Third-party Yocto layer: <https://github.com/kiki442002/mixxx-os>
- Oniro DJ station blueprint:
  <https://gitlab.eclipse.org/eclipse/oniro-blueprints/dj-gesture-glove/meta-oniro-blueprints-dj-gesture>
- Buildroot packages: <https://github.com/buildroot/buildroot/tree/master/package>
- Raspberry Pi OS image with Mixxx: <https://github.com/fayaaz/mixxx-pi-gen>, and its
  Wayland report <https://github.com/fayaaz/mixxx-pi-gen/issues/102>
- Decktano: <https://decktano.com/>
- Raspberry Pi 4 boot times on bookworm (Hackaday): <https://hackaday.com/tag/debian-bookworm/>
- Raspberry Pi USB current limits:
  <https://www.raspberrypi.com/documentation/computers/raspberry-pi.html>

Operating systems and updates:

- Yocto Project Quick Build, disk and memory requirements:
  <https://docs.yoctoproject.org/brief-yoctoprojectqs/index.html>
- Mender plans and pricing: <https://mender.io/plans/pricing>
- Mender on the Raspberry Pi 4 and 5:
  <https://docs.mender.io/get-started/preparation/prepare-a-raspberry-pi-device>
- mender-convert changes:
  <https://github.com/mendersoftware/mender-convert/blob/5.3.0/CHANGELOG.md>
- Mender artifact signing: <https://docs.mender.io/artifact-creation/sign-and-verify>
- RAUC examples: <https://rauc.readthedocs.io/en/stable/examples.html>
- RAUC bootloader integration: <https://rauc.readthedocs.io/en/stable/integration.html>
- RAUC in Debian: <https://tracker.debian.org/pkg/rauc>
- Raspberry Pi A/B booting (`autoboot.txt`, `tryboot`):
  <https://www.raspberrypi.com/documentation/computers/config_txt.html#autoboot-txt>
- RAUC Raspberry Pi layer: <https://github.com/rauc/meta-rauc-community>
- Qt 6 for Yocto: <https://code.qt.io/cgit/yocto/meta-qt6.git>
- balena pricing: <https://balena.io/pricing>
- balenaOS rollbacks: <https://docs.balena.io/reference/os/updates/rollbacks>
- balena display block: <https://github.com/balenasolutions/display>
- Ubuntu Core supported platforms:
  <https://documentation.ubuntu.com/core/reference/testing-platforms/>
- Ubuntu Frame: <https://ubuntu.com/frame>
- Greengrass nucleus requirements:
  <https://docs.aws.amazon.com/greengrass/v2/developerguide/setting-up.html>
- Greengrass nucleus lite:
  <https://docs.aws.amazon.com/greengrass/v2/developerguide/greengrass-nucleus-lite-component.html>
- AWS IoT jobs for over-the-air updates:
  <https://aws.amazon.com/blogs/iot/using-device-jobs-for-over-the-air-updates>
