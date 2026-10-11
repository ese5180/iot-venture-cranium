# ESE5180: IoT Venture

**Team Number:**

**Team Name: Cranium**

| Team Member Name   | Email Address                  |
| ------------------ | ------------------------------ |
| Demetrius Bosket   | dbosket@engineering.upenn.edu  |
| Adam Shalabi       | adamshal@engineering.upenn.edu |
| Christian Durante  | cgd2@engineering.upenn.edu     |
| Vihaan Ravishankar | vihaan1@engineering.upenn.edu  |

**GitHub Repository URL: https://github.com/dbosket/iot-venture-cranium**

## Concept Development

- **Create a device block diagram that details the power architecture, microcontroller, & peripherals**
  ![Block diagram](<./pics/Block Diagram.png>)
- **Create a communication diagram**
  ![Block diagram](<./pics/Communication Diagram.png>)

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

| Code   | Name                  | Definition                                                                                                                                                                                                   |
| ------ | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| SEC 01 | Firmware Verification | The system shall run only signed firmware images. Firmware images shall be protected from being modified or copied.                                                                                          |
| SEC 02 | Initialization        | The device shall implement secure boot functionality to prevent unauthorized firmware modifications.                                                                                                         |
| SEC 03 | BLE Audio             | The BLE connection shall implement authentication and authorization before allowing access to user’s other device(s).                                                                                       |
| SEC 04 | OTAFU                 | Updates shall be written to an inactive partition, and the device shall automatically roll back if the new image fails to boot. Updates shall not begin without user confirmation or while audio is playing. |
| SEC 05 | Physical Security     | The enclosure shall be spill-resistant and include a lock slot, with no externally accessible debug headers. The unit shall mount securely to the controller without loading its ports.                      |

### Hardware Requirements Specification

| Code  | Name                    | Definition                                                                                                                                                                        |
| ----- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HW 01 | Microcontroller         | The device shall be controlled by an nRF7002 microcontroller to manage I/O peripherals and communication with wireless modules.                                                   |
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
the boards, AWS IoT and the console work together.

- **Draw and describe your bootloading process**
  ![Boot process](<./pics/Boot Process.png>)

  On every reset MCUboot checks the SHA-256 and the ECDSA P-256 signature of the image in
  the primary slot and starts it only if they are valid. The image holds TF-M, which runs
  first and keeps keys, crypto and encrypted storage in the secure world, and the
  application, which runs in the non-secure world. The application then starts the second
  core of the nRF5340, which runs a blinky as the base function and is not updated over
  the air.

  An update is offered as an AWS IoT job. Nothing is downloaded until Button 1 on the
  board is pressed (SEC 04). The application downloads the image into the secondary slot,
  checks it, and resets. MCUboot verifies the signature, swaps the slots and starts the
  new image on trial. The new image has to reconnect to AWS IoT before it marks itself as
  good; if it does not, the next reset swaps the previous image back.

| Question | Answer |
| --- | --- |
| How large is your bootloader? | MCUboot is 39,988 bytes in a 64 KB partition. |
| How large is your existing application code? | The application is 637,660 bytes and TF-M is 130,008 bytes. Together they are one signed image of 768,884 bytes in a 912 KB slot. |
| Does the bootloader or application code handle the firmware image download? | The application. MCUboot has no network stack; it only verifies and swaps images. |
| What wireless communication is used to download the images? | Wi-Fi (nRF7002). The job arrives over MQTT with mutual TLS from AWS IoT, and the image is downloaded over HTTPS from a short-lived, signed S3 link. |
| Why this method? | The image is about 770 KB. Wi-Fi reaches the server directly and has the bandwidth for it; Bluetooth would need a phone as a relay and stays free for audio and the controller link. |
| Where are the downloaded firmware images stored? | In the secondary slot on the external SPI flash of the DK (MX25R64). The running image stays in internal flash until the swap. |

**Features that handle update failures**

| Failure | What happens |
| --- | --- |
| Invalid signature, or signed with another key | MCUboot verifies every image with this project's public key before swapping and on every boot. An image that fails is never started; the board keeps running the current firmware and reports the update as failed. The server also refuses to accept such a file. |
| Older firmware (rollback) | The application refuses a job that is not newer than what it runs, and MCUboot refuses to swap in a lower version. |
| Corrupted or incomplete download | The application compares the SHA-256 of what is in the secondary slot with the digest in the job and checks that the signed header carries the announced version. On a mismatch the image is erased and nothing is installed. A failed download is retried with a fresh link, three times at most. |
| Faulty code with a valid signature | The new image runs on trial. It must join Wi-Fi and reach AWS IoT within 5 minutes to confirm itself; a watchdog covers a hang. Without the confirmation the next reset makes MCUboot swap the previous image back, and the board reports the rollback. |
| Power loss during the swap | MCUboot's swap-using-move continues the swap on the next boot. |
| Update cancelled after it was offered | The board asks AWS IoT before the download and again before installing; a cancelled job is dropped and the downloaded image erased. |
