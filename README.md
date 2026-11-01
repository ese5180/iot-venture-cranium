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
| SEC 01 | Firmware Verification | The system shall run only signed firmware images. Firmware images shall be protected from being modified or copied.                                                                                          |
| SEC 02 | Initialization        | The device shall implement secure boot functionality to prevent unauthorized firmware modifications.                                                                                                         |
| SEC 03 | BLE Audio             | The BLE connection shall implement authentication and authorization before allowing access to user’s other device(s).                                                                                        |
| SEC 04 | OTAFU                 | Updates shall be written to an inactive partition, and the device shall automatically roll back if the new image fails to boot. Updates shall start only when a release manager deploys them, and not while audio is playing. |
| SEC 05 | Physical Security     | The enclosure shall be spill-resistant and include a lock slot, with no externally accessible debug headers. The unit shall mount securely to the controller without loading its ports.                      |
| SEC 06 | Update Console        | Console accounts shall be created by an administrator and shall need a password and an authenticator code. The console shall hold only the public half of the signing key and shall log every attempted change that reaches its API function.                    |

**Not met on the dev kit yet** (more in the [threat model](docs/aws-iot.md#threat-model)):

- **SEC 01:** the network core's image isn't signed, because it's flashed over the debug port. Images are stored unencrypted, so they can be copied, but they hold no secrets.
- **SEC 02:** nothing checks MCUboot itself, and the open debug port could replace it.
- **SEC 03:** there's no audio on the board yet, so nothing to protect.
- **SEC 04:** there's no audio check yet. Serial recovery has no trial or revert, and a golden image restore skips the version check on purpose.
- **SEC 05:** there's no enclosure yet, and the debug port stays open for development.

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

On every reset, MCUboot checks the image's SHA-256 and ECDSA P-256 signature, and only boots it if both are valid. The image contains TF-M (secure world: crypto and encrypted storage) and our application (non-secure world). The network core runs a small blinky, which is flashed over the debug port and isn't updated over the air.

To update, a release manager deploys a signed image from our console, which creates an AWS IoT job. The application downloads the image into the secondary slot, checks it and resets. MCUboot verifies the signature, swaps the slots and starts the new image on trial. If it can't reconnect to AWS IoT, the next reset swaps the old image back.

<!-- SIZES: all image sizes are in the first two rows below. Update them, their label and "pics/Boot Process.png" for each release. -->

| Question | Answer |
| --- | --- |
| How large is your bootloader? | MCUboot is 50,324 bytes of flash in a 64 KB partition, and uses 22,408 bytes of RAM (1.7.2 build). |
| How large is your existing application code? | The application is 630,740 bytes of flash and uses 351 KB of its 400 KB of RAM. TF-M is 130,008 bytes of flash and uses 36,620 bytes of RAM. Signed together, they're 761,962 bytes in a 933,888-byte slot. The network core's blinky is another 19,024 bytes (1.7.2 build). |
| Does the bootloader or application code handle the firmware image download? | The application. MCUboot has no network stack. |
| What wireless communication is used to download the images? | Wi-Fi (nRF7002). The job arrives over MQTT with mutual TLS, and the image comes over HTTPS from a signed S3 link. |
| Why this method? | A signed image is about 760 KB. Wi-Fi reaches the server directly and downloads it in about a minute. Bluetooth would need a phone as a relay, and we're saving it for audio. |
| Where are the downloaded firmware images stored? | In the secondary slot on the DK's external flash (MX25R64, 8 MB). The running image stays in internal flash until the swap. |

**Features that handle update failures**

| Failure | What happens |
| --- | --- |
| Invalid signature | MCUboot won't swap or boot it, so the board keeps its current firmware and reports the update as failed. The console also refuses it on upload. |
| Faulty code with a valid signature | The new image runs on trial and has 5 minutes to reach AWS IoT and confirm itself. A 120-second watchdog covers a hang. If it doesn't confirm, the next reset swaps the old image back. |
| Corrupted download | The application checks the SHA-256 against the job and erases the image on a mismatch. It retries with a fresh link, up to five attempts. |
| Older firmware | The console, the application and MCUboot each refuse a version that isn't newer. |
| Reset or power loss | During a download, the running image isn't touched. During a swap, MCUboot continues on the next boot. |
| No update can reach the board | [Serial recovery](#serial-recovery-extra-credit), below. A person can also hold Button 2 through a reset to restore a frozen [golden image](firmware/README.md#golden-image). |

#### FOTA implementation

| Requirement | How it's met |
| --- | --- |
| MCUboot support in Zephyr | `SB_CONFIG_BOOTLOADER_MCUBOOT=y` in [`firmware/app/sysbuild.conf`](firmware/app/sysbuild.conf), with settings in `firmware/app/sysbuild/mcuboot/`. |
| Firmware image in external flash | The secondary slot is on the MX25R64. |
| Signed images from our own keys | ECDSA P-256 over SHA-256, with a key from `tools/keys.py`. Boards hold only the public half. See [`secrets/README.md`](secrets/README.md). |
| FOTA over a wireless protocol | Wi-Fi, through AWS IoT jobs: [`ota.c`](firmware/app/src/ota.c) and [`ota_job.c`](firmware/app/src/ota_job.c). |

#### Serial recovery (extra credit)

MCUboot also accepts a signed image over UART, as a backup when the network can't be used. Close any terminal on the board's second COM port, then run this from an nRF Connect SDK terminal:

```sh
python tools/recover.py --reset upload <image>  # restarts the board through the debug port
python tools/recover.py upload <image>          # after holding Button 1 and pressing RESET
```

MCUboot checks the signature at the restart and won't start an image that fails. This path has no version check or revert.

More detail: [test results](docs/test-results.md), [firmware](firmware/README.md), [cloud](docs/aws-iot.md), [binaries](binaries/README.md) and [Raspberry Pi updates](docs/raspberry-pi-ota.md).
