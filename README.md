# ESE5180: IoT Venture

**Team Number: T07**

**Team Name: Cranium**

| Team Member Name   | Email Address                  |
| ------------------ | ------------------------------ |
| Demetrius Bosket   | dbosket@engineering.upenn.edu  |
| Adam Shalabi       | adamshal@engineering.upenn.edu |
| Christian Durante  | cgd2@engineering.upenn.edu     |
| Vihaan Ravishankar | vihaan1@engineering.upenn.edu  |

**GitHub Repository URL: https://github.com/ese5180/f26-t07-the-cranium**

## Concept Development

- **Create a device block diagram that details the power architecture, microcontroller, & peripherals**
  ![Block diagram](<./pics/Block Diagram.png>)
- **Create a communication diagram**
  ![Communication diagram](<./pics/Communication Diagram.png>)

### Product Function

We are developing a mounted attachment to beginner DJ controllers in order to remove reliance on a laptop. This solution will be more familiar, cost-effective, and sustainable than directly upgrading these popular controllers to all-in-one DJ systems. The device will utilize BLE audio to challenge typical issues with wireless audio as well as a secondary board in a Raspberry Pi to develop more robust display support at our price and time range.

### Target Market & Demographics

- **Who will be using your product?** New and intermediate FLX4 DJs.
- **Who will be purchasing your product?** FLX4 owners seeking standalone capability + their friends and family as gifts.
- **Where would you deploy your product?** U.S. first through online D2C, then globally.
- **How large is the target market?** ~$28M existing U.S. FLX4 market, growing by $7.1M annually.
- **How much do you expect to capture?** ~$1M/year by Year 3 (given 1% adoption at $200/unit).
- **What competitors are already in the space?** Pioneer’s XDJ systems as the traditional standalone alternative, less desirable standalone systems from Numark and Denon, and DeckShark as an early-stage add-on startup.

### Stakeholders Contacted

- Adam:  Customer perspectives of 3 exact target customers (intermediate level Pioneer FLX4 owners who play small/medium live events)
  - Already held interviews, obtained specific pricing perspectives and target DJ controllers.
- (via Chris) Subject Matter Expert: Garrett Treanor (Indiana University - Expertise in Digital Audio Processing, Research in Immersive/Spatial Audio)
- Competitor's (DeckShark) Community Discord - finding additional consumer perspectives and specific failure points of direct competitors.

### System-Level Diagrams

### Security Requirements Specification

| Code   | Name                  | Definition                                                                                                                                                                                                                                                       |
| ------ | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SEC 01 | Firmware Verification | The system shall run only signed firmware images. Firmware images shall be protected from being modified or copied. The development kit waives part of this: see below.                                                                                          |
| SEC 02 | Initialization        | The device shall implement secure boot functionality to prevent unauthorized firmware modifications. The development kit waives part of this: see below.                                                                                                         |
| SEC 03 | BLE Audio             | The BLE connection shall implement authentication and authorization before allowing access to user’s other device(s). The development kit waives part of this: see below.                                                                                        |
| SEC 04 | OTAFU                 | Updates shall be written to an inactive partition, and the device shall automatically roll back if the new image fails to boot. Updates shall not begin without user confirmation or while audio is playing. The development kit waives part of this: see below. |
| SEC 05 | Physical Security     | The enclosure shall be spill-resistant and include a lock slot, with no externally accessible debug headers. The unit shall mount securely to the controller without loading its ports. The development kit waives part of this: see below.                      |
| SEC 06 | Update Console        | Console accounts shall be created by an administrator and shall need a password and an authenticator code. The console shall hold only the public half of the signing key and shall log every attempted change that reaches its API function.                    |

