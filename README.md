# ESE5180: IoT Venture

## 3.1 Team Formation

**Team Number: T07**

**Team Name: Cranium**

| Team Member Name   | Email Address                  |
| ------------------ | ------------------------------ |
| Demetrius Bosket   | dbosket@engineering.upenn.edu  |
| Adam Shalabi       | adamshal@engineering.upenn.edu |
| Christian Durante  | cgd2@engineering.upenn.edu     |
| Vihaan Ravishankar | vihaan1@engineering.upenn.edu  |

**GitHub Repository URL: https://github.com/ese5180/f26-t07-the-cranium**

## 3.2 Concept Development

### 3.2.2 Product Name & Function

We are developing a mounted attachment to beginner DJ controllers in order to remove reliance on a laptop. This solution will be more familiar, cost-effective, and sustainable than directly upgrading these popular controllers to all-in-one DJ systems. The device will utilize BLE audio to challenge typical issues with wireless audio as well as a secondary board in a Raspberry Pi to develop more robust display support at our price and time range.

### 3.2.3 Target Market & Demographics

- **Who will be using your product?** New and intermediate FLX4 DJs.
- **Who will be purchasing your product?** FLX4 owners seeking standalone capability + their friends and family as gifts.
- **Where would you deploy your product?** U.S. first through online D2C, then globally.
- **How large is the target market?** ~$28M existing U.S. FLX4 market, growing by $7.1M annually.
- **How much do you expect to capture?** ~$1M/year by Year 3 (given 1% adoption at $200/unit).
- **What competitors are already in the space?** Pioneer’s XDJ systems as the traditional standalone alternative, less desirable standalone systems from Numark and Denon, and DeckShark as an early-stage add-on startup.

### 3.2.4 Stakeholders

- Adam:  Customer perspectives of 3 exact target customers (intermediate level Pioneer FLX4 owners who play small/medium live events)
  - Already held interviews, obtained specific pricing perspectives and target DJ controllers.
- (via Chris) Subject Matter Expert: Garrett Treanor (Indiana University - Expertise in Digital Audio Processing, Research in Immersive/Spatial Audio)
- Competitor's (DeckShark) Community Discord - finding additional consumer perspectives and specific failure points of direct competitors.

### 3.2.5 System-Level Diagrams

- **Create a device block diagram that details the power architecture, microcontroller, & peripherals**
  ![Block diagram](<./pics/Block Diagram.png>)
- **Create a communication diagram**
  ![Communication diagram](<./pics/Communication Diagram.png>)

### 3.2.6 Security Requirements Specification

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
- **SEC 04, golden image:** a restore goes back to the frozen image with no version check and no
  trial, on purpose. It takes a person at the board.
- **SEC 05, debug headers:** the kit's debug port is open, because development needs it, and there is no
  enclosure yet. A product build would have to lock the port (APPROTECT). This repository has no such
  build yet.

### 3.2.7 Hardware Requirements Specification

| Code  | Name                    | Definition                                                                                                                                                                        |
| ----- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HW 01 | Microcontroller         | The device shall be controlled by an nRF5340 microcontroller (nRF7002 DK) to manage I/O peripherals and communication with wireless modules.                                      |
| HW 02 | Operable Without Laptop | All playback functions, mixing, library browsing, and setup shall be fully operable using only the controller and built-in screen. No external computer is required at any point. |
| HW 03 | Deck Interface          | USB-C female port, 2 buttons, 2 USB-A female ports, and screen.                                                                                                                   |
| HW 04 | Wired Audio Outputs     | Dual XLR output, RCA output, and 3.5mm headphone jack.                                                                                                                            |
| HW 05 | Mechanical              | The unit shall mount on the FLX4 with zero mechanical load on the controller's USB and RCA ports.                                                                                 |

### 3.2.8 Software Requirements Specification

| Code   | Name                      | Definition                                                                                                                                                                                                                                 |
| ------ | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| SRS 01 | Boot and Device Detection | The system shall boot within 30 seconds of power-on and shall recognize the controller within 5 seconds of connection. If the controller is disconnected, the system shall resume operation upon reconnection without requiring a restart. |
| SRS 02 | Audio Performance         | The system shall play audio with no more than 3 seconds of delay and no audio dropouts during a test with two decks and effects running.                                                                                                   |
| SRS 03 | MCU/PI Handshake          | The MCU shall exchange a heartbeat with the PI over UART and report battery life.                                                                                                                                                          |
| SRS 04 | Library Support           | The system shall support libraries prepared directly from a USB drive, keeping the user's playlists and saved track markers.                                                                                                               |
| SRS 05 | Data Integrity            | The MCU shall trigger a graceful shutdown, with no filesystem corruption, when the battery drops below 5%.                                                                                                                                 |

## 3.5 Wireless Demo & Secure Firmware Updates

### 3.5.5 Firmware Security Implementation

#### (3.5.1) Bootloading process

![Boot process](<./pics/Boot Process.png>)

On every reset MCUboot checks the SHA-256 and the ECDSA P-256 signature of the image in the primary slot and starts it only if they are valid. The image holds TF-M, which runs first and provides crypto and encrypted storage in the secure world, and the application, which runs in the non-secure world. The application then starts the second core of the nRF5340, which runs a blinky as the base function. That core is flashed over the debug port: MCUboot does not check it, and it is not updated over the air.

