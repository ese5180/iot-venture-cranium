# Test results

What has been measured on the board, and what has not. The firmware and the bootloader that each result
came from are in the table below.

**Which firmware.** The golden image, the one a person can always go back to, is firmware 1.5.0. It is
frozen: [`firmware/golden.json`](../firmware/golden.json) names it, and the bootloader holds its digest.
The first release with [what restarts a stuck board](../firmware/README.md#when-the-board-is-stuck) is
1.7.0. From 1.7.2 an update starts with no button. The latest is 1.7.4, on the board since 2026-11-01. Test images
for the bench are numbered around them.

Every run below was on one nRF7002 DK. The benches write one line per run to a local
`results.jsonl`, which is not in git. A result is about the firmware and the bootloader it ran on:

| Result | Firmware | Bootloader | Date |
| --- | --- | --- | --- |
| [Golden image tests](#the-golden-image-on-firmware-150), by the debug port and by a person | 1.5.0, the frozen file. G13 also 1.5.40 | The one that holds the pin | 2026-11-01 |
| [Getting into the bootloader](#getting-into-the-bootloader-on-firmware-150) | 1.5.0 | The one that holds the pin | 2026-11-01 |
| [Signing in to the console](#signing-in-to-the-console) | 1.5.0 | The one that holds the pin | 2026-11-01 |
| [Serial console, by the bench](#the-serial-console-on-firmware-150) | 1.5.0 | The one that holds the pin | 2026-11-01 |
| [Serial console, by the web page](#the-consoles-serial-page-on-firmware-150) | 1.5.0 | The one that holds the pin | 2026-11-01 |
| [Serial console, by the bench](#the-serial-console-on-firmware-130) | 1.3.0 | From before the golden image | 2026-10-31 |
| [Over the air, and serial recovery](#over-the-air-on-the-older-shell-firmware) | 1.1.x and 1.2.0, with the older Zephyr shell | From before the golden image | 2026-10-31 |
| Firmware update over Bluetooth | None: it has not been tried on the air | | |
| [The serial console, and a real hang](#the-serial-console-and-a-real-hang-on-firmware-170) | 1.7.0 | The one that holds the pin | 2026-11-01 |
| [One update to 1.7.0](#over-the-air-on-the-final-firmware) | 1.5.0 to 1.7.0 | The one that holds the pin | 2026-11-01 |

<!-- OVER-THE-AIR REGRESSION: the section under this comment is the one place that says whether the over-the-air regression on the final firmware has run. Other documents link to it. When it has run, replace its text with the date, the firmware, the bootloader, the results and what failed on the way, and add a row to the table above. -->

## Over the air on the final firmware

**Updates have finished on 1.7.0, 1.7.1 and 1.7.2, one failed the same way twice, and the regression has not run.**
All on 2026-11-01, on the bootloader that holds the pin:

| Time | Update | Deployed through | On a computer's USB? | Result |
| --- | --- | --- | --- | --- |
| 12:15 | 1.5.0 to 1.7.0 | `scripts/ota.sh`, invoking the console's API function directly | Yes | `SUCCEEDED`, 188 s after the button |
| 14:32 | 1.7.0 to 1.7.1 | The website, signed in, with Button 1 pressed by a person | Yes | `SUCCEEDED`, 188 s from the job starting |
| 16:01 | 1.7.1 to 1.7.2 | The website, signed in | **No** | `FAILED`, `not_installed`; the board went back to 1.7.1 by itself |
| 16:07 | 1.7.1 to 1.7.2, the same file | The website, signed in | **No** | `FAILED`, `not_installed`; the same again |
| 16:15 | 1.7.1 to 1.7.2, the same file | The bench, with a job made directly | Yes | `SUCCEEDED`, 188 s after the button |
| 16:28 | 1.7.2 to 1.7.3 | The website, signed in, with no button | Yes | `SUCCEEDED`, 210 s, with a Wi-Fi drop on the way, cause not known |
| 16:41 | 1.7.3 to 1.7.3+1 | The bench, with no button | Yes | `SUCCEEDED`, 185 s |
| 16:53 | 1.7.3+1 to 1.7.4 | The website, signed in, with no button | Yes | `SUCCEEDED`, 172 s |

**The two failures are not explained.** There was no console on them, so what follows is from timing. Each took
165 to 183 s from the restart to 1.7.1 running again, which fits a swap of 81 s, a reset within seconds, and a swap
back, and not a refusal, which is much quicker. `not_installed` only says that the new image never recorded that it
was on trial, so it died very early. The same file then installed with no error while on USB, so the code alone
does not explain it. The difference between those runs is the USB connection, and so the board's power. That
may be the cause, and no test has shown it yet. Either way the board recovered by itself each time, which is the first
real rollback on this bootloader. It was seen from the cloud only.

The power source those two failures ran on is no longer available, so they have not been reproduced, and this has
**not been fixed**. From 1.7.4 the board keeps a [boot diary](../firmware/README.md#boot-diary), which should show the reason
if it happens again. Until then, the successful updates are all from a board on a computer's USB port.

The update at 12:15 is the one timed here:

| Step | After the button |
| --- | --- |
| Download | 69 s |
| Restart for the swap | 96 s |
| The new image on trial | 179 s |
| Confirmed, job `SUCCEEDED` | 188 s |

Not run on any firmware from 1.5.0 on: ten updates in a row, the failure scenarios, and `ota_bench.py chip-dead`.
The plan, after installing 1.7.2 over the air with the board off USB: a corrupted download (`corrupt`), a bad signature
(`bad-signature`), an older version (`older`) and one rollback (`faulty`, with a test image that never confirms itself).
Those rest on the job and the shadow alone, and each line of `results.jsonl` says that it ran `cloud-only`, so a swap or
a revert is only seen by what the board reports afterwards. Ten updates in a row and the hang test (`chip-dead-cloud`)
are for later, after the checkoff. These cannot run without a cable, and are `NOT_APPLICABLE` until one is plugged in:
`reset-download`, `reset-swap`, `chip-dead`, `recovery` and `console_bench.py`. `golden_bench.py` also takes the serial
ports and the debug probe.
G15 and G16 below also took real jobs into the bootloader's swap, and the gesture went back to 1.5.0 on purpose.
Until then, the other over-the-air results are those
[on the older shell firmware](#over-the-air-on-the-older-shell-firmware), below.

## The golden image, on firmware 1.5.0

All of this is from [`firmware/tests/hil/golden_bench.py`](../firmware/tests/hil/golden_bench.py), on the
frozen image and its bootloader, with no Wi-Fi but for G15 and G16. `results.jsonl` has the SHA-256 of both in each line.
Each row is the last run of that test. In G5a to G5e a person held Button 2 and pulled the USB cable. In
every other test the debug port held Button 2 down, and the bootloader has no test code for this. Of 22
tests, 21 passed and 1 is `PARTIAL` because a part needs a person.

| Test | Outcome | What it did, and what it showed |
| --- | --- | --- |
| G0 | PASS | Recorded the board, and read its old bootloader back through the debug port. |
| G1 | PASS | The host tests and the tools' tests. |
| G2 | PASS | `tools/golden.py restore` put the image in the primary slot over UART in 230 s. It refused a file with a flipped byte. |
| G3 | PASS | Flashed the bootloader only. The image and the provisioning stayed: all three credentials were still set, and `list` showed the pinned digest. |
| G4 | PASS | The gesture with 1.5.0 running sealed the golden copy in 44 s. A repeat did nothing: one slow blink. |
| G5a | PASS | By a person: Button 2 for 2 s through a reset. A normal boot, nothing written. |
| G5b | PASS | By a person: held past 10 s and let go at 30 s. No action, and it boots after the release. |
| G5c | PASS | By a person: held for 80 s, past the bootloader's 60 s limit and into the application. The board was not wiped: it was `OPERATING`, with all three credentials still set. |
| G5d | PASS | 10 resets and, by a person, 10 power cuts with the USB cable. Each one booted, and none said anything about the golden image. |
| G5e | PASS | By a person: the primary slot damaged through the debug port, the USB cable pulled, Button 2 held while plugging it back in. The board restored 1.5.0 with the pinned digest, and all three credentials were still set. The whole test took 115 s. |
| G5f | PASS | The button held from the input driver on, for 15.2 s, which reaches the check in `ui.c`: no factory reset. |
| G6 | PASS | A confirmed image goes bad: one that crashes on purpose. The gesture restored 1.5.0 in 62 s. |
| G7 | PASS | Both slots damaged: the bootloader stayed in serial recovery and listed nothing. The gesture restored 1.5.0 in 62 s. |
| G8 | PASS | The primary slot damaged through the debug port. The gesture restored 1.5.0 in 64 s. |
| G9 | PASS | A bootloader pinned to another digest refused, over a valid primary slot and over a damaged one, with three slow blinks and nothing written. With the right bootloader back, the gesture restored 1.5.0 in 63 s. |
| G10 | PASS | An image damaged a byte of the golden copy, in its signature and then in its body. The gesture refused both. |
| G11 | **PARTIAL** | A restore cut off by a reset at 8 points, and a seal at 5. Each restore left serial recovery and never a partial image, each seal left the running image, and a repeat of the gesture finished the job. Power cuts have not run: somebody has to pull the cable. |
| G12 | PASS | Over serial recovery, with no tool in the way: an image signed with another key, and the golden image with a flipped byte. Each was refused at two boots: `Image in the primary slot is not valid!`. |
| G13 | PASS | Serial recovery moved the board forward from 1.5.0 to 1.5.40. The gesture then restored 1.5.0, in 63 s. |
| G14 | PASS | An upload for another image number: refused. See below. |
| G15 | PASS | A real job from 1.5.0, over Wi-Fi and AWS, put an image that never confirms itself on trial, as firmware 1.5.20. The gesture restored 1.5.0 in 61 s, with no swap and no revert after it. The job closed as `FAILED` with `rolled_back`. |
| G16 | PASS | The same, with the forward image, and the gesture 6 s into the bootloader's swap. It restored 1.5.0 in 61 s, and the swap did not resume. The job closed as `FAILED` with `not_installed`. |

G15 and G16 ran at 08:53 to 09:02 on 2026-11-01, from commit cf9a591 with a clean tree, and the debug port
held the button. They stored the image in S3 and created the job directly with AWS credentials, so they
did not go through the console.

The run by a person was at 08:34 to 08:41 on 2026-11-01, from commit 53b0049 with a clean tree: 5 of 5
passed. G5a took 15 s, G5b 71 s, G5c 121 s, G5d 139 s and G5e 115 s. G4 and G11 were not part of it: G4 by
a person needs a golden copy that is not sealed yet, and this board's is. Nobody was asked what LED1 did.

The times include the gesture. After each restore the firmware was 1.5.0, and the root CA, the private
key and the certificate were still set. `tools/golden.py qualify` has not been used, so
`firmware/golden.json` names no qualifying run. That needs the power cuts of G11 by a person and the
over-the-air regression. [`firmware/README.md`](../firmware/README.md#tests) has the command for the
person's part.

**A hole in serial recovery, found and closed.** An upload over serial recovery names an image
number, and MCUboot uses that number as an index into a table of flash areas with no bounds check. So
anyone on the serial port could have had an upload erase and write another area: the bootloader's own
partition, TF-M storage or the golden copy. This was found by reading MCUboot's source, while the
golden image was being built. `image_number_guard.c` now refuses every number but 0, on every build of
this bootloader, with the golden image on or off.

G14 sent the first chunk of an upload for image numbers 1 and 3 to the frozen bootloader. Each one got
error 3. The board still ran 1.5.0, and the gesture then found both copies good and wrote nothing.
G14 does not send the numbers that would reach the bootloader's own partition, TF-M storage or the
golden copy, and it does not run on a bootloader without the guard, so this bench has never run the
hole itself. A board only gets the guard with a debug-port flash of its bootloader, because MCUboot is not
updated over the air.

**What failed on the way.** Both of these were repeated until they passed:

- G1, first run: a test of the settings assumed that the golden image stays off, so it failed on the
  frozen tree. A fault in the test.
- G13, first run: `the bootloader did not answer`. Text left over from before a restart made
  `tools/recover.py` restart the board again while the bootloader was listening, and it took an answer
  from before that restart for success, so the upload went to the application. A fault in the tool,
  fixed in commit fd2522e.

## Getting into the bootloader, on firmware 1.5.0

30 entries over the debug port, the way `tools/recover.py --reset` does it, after the fix above: 29 at
the first restart, 1 after one more restart, and none failed. Each took 2.1 to 4.9 s, median 2.2 s.

## The serial console, on firmware 1.5.0

[`firmware/tests/hil/console_bench.py`](../firmware/tests/hil/console_bench.py) ran 9 checks without
erasing the board. 4 passed: `protocol`, `boot-input` (2.3 s), `check-2-bad-init` and `bootloader`,
which is `recover.py --console list`.

5 failed: `log-lines`, `check-4-join`, `check-5-wrong-password`, `settings-kept` and `back-online`.
They failed only because the hotspot had gone away during the 4-minute serial upload of G2. The board
said `network not found` 82 times and never joined. These five are neither passes nor firmware
failures: they show nothing about the firmware.

**The rerun, with the hotspot on, the morning of 2026-11-01.** `log-lines` passed (31 s) and
`check-4-join` passed (17 s). `check-5-wrong-password` found a firmware fault:

- At 08:17:41, the second the board had joined, the check stored a new network. By 08:17:45 the link was
  down, and from 08:17:51 the driver logged `hal_rpu_ready_wait: Timed out waiting` and `Timeout waiting
  to get free cmd buff from RPU` about every 2 s: the Wi-Fi chip had stopped answering.
- Scans failed, and every 30 s the firmware said `[WIFI] failed reason=no answer` and tried again. The
  console kept answering and the main loop kept feeding the watchdog, so nothing restarted the board.
- The run was stopped by hand after more than 3.5 minutes. A software restart cleared it: 14 s later the
  chip reported the wrong password properly, with no driver errors, and the right network then joined
  and reached the cloud.

Its root cause is not known. It has not been forced in a loop, on purpose, because that keeps the board off the
hotspot, but it came again in a normal run on 1.7.0: see
[the serial console and a real hang](#the-serial-console-and-a-real-hang-on-firmware-170). 1.5.0 is frozen and keeps this behaviour, so on the golden
image a hang like this needs a restart by hand. 1.7.0 has
[timers for it](../firmware/README.md#when-the-board-is-stuck). `settings-kept` and `back-online` have not been rerun, and
`check-5-wrong-password` has not passed on this firmware.

The checks that erase the board have not run on 1.5.0.

## The serial console, and a real hang, on firmware 1.7.0

`console_bench.py` ran the checks that need Wi-Fi, on 2026-11-01 from 12:27, with the hotspot on. `log-lines`
passed (31 s), `check-4-join` passed (20 s) and `check-5-wrong-password` passed (16 s).

`settings-kept` and `back-online` failed. This is what happened, from the board's log:

| Time | What the board did |
| --- | --- |
| 12:28:30 | `CLEAR_WIFI`, and in the same second the bench stored the right network again with `WIFI` |
| 12:28:40 | The same driver errors as on 1.5.0: the Wi-Fi chip had stopped answering |
| 12:29:02 and on | `[WIFI] failed reason=no answer`, again and again, and no join |
| 12:30:30 | `[STUCK] restarting reason=wifi_silent count=1` |
| 12:30:35 | Booted, and logged that it had restarted for being stuck |
| 12:30:39 and on | `[WIFI] failed reason=network not found`, with the chip answering |

So the `wifi_silent` timer ran on a real hang for the first time, and did what it is for: the board restarted
itself, 2 minutes after the link changed, and the chip answered again. This is the second hang seen, and both came
within a second or so of a connect request while the link was changing. The cause is not proven.

The board then did not rejoin, and `settings-kept` gave up after its 600 s wait. It reported `network not found`
for as long as anyone looked. The likely cause is the phone hotspot, which stops broadcasting when nothing has been
connected for a while, but the log does not prove that. A person's Chrome was also connected to the same port
by 12:46, and the log is mixed after that. The checks that erase the board have not run on 1.7.0.

## Signing in to the console

On 2026-11-01, at about 09:06, a person signed in to the deployed console with a password and an
authenticator code, as a release manager. This is the first time that real sign-in and the API's check of
its token have been tried. Overview, Firmware, Serial console and History all opened. Overview showed the
board online on 1.5.0, reported 6 s earlier, which only the signed-in API can give it. The console was
deployed from commit 5f8eb6d.

Not tried: a viewer's account, an upload or a deployment through the website, and connecting a board on
that Serial console page.

## The console's serial page, on firmware 1.5.0

The console's real serial page, in real Chrome, against the real board: 30 of 32 checks passed. The
two that failed, `the page shows the board joining the network` and `the board joins Wi-Fi after the
restart`, are the same missing hotspot, and have not been repeated. What stood in: `navigator.serial`,
bridged to the board's port. So Chrome's own Web Serial and its port chooser were not tested. That
harness is not in this repository.

## The serial console, on firmware 1.3.0

The same bench, with the checks that erase the board. 9 of 11 passed: `protocol`, `boot-input` (2.4 s),
`check-2-bad-init`, `bootloader`, `check-7-factory-reset`, `check-1-factory-mode`,
`check-1-erased-storage`, `check-3-init` and `check-6-power-loss`. LED1 was not checked in `check-1`.

2 failed: `back-online` and `restore`, with `cloud not connected`. The board said `network not found`
22 times in that run and never joined. They were not repeated on 1.3.0. So the Wi-Fi checks of this
bench did not pass on this firmware.

A first run that day failed `boot-input` and `bootloader`, and is not in `results.jsonl`. Something
changed before the run above, and these logs do not say what.

## Over the air on the older shell firmware

All of this ran on the deployed AWS IoT, on 2026-10-31, with
[`firmware/tests/hil/ota_bench.py`](../firmware/tests/hil/ota_bench.py). The times count from the button
press, which that firmware waited for. Firmware from 1.7.2 on starts with no press, and these have not been timed there.

These results have four limits:

- **Firmware.** They were measured on firmware with the older Zephyr shell: test images 1.1.x, then
  1.2.0, on the bootloader from before the golden image. They have not been re-run on later firmware
  or on the bootloader that holds the pin:
  [see above](#over-the-air-on-the-final-firmware).
- **Console.** No run went through API Gateway or a console sign-in. Decline, both cancel runs and the
  update to 1.2.0 invoked the deployed API function directly, which bypasses both. The other runs,
  including the ten updates, stored the image in S3 and created the job directly with AWS credentials.
  Some of those images are ones the console refuses. Serial recovery used neither.
- **Cloud.** They ran against the cloud as deployed that day. The console was deployed again after
  these runs, on the evening of 2026-10-31 with security changes and on 2026-11-01 from commit
  5f8eb6d, and the runs were not repeated against it. Commit eecce27 changed the console's page after
  that, and has not been deployed.
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
| Serial recovery | Entered with `--reset`. An image signed with another key was refused: `Image in the primary slot is not valid!`. With no valid image left the bootloader stayed, the good image went in over UART in about 4 minutes (227 s), and the board reached AWS. This firmware has no serial console, so `--console` could not be tried, and Button 1 was not. |

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