**What the development kit does not meet yet.** The requirements above describe the product. The
nRF7002 DK waives these parts of them. [`docs/aws-iot.md`](docs/aws-iot.md#threat-model) has the
threat model and the known limits.

- **SEC 01, signed images:** this holds for the application core. The network core's blinky is flashed
  over the debug port, and MCUboot does not check it. It has no radio stack and no keys.
- **SEC 01, copying:** a changed image fails the signature check, but an image can be copied. MCUboot's
  image encryption is off, so images are stored in the clear in external flash. S3 encrypts them at
  rest, but anyone with a download link gets the plain image. They hold no secrets.
- **SEC 02, secure boot:** MCUboot checks the image, but nothing checks MCUboot itself. There is no
  first-stage bootloader before it, and the open debug port can replace MCUboot and its key.
- **SEC 03 and SEC 04, audio:** the board has no audio yet. SEC 03 has nothing to protect so far,
  and Button 1 is the only gate before an update.
- **SEC 04, serial recovery:** this path writes into the active slot, with no trial and no revert.
- **SEC 05, debug headers:** the kit's debug port is open, because development needs it, and there is no
  enclosure yet. A product build would have to lock the port (APPROTECT). This repository has no such
  build yet.

### Hardware Requirements Specification

| Code  | Name                    | Definition                                                                                                                                                                        |
| ----- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HW 01 | Microcontroller         | The device shall be controlled by an nRF5340 microcontroller (nRF7002 DK) to manage I/O peripherals and communication with wireless modules.                                      |
| HW 02 | Operable Without Laptop | All playback functions, mixing, library browsing, and setup shall be fully operable using only the controller and built-in screen. No external computer is required at any point. |
| HW 03 | Deck Interface          | USB-C female port, 2 buttons, 2 USB-A female ports, and screen.                                                                                                                   |
| HW 04 | Wired Audio Outputs     | Dual XLR output, RCA output, and 3.5mm headphone jack.                                                                                                                            |
| HW 05 | Mechanical              | The unit shall mount on the FLX4 with zero mechanical load on the controller's USB and RCA ports.                                                                                 |

### Software Requirement Specifications

| Code   | Name                      | Definition                                                                                                                                                                                                                                 |
| ------ | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| SRS 01 | Boot and Device Detection | The system shall boot within 30 seconds of power-on and shall recognize the controller within 5 seconds of connection. If the controller is disconnected, the system shall resume operation upon reconnection without requiring a restart. |
| SRS 02 | Audio Performance         | The system shall play audio with no more than 3 seconds of delay and no audio dropouts during a test with two decks and effects running.                                                                                                   |
| SRS 03 | MCU/PI Handshake          | The MCU shall exchange a heartbeat with the PI over UART and report battery life.                                                                                                                                                          |
| SRS 04 | Library Support           | The system shall support libraries prepared directly from a USB drive, keeping the user's playlists and saved track markers.                                                                                                               |
| SRS 05 | Data Integrity            | The MCU shall trigger a graceful shutdown, with no filesystem corruption, when the battery drops below 5%.                                                                                                                                 |

## Secure Firmware Updates

Firmware for the nRF7002 DK is in [`firmware/`](firmware/README.md). The update server and its
web console are in [`cloud/`](cloud/README.md), and [`docs/aws-iot.md`](docs/aws-iot.md) describes how
the boards, AWS IoT and the console work together. The console is at
https://console.craniumiot.com. https://craniumiot.com redirects to the console for now. A public
home page is built and waiting to be deployed.

The Raspberry Pi runs Mixxx on Raspberry Pi OS. [`docs/raspberry-pi-ota.md`](docs/raspberry-pi-ota.md)
compares the ways to update it and describes the chosen one: RAUC, driven by the same
AWS IoT console. That design is not built yet: only the nRF board is updated today.

- **Draw and describe your bootloading process**
  ![Boot process](<./pics/Boot Process.png>)

  On every reset MCUboot checks the SHA-256 and the ECDSA P-256 signature of the image in
  the primary slot and starts it only if they are valid. The image holds TF-M, which runs
  first and provides crypto and encrypted storage in the secure world, and the
  application, which runs in the non-secure world. The application then starts the second
  core of the nRF5340, which runs a blinky as the base function. That core is flashed over
  the debug port: MCUboot does not check it, and it is not updated over the air.

  An update is offered as an AWS IoT job. Nothing is downloaded until Button 1 on the
  board is pressed (SEC 04). The application downloads the image into the secondary slot,
  checks it, and resets. MCUboot verifies the signature, swaps the slots and starts the
  new image on trial. The new image has to reconnect to AWS IoT before it marks itself as
  good; if it does not, the next reset swaps the previous image back.

  When no update can reach the board, MCUboot also takes a signed image over UART. See
  [Serial recovery](#serial-recovery-extra-credit).

  The bootloader's settings are in `firmware/app/sysbuild/mcuboot/`, and the signature type, key
  file and swap mode are in `firmware/app/sysbuild.conf`.

<!-- SIZES: every size of the firmware images is in the first two rows of this table, and nowhere else in this file. They are from the 1.2.0 build, which has the older Zephyr shell, and they come from the "Memory region" tables of its build log. Replace them, and the label on them, when 1.3.0 is built. Measured results below describe past runs and do not change. -->

| Question | Answer |
| --- | --- |
| How large is your bootloader? | In the 1.2.0 build, MCUboot is 47,404 bytes in a 64 KB partition. |
| How large is your existing application code? | In the 1.2.0 build, the application is 637,988 bytes and TF-M is 130,008 bytes. With a header and the signature they are one signed image of 769,211 bytes in a slot of 933,888 bytes (912 KB). The signature's length varies by a byte or two from build to build. The network core's blinky is a separate 19,024 bytes in that core's own flash. That build has the older Zephyr shell. Firmware 1.3.0 replaces the shell with the serial console, so a build of this checkout differs from these sizes. |
| Does the bootloader or application code handle the firmware image download? | The application. MCUboot has no network stack; it only verifies and swaps images. |
| What wireless communication is used to download the images? | Wi-Fi (nRF7002). The job arrives over MQTT with mutual TLS from AWS IoT, and the image is downloaded over HTTPS from a short-lived, signed S3 link. |
| Why this method? | The DK has Wi-Fi and Bluetooth LE. A signed image is hundreds of kilobytes. Wi-Fi reaches the server directly and has the bandwidth for it: a download takes a little over a minute. Bluetooth would need a phone as a relay and stays free for audio and the controller link. |
| Where are the downloaded firmware images stored? | In the secondary slot on the external SPI flash of the DK (MX25R64, 8 MB). The running image stays in internal flash until the swap. |

**Features that handle update failures**

| Failure | What happens |
| --- | --- |
| Invalid signature, or signed with another key | MCUboot verifies every image with this project's public key before swapping and on every boot. An image that fails is never started; the board keeps running the current firmware and reports the update as failed (`not_installed`). The server also refuses to accept such a file. |
| Older firmware (rollback) | The console refuses a release that is not newer than every earlier one. The application refuses a job that is not newer than what it runs, and MCUboot refuses to swap in a lower version. The bench tested the application's check. No run reached MCUboot's check, because the application refuses first. Serial recovery has no version check: see below. |
| Corrupted or incomplete download | The application compares the SHA-256 of what is in the secondary slot with the digest in the job and checks that the signed header carries the announced version. On a mismatch the image is erased and nothing is installed. A failed download is retried with a fresh link, up to five attempts in all. |
| Reset or power loss during the download | The running image is not touched. After the restart the board reports the job as `interrupted`. Measured with a reset through the reset pin, not with a power cut. |
| Faulty code with a valid signature | The new image runs on trial. It must join Wi-Fi and reach AWS IoT within 5 minutes to confirm itself; a 120-second hardware watchdog covers a hang. Without the confirmation the next reset makes MCUboot swap the previous image back, and the board reports the rollback. |
| Power loss during the swap | MCUboot's swap-using-move continues the swap on the next boot. Measured with a reset through the reset pin, not with a power cut. |
| Update cancelled after it was offered | The board asks AWS IoT before the download and again before installing. A cancelled job is dropped. A cancel during the download leaves the partial image in the secondary slot, where no swap is requested and the next download overwrites it. A cancel after the download erases the image. |
| No update can reach the board, or no valid image is left | Serial recovery, below. |

**Signature.** Images are signed with ECDSA P-256 over SHA-256, with a key generated for this
project by `tools/keys.py`. The boards hold only the public half, and
[`secrets/README.md`](secrets/README.md) covers the private key. ECDSA P-256 stays by the team's
decision. Ed25519 is the possible later upgrade, and it needs a bootloader reflash. Post-quantum
signatures are not available in this MCUboot.

### Serial recovery (extra credit)

MCUboot can take an image over UART. This is the way back when an image cannot reach the
network, and it needs neither Wi-Fi nor a debugger. It uses `uart0`, the board's second
virtual COM port, so close any terminal on that port first. Run `tools/recover.py` from an
nRF Connect SDK terminal, which provides pyserial and cbor2.

Get the board into the bootloader in one of these ways:

| Way | What to do |
| --- | --- |
| Button | Hold Button 1, press RESET, release Button 1, then run `python tools/recover.py upload <image>`. |
| Debug port | `python tools/recover.py --reset upload <image>` restarts the board and catches the half second after a reset in which the bootloader listens for a command. It uses the debug probe 001050797470 by default. On another board add `--serial-number <probe>`. |
| Running application | `python tools/recover.py --console upload <image>` sends `ENTER_BOOTLOADER` to the application, which restarts. This needs firmware 1.3.0 or later, which has the serial console. |
| No valid image left | Nothing. The bootloader stays by itself. |

Tested on the board: `--reset` and no valid image. Button 1 and `--console` are not tested on
hardware yet.

```sh
python tools/recover.py --reset list                               # show the image the bootloader holds
python tools/recover.py --reset upload binaries/latest.signed.bin  # write it and restart
python tools/recover.py reset                                      # restart a board that is already in the bootloader
```

The tool finds the port by itself; `--port` overrides that. MCUboot takes whatever it is sent and
writes it straight into the primary slot, the one target it accepts. At the restart it checks the
signature and starts nothing that fails. It then stays and waits for a good image.

This path has limits. It has no version check, so any image ever signed with this key can be
installed over a newer one. The image does not run on trial and there is no revert. On a
development kit this adds no power, because the debug port is open. A product build has to narrow
it or turn serial recovery off: [`docs/aws-iot.md`](docs/aws-iot.md#known-limits) says how.

### Binaries and `scripts/ota.sh`

Every `west build` of this checkout stores its signed image in [`binaries/`](binaries/README.md)
by itself, unless it has a test fault built in. Git ignores the images. `latest.signed.bin` is the newest build, `latest.json` holds its version,
size, SHA-256, git commit and build time, and the newest ten versions are kept by name.

```sh
scripts/ota.sh                                      # install binaries/latest.signed.bin
scripts/ota.sh binaries/cranium-1.2.0-0.signed.bin  # install that image
scripts/ota.sh --real-button                        # wait for a person to press Button 1
```

The script needs a signed-in AWS profile. It invokes the console's API function directly. This
bypasses API Gateway and sign-in: there is no token check, no password and no authenticator code.
The function's own checks still run: it asks Cognito whether the named person is an active release
manager, and it checks the signature before it stores anything. The script acts in that person's
name, and the audit entry names them. [`docs/aws-iot.md`](docs/aws-iot.md#known-limits) has more.

It deploys the image to the board and follows the update until the new firmware has confirmed
itself. Without `--real-button` it presses Button 1 through the board's serial console, so the board
must be on USB. The way with a sign-in is by hand, on the console's Firmware page.
`scripts/open-console.sh` signs in to AWS and opens the console.

A release must be newer than every release uploaded before it, so set a new version in
`firmware/app/VERSION` before you build.

### Measured results

All of this ran on one nRF7002 DK and the deployed AWS IoT, on 2026-10-31, with
[`firmware/tests/hil/ota_bench.py`](firmware/tests/hil/ota_bench.py). The bench writes one
line per run to a local `results.jsonl`, which is not in git. The times count from the button press.

These results have four limits:

- **Firmware.** They were measured on firmware with the older Zephyr shell: test images 1.1.x, then
  1.2.0. They have not been re-run on the serial console firmware (1.3.0).
- **Console.** No run went through API Gateway or a console sign-in. Decline, both cancel runs and the
  update to 1.2.0 invoked the deployed API function directly, which bypasses both. The other runs,
  including the ten updates, stored the image in S3 and created the job directly with AWS credentials.
  Some of those images are ones the console refuses. Serial recovery used neither.
- **Cloud.** They ran against the cloud as deployed that day. Security changes to the console were
  deployed after these runs, and the runs were not repeated.
- **Buttons.** The bench pressed the buttons with a shell command that takes the path of the real
  button.

| Ten updates in a row | Result |
| --- | --- |
| Versions | 1.1.30 to 1.1.39, each newer than the last. All ten passed. |
| Button 1 to confirmed | 181 to 227 s, median 192.5 s |
| Download | 62 to 86 s, median 71.5 s |
| Swap in MCUboot | 81 s on every update |
| Rest of the time | The SHA-256 check, a 20-second wait for a late cancellation, the first boot and the reconnect |

The update to 1.2.0, from 1.1.40, took 190 s after the button. `scripts/ota.sh` ran it through the
console's API function, invoked directly, so it bypassed API Gateway and sign-in.

| Scenario | Result on the board |
| --- | --- |
| Job for a version that is not newer | `REJECTED` with `not_newer`. The old image kept running. |
| Button 2 (decline) | `REJECTED` with `declined`. Nothing was downloaded. |
| Cancel while offered | Back to idle, last result `cancelled`. |
| Forced cancel in mid-download | Stopped, last result `cancelled`. Nothing was installed. |
| One flipped byte in the download | `FAILED` with `digest_mismatch`. The old image kept running. |
| Image signed with another key | `FAILED` with `not_installed`. MCUboot logged `Image in the secondary slot is not valid!`. Run twice. |
| Image never confirms | `FAILED` with `rolled_back`, after 576 s and 593 s. Run twice. |
| Image hangs | `FAILED` with `rolled_back`, after 390 s. |
| Image crashes | `FAILED` with `rolled_back`, after 572 s. |
| Reset in mid-download | `FAILED` with `interrupted`. The old image kept running. |
| Reset during the swap | The swap finished and the update succeeded. |
| Serial recovery | Entered with `--reset`. An image signed with another key was refused: `Image in the primary slot is not valid!`. With no valid image left the bootloader stayed, the good image went in over UART in about 4 minutes (227 s), and the board reached AWS. Button 1 and `--console` are not tested on hardware yet. |

**What failed on the way.** The first runs did not all pass. Each was repeated until it passed.
Three of these four were faults in the bench or its tools. The fourth has a likely cause but no proof:

- Decline: the bench uploaded a file name with a `+` in it, and the console refused the name
  (`invalid_filename`). A bench bug.
- Reset during the swap: the bench's own `nrfutil device reset` command failed. Repeated, it passed.
- Serial recovery, first run: `tools/recover.py` stopped with an error after 15 s. A client bug.
- Serial recovery, second run: the wrong key was refused and the good image was sent, but the board
  could not rejoin Wi-Fi (link down). The likely cause is the phone hotspot, which stops broadcasting
  when nothing is connected for a while. The log does not prove this. The bench gave up after 240 s
  and now waits 600 s. The next recovery run passed.

**Firmware bugs the hardware found.** There were two, and both are fixed.

- After a final report, a stale job list changed the last result to `interrupted`. This was fixed
  and re-tested on the board.
- Mbed TLS error -141 was the TLS heap running out with two sessions: MQTT and the download. The
  peak was 86,192 bytes and the heap is 81,920 bytes. Setting `CONFIG_MBEDTLS_SSL_OUT_CONTENT_LEN=4096`
  brought the peak to 61,616 bytes. MQTT stays up during a download, so a cancellation still
  arrives.