An update is offered as an AWS IoT job. Nothing is downloaded until Button 1 on the board is pressed (SEC 04). The application downloads the image into the secondary slot, checks it, and resets. MCUboot verifies the signature, swaps the slots and starts the new image on trial. The new image has to reconnect to AWS IoT before it marks itself as good; if it does not, the next reset swaps the previous image back.

<!-- SIZES: every size of the firmware images is in the first two rows of this table, and nowhere else in this file. They are from the 1.7.0 build, from the "Memory region" tables of its build log and the length of its signed file. Replace them, the label on them and the numbers in "pics/Boot Process.png" when a later version is built. -->

| Question | Answer |
| --- | --- |
| How large is your bootloader? | In the 1.7.0 build, MCUboot is 50,324 bytes of flash in a 64 KB partition, and uses 22,408 bytes of RAM. |
| How large is your existing application code? | In the 1.7.0 build, the application is 629,364 bytes of flash and uses 359,392 of 409,600 bytes of RAM. TF-M is 130,008 of 130,560 bytes of flash, and uses 36,620 of 49,152 bytes of RAM. With a header and the signature, the two are one signed image of 760,587 bytes in a slot of 933,888 bytes. The network core's blinky is a separate 19,024 bytes in that core's own flash. |
| Does the bootloader or application code handle the firmware image download? | The application. MCUboot has no network stack: it verifies and swaps images. |
| What wireless communication is used to download the images? | Wi-Fi (nRF7002). The job arrives over MQTT with mutual TLS from AWS IoT, and the image is downloaded over HTTPS from a short-lived, signed S3 link. |
| Why this method? | The DK has Wi-Fi and Bluetooth LE. A signed image is hundreds of kilobytes. Wi-Fi reaches the server directly and has the bandwidth for it: a download takes a little over a minute. Bluetooth would need a phone as a relay and stays free for audio and the controller link. |
| Where are the downloaded firmware images stored? | In the secondary slot on the external SPI flash of the DK (MX25R64, 8 MB). The running image stays in internal flash until the swap. |

**Features enabled to handle firmware update failures**

| Failure | What happens |
| --- | --- |
| Invalid signature | MCUboot verifies every image with this project's public key before swapping and on every boot. An image that fails is never started, and the board keeps running the current firmware and reports the update as failed. |
| Faulty code with a valid signature | The new image runs on trial. It must join Wi-Fi and reach AWS IoT within 5 minutes to confirm itself, and a 120-second hardware watchdog covers a hang. Without the confirmation the next reset makes MCUboot swap the previous image back. |
| Corrupted firmware download | The application compares the SHA-256 of what is in the secondary slot with the digest in the job and checks the version in the signed header. On a mismatch the image is erased and nothing is installed. A failed download is retried with a fresh link, up to five attempts in all. |
| Older firmware | The console refuses a release that is not newer than every earlier one, the application refuses a job that is not newer than what it runs, and MCUboot refuses a lower version before a swap. |
| Reset or power loss during an update | During a download the running image is not touched, and the board reports the job as interrupted. During a swap, MCUboot's swap-using-move continues on the next boot. |
| No update can reach the board, or no valid image is left | [Serial recovery](#serial-recovery-extra-credit). A person at the board can also hold Button 2 through a reset to restore a frozen [golden image](firmware/README.md#golden-image). |

#### FOTA implementation

| Requirement | How it is met |
| --- | --- |
| A bootloader using MCUboot support in Zephyr | `SB_CONFIG_BOOTLOADER_MCUBOOT=y` in [`firmware/app/sysbuild.conf`](firmware/app/sysbuild.conf), with the bootloader's settings in `firmware/app/sysbuild/mcuboot/`. |
| Firmware image in external flash | The secondary slot is on the DK's MX25R64 external flash. |
| A signed image based on uniquely generated keys | Images are signed with ECDSA P-256 over SHA-256, with a key generated for this project by `tools/keys.py`. The boards hold only the public half, and [`secrets/README.md`](secrets/README.md) covers the private key. |
| FOTA through a wireless protocol | Wi-Fi, through AWS IoT jobs: [`firmware/app/src/ota.c`](firmware/app/src/ota.c) and [`firmware/app/src/ota_job.c`](firmware/app/src/ota_job.c). |

The code is in [`firmware/`](firmware/README.md).

#### Serial recovery (extra credit)

MCUboot takes a signed image over UART as a failsafe when an image cannot reach the network. It uses `uart0`, the board's second virtual COM port, so close any terminal on that port first. Run `tools/recover.py` from an nRF Connect SDK terminal, which provides pyserial and cbor2.

Hold Button 1, press RESET and release Button 1, then upload the image. Or let the tool restart the board through the debug port. With no valid image left, the bootloader stays by itself.

```sh
python tools/recover.py upload <image>          # after the button
python tools/recover.py --reset upload <image>  # through the debug port
```

MCUboot writes what it receives into the primary slot. At the restart it checks the signature, starts nothing that fails, and waits for a good image. This path has no version check and no revert, so any image signed with this key can be installed over a newer one. [`docs/aws-iot.md`](docs/aws-iot.md#known-limits) says how a product build would narrow it.

Everything else is kept apart from this file: [test results](docs/test-results.md), [firmware](firmware/README.md), [cloud](docs/aws-iot.md), [binaries](binaries/README.md) and the [Raspberry Pi](docs/raspberry-pi-ota.md).
