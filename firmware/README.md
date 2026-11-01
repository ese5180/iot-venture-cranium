# Firmware

Zephyr / nRF Connect SDK **v3.4.0** project for the nRF7002 DK
(`nrf7002dk/nrf5340/cpuapp/ns`). One `west build` produces three images:

| Image | Runs on | Role |
| --- | --- | --- |
| `mcuboot` | application core, secure | Bootloader. Verifies the ECDSA P-256 signature of the application image on every boot, installs updates from the secondary slot in external flash, and puts the previous image back if a new one is not confirmed. |
| `app` | application core | Trusted Firmware-M in the secure domain plus the non-secure application. This is the security domain of the product. |
| `netcore_blinky` | network core | Base-function domain: blinks LED2 once a second. No radio stack, no console, no keys. |

`app/` started as a copy of Nordic's `samples/net/aws_iot` from nRF Connect SDK v3.4.0;
files derived from it keep Nordic's copyright notice and licence identifier.

## Build

1. Install nRF Connect SDK v3.4.0 and its toolchain (nRF Connect for VS Code or
   `nrfutil toolchain-manager`).
2. Create the firmware signing key with `python tools/keys.py generate`, or put the
   team key at `~/.cranium/mcuboot_signing_key.pem`
   (see [`secrets/README.md`](../secrets/README.md)). The build stops with an
   explanation if it is missing.
3. From an nRF Connect SDK terminal:

   ```sh
   west build -b nrf7002dk/nrf5340/cpuapp/ns --sysbuild firmware/app
   west flash
   ```

   Use `west flash --recover` the first time a board is programmed with this project.
   It erases both cores, including anything stored by earlier firmware.

   The signed application image, the file the firmware console in the cloud takes, is
   `build/app/zephyr/zephyr.signed.bin`.
4. Provision the board (device ID, Wi-Fi network, device identity, cloud settings) with
   `python tools/provision_device.py`. [`docs/aws-iot.md`](../docs/aws-iot.md) lists
   what it needs and what it does.

Zephyr cannot build from a path that contains spaces. If your checkout is under such
a path, build through a symbolic link that has none.

## Layout

```
app/                     application-core image and the sysbuild configuration
  boards/                Kconfig and devicetree for the nRF7002 DK
  src/                   the application: Wi-Fi, AWS IoT, updates, the serial console
  sysbuild/mcuboot/      bootloader configuration
    golden/              the golden image's code, a module of the bootloader
  VERSION                firmware version; also the version written into the signed image
netcore/                 network-core image
certs/AmazonRootCA1.pem  root CA that tools/provision_device.py loads onto each board
keys/fw_signing_pub.pem  public half of the signing key
golden.json              the frozen golden image, written by tools/golden.py once there is one
tests/host/              host tests of the job parser, the version code and the console
tests/hil/               hardware test benches, and tests of the tools that talk to a board
```

The host tests need no board. Run them from an nRF Connect SDK terminal, which
provides the cJSON and base64 source they use: `make -C firmware/tests/host`. Then
`python3 firmware/tests/hil/test_board.py`, `python3 firmware/tests/hil/test_recover.py` and
`python3 firmware/tests/hil/test_golden.py` test the tools, the first of them against the
console's real code on a pseudo-terminal. The host tests compile the console's C files as they are, on a fake UART and a fake network
stack (`test_console.c`, `test_console_output.c`, `test_app.c`). What those fakes do is the
limit of what they show: what the real driver and the real Wi-Fi stack do is for
`tests/hil/console_bench.py` to find out.

## Memory map

Internal flash (1 MiB) and the 8 MiB external SPI flash:

| Region | Start | Size | Contents |
| --- | --- | --- | --- |
| `boot_partition` | `0x00000` | 64 KiB | MCUboot |
| `slot0_partition` | `0x10000` | 912 KiB | running image: TF-M (128 KiB) + application (784 KiB) |
| `tfm_storage_partition` | `0xf4000` | 48 KiB | TF-M internal trusted storage, NV counters, protected storage |
| `slot1_partition` (external flash) | `0x0` | 912 KiB | downloaded image waiting to be installed, then the previous image kept for revert |
| `golden_partition` (external flash, bootloader only) | `0x700000` | 912 KiB | the [golden image](#golden-image): the plain signed file, with no trailer |

## Serial console

The board is set up and debugged from a plain serial monitor, one command per line, on the
J-Link's second virtual COM port (`uart0`, 115200 baud). No host application is needed.
`tools/board.py` talks to it for the other tools. The console is a development and
provisioning feature: a release build turns it off with `-Dapp_CONFIG_APP_CONSOLE=n`, and
then no serial command exists at all, `BUTTON` included. Log messages then go nowhere. Such
an image keeps a log backend that throws them away (`src/log_discard.c`), because Zephyr's log
thread halts the board if there is none, with no output and before the watchdog is armed. The
link fails if an image ever has none.

Commands look like `COMMAND|arg1|arg2`. Command names can be in any case, and arguments
keep theirs. CR, LF and CRLF each end a line. Blank lines and leading whitespace are
ignored, backspace and DEL work, and typed characters are echoed unless `ECHO|OFF` was
sent. The last argument can contain `|`. A line over 384 bytes is discarded whole, and so is
one that lost bytes on the way in or holds a control character: it gets one `ERR`, and the
next line runs as usual. Whatever is sent while the board boots is thrown away.

Every command ends with one final line, `OK [details]` or `ERR <reason>`, and any other
lines of its reply come before that. Lines that start with a `[TAG]` are not replies: logs
such as `[ota] Image verified` or `[ota] WRN: ...`, and events such as
`[WIFI] connected ip=192.168.1.42 rssi=-51`. A boot starts with a status box whose lines
all start with `[BOOT]`.

| Command | | What it does |
| --- | --- | --- |
| `HELP` or `?` | * | list the commands, grouped, with the firmware version |
| `INIT\|<id>` | * | first-time setup: erase everything, store the ID, restart (see below) |
| `GET_ID` | * | `OK <id>\|<firmware version>`, with an empty ID if there is none |
| `THING` | * | `OK <thing name>`: the board's name in AWS IoT, from its SoC |
| `ECHO\|<ON or OFF>` | * | send typed characters back, or not; on again after a restart |
| `REBOOT` | * | restart |
| `ENTER_BOOTLOADER` | * | restart, for `tools/recover.py --console` to catch the bootloader |
| `SET_ID\|<id>` | | change the ID and keep everything else |
| `RESET_CONFIG` | | clear the cloud settings only; keep the ID, Wi-Fi, certificates and key |
| `FACTORY_RESET` | | erase everything, also the ID, and restart in factory mode |
| `WIFI\|<ssid>\|<password>` | | save a WPA2 network and start joining it |
| `WIFI_SEC\|<ssid>\|<WPA2_PSK or WPA2_PSK_SHA256 or WPA3_SAE>\|<password>` | | the same, with the security mode named |
| `CLEAR_WIFI` | | erase the network and disconnect |
| `NET` | | connection state, SSID, IP, RSSI and MAC |
| `CLOUD\|<endpoint>\|<download-url-prefix>` | | save where the board connects and downloads from; `CLOUD\|` clears them |
| `KEYGEN` or `KEYGEN\|REPLACE` | | create the device key inside TF-M and print a signing request, never the key |
| `STATS` | | a box with state, ID, firmware, Wi-Fi, uptime, free heap and last reset reason |
| `STATUS` or `STATUS\|<section>` | | the configuration: `device`, `wifi`, `cloud`, `certs` or `update` |
| `STREAM_START\|<total_bytes>\|<chunk_count>\|<crc16_hex>\|<CA or CERT>` | | start loading a certificate, at most 1800 bytes of DER |
| `STREAM_CHUNK\|<index>\|<base64>` | | the next piece of it |
| `STREAM_STATUS`, `STREAM_CANCEL` | | how far it is; give up on it |
| `BUTTON\|<1 or 2>` | | a short press of a button, by the path of the real one, for a test bench |

Only the commands marked * work in factory mode. The rules that apply to values:

* The ID is 1-32 letters or digits. It is a name for people, and it is not the cloud
  identity: the AWS IoT thing name stays `cranium-<SoC id>`, which is the certificate's
  subject and the MQTT client ID, and `SET_ID` cannot change it.
* An SSID is 1-32 bytes, and a password 8-63 characters. Anything else gets an `ERR`, and
  nothing is ever cut short. An SSID with a `|` in it is not supported.
* An empty password would mean an open network, and open networks are not allowed:
  `ERR open networks are not allowed`.
* Passwords and keys never appear in replies or logs, only as `set` or `unset`, and the
  line buffer is wiped after every command. An unknown command is shown only as far as its
  first `|` or blank. What is typed comes back while echo is on, which is why the tools turn
  it off. Nothing can read a stored secret back out.
* A stream's chunks must arrive in order, and a wrong index aborts it, also one that is no
  number. Nothing is stored
  before its CRC-16/CCITT-FALSE has been checked, and it is given up on after 30 quiet
  seconds.
* While an update is in progress or a new image is on trial, whatever could lose the
  trial's record or take the board off the network is refused with
  `ERR update in progress`: `FACTORY_RESET`, `RESET_CONFIG`, `INIT`, `SET_ID`, `CLEAR_WIFI`,
  and also `WIFI`, `WIFI_SEC`, `CLOUD`, `KEYGEN` and `STREAM_START`. Creating a key takes
  seconds, and an update can begin meanwhile: the old key is only given up afterwards, on the
  main loop, if none has.

Joining a network does not block anything. `WIFI` replies as soon as the network is saved,
and the result follows as `[WIFI] connected ip=... rssi=...` or
`[WIFI] failed reason=...`, for example `wrong password` or `network not found`. The board
tries again every 30 seconds, and joins the stored network at every boot. It counts as
connected once it has an IPv4 address, which is what the cloud is reached over: an IPv6
address, which can arrive seconds earlier on a network that offers one, is not enough.

The console runs as a low-priority task. It reads and changes what the main loop owns by
having the main loop do it (`console_port_on_main()`), so everything there still happens
one event at a time. What cannot harm an update it does itself: reading atomics, the device
ID and the credential stores, asking the Wi-Fi stack for its status, and creating a key in
TF-M. Output goes through one ring buffer, whole lines only, and is sent by interrupt. The
console task waits for room, so a reply is never lost. Other threads do not, so a log line
that does not fit is dropped and counted (`[CONSOLE] WRN: 3 lines dropped`). The watchdog
stays with the main loop, which keeps running whatever the console does.

## Factory mode

A board boots into factory mode if its init-complete flag is missing or its stored ID is
not valid. The event loop, the watchdog and LED1 keep running, the board stays off the
network, and everything but the commands marked * above replies
`ERR factory mode, send INIT|<id> first`.

`INIT|<id>` checks the ID before touching anything, erases all persistent settings, writes
the ID, reads it back, writes the flag last, and restarts. If a step fails, the reply names
it and the board stays up. A power cut anywhere before the flag leaves the board in factory
mode. The same goes for a power cut during a factory reset: its first write marks the flag
as being erased. That mark stays if an erase fails, by `FACTORY_RESET` or by Button 2, so the
board comes back in factory mode with whatever is left, and `INIT` erases again.

A board that was provisioned by firmware from before this flag (it has cloud settings, a
private key and a certificate, but no flag) does not end up in factory mode, because an
update on trial could then never confirm itself. It gets the 16 hexadecimal digits of its
SoC's identifier as its ID, logs `[CONSOLE] migrated: ...` and boots normally. A provisioned
board whose flag or ID cannot be read, because storage failed, runs normally too, and writes
nothing: one failed read must not take it off the network.

## Tools

| Tool | What it is for |
| --- | --- |
| `tools/board.py` | Talking to the console, for the tools below. It can also read the status of, and press a button on, firmware from before the console, which has a Zephyr shell there, so that an update from it can be followed. |
| `tools/provision_device.py` | Provision a board, unattended if the Wi-Fi secrets file is unlocked. A board in factory mode gets `INIT` first, with `--id` or else its SoC's identifier. |
| `tools/recover.py` | Install an image through the bootloader's serial recovery. MCUboot listens for half a second after every reset, and it is not updated over the air, so there is no other way in: `--console` sends `ENTER_BOOTLOADER` and catches that half second, with no debugger. |
| `tests/hil/ota_bench.py` | Hardware tests of firmware updates. |
| `tests/hil/console_bench.py` | Hardware tests of this console. `console_bench.py plan` shows what it would do, and which steps erase the board. It runs nothing until told to with `run --no-erase` or `run --erase`. It checks first that it could provision the board again, does so after erasing it, and keeps a note of whatever is not undone yet, so that `console_bench.py restore` can put it right after an interrupted run. |
| `tools/golden.py` | Freeze the [golden image](#golden-image), record what qualified it, check that the manifest, the bootloader's configuration and the file agree, and send it through serial recovery. |
| `tests/hil/golden_bench.py` | Hardware tests of the golden image, with no Wi-Fi. `golden_bench.py plan` lists them and touches nothing, and `golden_bench.py images` builds the fault images they upload. |
| `tests/hil/build_image.sh` | Build a signed test image from a scratch copy, for example with `-Dapp_CONFIG_APP_TEST_FAULT_INIT_POWER_LOSS=y`, the image that loses power in the middle of `INIT`. |

## What the LEDs show

* **LED1** is driven by the application core and shows its state:
  * a long flash (half a second) every two seconds: factory mode, waiting for `INIT`
  * a short flash every two seconds: set up, but not provisioned yet
  * slow blink: joining Wi-Fi
  * medium blink: connecting to AWS IoT
  * steady: connected, nothing to do
  * fast blink: an update is waiting for a button press
  * double flash: downloading or checking an update
  * triple flash: a new image is running on trial
* **LED2** is driven by the network core and keeps blinking whatever the application
  core is doing.

## Buttons

* **Button 1** installs an update that is on offer. **Button 2** declines it.
* Holding **Button 2** for five seconds and releasing it erases everything provisioned
  onto the board (device ID, Wi-Fi network, cloud settings, device key and certificates)
  and restarts it in factory mode, like `FACTORY_RESET`. It does nothing while an update
  is offered or under way.
* A button that was already down when the application started does nothing when it is let
  go: only a press that was seen counts. So holding Button 2 through a boot, for the
  [golden image](#golden-image) for example, can never turn into that factory reset.

## Golden image

The golden image is one image a person can always go back to, at the board, with no laptop,
no Wi-Fi and no cloud. It is sealed in external flash, and only the bootloader can restore it,
only under a physical gesture, and only if it is the one image pinned by a digest compiled into
the bootloader. There is no cloud, job, console, serial or automatic way to start this.

`CONFIG_CRANIUM_GOLDEN` is **off** in the bootloader's committed `prj.conf`, and stays off until
an image has been frozen. With it off nothing of this is built into the bootloader. The one
trace is `golden_partition` in its devicetree, which adds one 16-byte entry to its flash map. With it
on, the bootloader was 50,324 bytes of its 64 KiB when this was written, against 47,452 with it off.
Both counts include the check on serial recovery's image number, described under
[Who can change it](#who-can-change-it), which is built in either way.

### The gesture

**Only on a board whose bootloader was built with `CONFIG_CRANIUM_GOLDEN=y`. On any other board this
can wipe it.** Its bootloader does not wait for the button, so the application starts with the button
down. Unless the application has the button fix in `ui.c`, letting go then counts as a long press,
which is the factory reset under [Buttons](#buttons). Firmware 1.3.0 and older do not have that fix.

1. Press and hold RESET.
2. Press and hold Button 2.
3. Let go of RESET.
4. Keep holding for 5 s, until LED1 blinks fast.
5. Let go of Button 2 within the next 5 s.

LED1 then stays on while flash is being written. From power-off, hold Button 2 and power on.
RESET goes first because holding Button 2 while the application runs, and letting go, is the
factory reset.

| What the button does | What happens |
| --- | --- |
| Not down when the bootloader reads it | A normal boot. This costs about 100 µs: setting up the pin, one reading of it, and letting it go again |
| Let go before 5 s | A normal boot, nothing written |
| Let go between 5 s and 10 s | The gesture fires |
| Still down at 10 s | LED1 goes off: cancelled. The bootloader waits for the release, so that the application does not start with the button down |
| Still down at 60 s | The bootloader logs it and boots anyway, so that a stuck button cannot brick the board |

A release has to last 100 ms to count, and its time is when the button came up.

### What the bootloader then does

It checks the primary slot and the golden copy before it erases anything. To pass, an area's
bytes must have a good signature (the same check as any image, with the key inside the
bootloader), and their digest must equal the pin.

| Primary slot passes | Golden copy passes | What it does |
| --- | --- | --- |
| no | yes | **Restore**: erase the primary slot, its trailer first and its image header next, then the secondary slot, copy the golden image across, and restart |
| yes | no | **Seal**: erase the golden partition, copy the running image into it, and restart |
| yes | yes | Nothing: one slow blink, and it boots |
| no | no | **Refuse**: three slow blinks, nothing written, and the boot goes on, which ends in serial recovery if no image is valid |

The code cannot start an image, because it has no access to what the bootloader boots. After
writing anything it restarts, so the bootloader's own check on every boot decides whether the
result runs. A restore that is interrupted leaves no valid image and serial recovery, and a repeat
of the gesture finishes the job.

The header goes right after the trailer so that this is true almost at once. Between the two, for the
time of one sector erase (about 86 ms, worked out from how long the whole slot takes), the old image
still boots with no trailer. An image that was on trial loses its revert that way. If it is the target
of an update, the application reports that update as failed with `trial_lost` and not as a success.
Repeat the gesture to finish the restore.

After a restore by the gesture TF-M storage is untouched, so identity, Wi-Fi settings and
certificates remain. There is no trailer and nothing in the secondary slot. `tools/golden.py restore`
goes through serial recovery instead, which writes the primary slot only: there is no trailer either,
but the secondary slot stays as it was, and an image waiting there for a swap would still get it.

### Who can change it

- Only the bootloader writes `golden_partition` in normal use, and only with the bytes of a primary
  slot that passed. The partition is declared in the bootloader's overlay only.
- Serial recovery cannot reach it. An upload names an image number, and MCUboot uses that number with
  no bounds check to look up a flash area in a table, so what lies past the end of the table used to
  pick the target: `golden_partition`, TF-M storage or the bootloader's own partition, with nothing
  locked yet. `golden/src/image_number_guard.c` refuses every number but 0. It is built in with
  `CONFIG_BOOT_FLASH_AREA_HOOKS`, with or without the golden image. A bootloader without it, which is
  every board flashed before this was added, still has the hole. Only a debug-port flash closes it.
- The non-secure application owns the SPI bus of the external flash, so it can erase or damage the
  copy. That loses the way back, and the loss is only noticed at the next gesture, but nothing it
  writes there can be restored, because anything but the pinned image is refused.
- The pin is in the bootloader's write-protected flash, so replacing the image takes a reviewed
  commit and a debug-port flash of the bootloader. Over the air there is no way, and a leaked signing
  key cannot change it.
- The downgrade check does not apply to a restore, which is not a swap, so it is the pin and the
  gesture that close rollback at will. After a restore the version floor is the golden image's,
  and a signed release older than the one that was running becomes acceptable again: revoke a bad
  release on the console.

### Freezing an image

1. Set a new version in `app/VERSION`, commit, and build from a clean tree, with
   `west build --pristine`. The image lands in `binaries/`. `tools/golden.py freeze` refuses an image
   built with uncommitted changes, a tree with uncommitted changes, an image from before the latest
   commit (`--older-commit` is the way round that) and an image built with `-D` settings, which stay
   in a build directory until it is removed.
2. `python tools/golden.py freeze binaries/cranium-<version>.signed.bin`. This verifies the
   signature with `keys/fw_signing_pub.pem`, copies the file to `binaries/golden/`, writes
   `golden.json`, and sets the three lines in `app/sysbuild/mcuboot/prj.conf`. Commit those two
   files. The image's digest does not depend on the pin, so this does not change the image.
3. Save the bootloader that is on the board now: `golden_bench.py run G0` reads it back through
   the debug port, into `binaries/golden/mcuboot-before-golden.hex`.
4. Rebuild, check that the build used the pin with
   `python tools/golden.py check --config build/mcuboot/zephyr/.config`, and flash the bootloader only.
   This is the command the bench uses (G3), and its options are what keeps TF-M storage and provisioning:

   ```sh
   nrfutil device program --serial-number <probe> --firmware build/mcuboot/zephyr/zephyr.hex \
     --options chip_erase_mode=ERASE_RANGES_TOUCHED_BY_FIRMWARE,verify=VERIFY_READ
   nrfutil device reset --serial-number <probe> --reset-kind RESET_PIN
   ```

5. `python tools/golden.py restore --reset --serial-number <probe>` puts the image in the primary slot,
   in about 4 minutes.
6. Do the gesture. The bootloader's log, on the board's first virtual COM port, says `sealed`.
   Do it again, and it says `nothing to do`.
7. `python tools/recover.py --reset --serial-number <probe> list` shows a hash equal to `hash_tlv` in
   `golden.json`.
8. When the image has passed the bench on this bootloader, and its over-the-air regression, record
   that: `python tools/golden.py qualify "<the bench run>"`, and commit `golden.json`. The regression
   needs this bootloader, so it comes after the freeze. `golden.py check --qualified` insists on it.
   A run that qualifies has `"rehearsal": false` in `results.jsonl`, with the image's and the
   bootloader's SHA-256, and no `PARTIAL`: `qualify` takes your word for that, and does not read the file.

The image file is not in git, because the repository is public. Keep a copy with whoever holds
the signing key.

Any release that changes a stored record has to re-pin: `store_read` needs an exact record size, so
an older image could not read it. Rotating the signing key means a debug-port flash already, so
freeze again in the same session. Do not turn on `CONFIG_MCUBOOT_HW_DOWNGRADE_PREVENTION` without
freezing again, or the counter refuses the golden image.

### Restoring a board

| What you see | What to do |
| --- | --- |
| The image is bad, the golden copy is good | The gesture. It says `restored`, and the board runs the golden image |
| Three slow blinks and `refused`: neither copy is the pinned image | `python tools/golden.py restore --reset --serial-number <probe>` to put the image back, then the gesture, which says `sealed` |
| A restore was interrupted, and the board sits in serial recovery | The gesture again |
| No gesture is possible, or the bootloader has no golden image | `python tools/golden.py restore --reset --serial-number <probe>` |

After `tools/golden.py restore` the secondary slot is as it was, and a gesture does not change that,
because the primary slot then passes and there is nothing to restore. `python tools/recover.py --reset
list` shows whether it holds an image. An image there only runs if a swap was asked for, and serial
recovery never asks for one. With Button 2 stuck down, the bootloader only listens after its 60 s: pass
`--wait 150` to `recover.py`.

### Going back to the old bootloader

The debug port on the DK is open, and the old bootloader has the same key, so the running image
stays valid and what is left in the golden partition is ignored:

```sh
nrfutil device program --serial-number <probe> \
  --firmware binaries/golden/mcuboot-before-golden.hex \
  --options chip_erase_mode=ERASE_RANGES_TOUCHED_BY_FIRMWARE,verify=VERIFY_READ
nrfutil device reset --serial-number <probe> --reset-kind RESET_PIN
```

**Do not leave out `--options`:** the default erases everything, TF-M storage and provisioning
included.

**After this, do not do the gesture on this board.** The warning under [The gesture](#the-gesture) applies
to it again. Going back also brings back the hole in serial recovery's image number.

### What this does not protect against

- An unattended board: with a bad image and nobody there, it stays bad. This is the cost of refusing
  every automatic trigger.
- A dead external flash, which loses the golden copy, and which stops the bootloader from booting
  anything, as it does without this feature. Only the debug port helps then.
- A person with hardware access, who can go back to the pinned image and its known flaws. Serial
  recovery still installs any image ever signed with this key, and the debug port is open. A product
  build should drop serial recovery, lock the port and keep the gesture.
- A compromised application, which can erase the copy, and which can read the device's keys. A
  restore removes the application, but does not revoke what it read: retire that board's certificate.
- A compromised application that wants an older image. It can write the primary slot's trailer, and a
  revert skips the downgrade check (`check_downgrade_prevention()` runs for the swap types test and
  permanent). So it can ask for a swap back to an older image in the secondary slot, and the golden
  copy gives it a validly signed older image on a flash chip it controls, with no network needed. It
  still cannot run anything unsigned this way. This was read from MCUboot's source and has not been
  run. The same is true of any older signed image it can get hold of.
- A leaked signing key: the pin limits this path only. Over the air and serial recovery would take the
  attacker's images.
- A golden image that is too old for the cloud. It runs, and cannot update itself: a serial upload moves
  it forward.
- Anything that holds P1.09 low. It is also Arduino pin D7, so a shield that does this delays every boot
  by 60 s, and could fire the gesture if it lets go at the wrong moment.

### Tests

`make -C firmware/tests/host` tests every timing of the gesture, the table above, the order of a
restore's erase, the image number check and the button fix. `python3 firmware/tests/hil/test_golden.py`
tests what the tool refuses and how the bench drives the debug port, and runs the whole bench on a
stand-in for the board. `python3 firmware/tests/hil/golden_bench.py` runs the rest on a board, with no
Wi-Fi: see `golden_bench.py plan`. By default it needs nobody. It holds the button from the debug port,
by driving P1.09 low once the bootloader has configured the pin, and the bootloader has no test code
for this.

That stand-in has limits, and a test it cannot finish ends as `PARTIAL`, not `PASS`, with the part that
did not run in its line of `results.jsonl`. It cannot hold the button down into the application, because
every stage of the boot configures the pin again, so G5c leaves out the check in `ui.c` and G5f reaches
it from the input driver on. And it is not a hand. A reading of the pin before the breakpoint would not
be seen on the bench, though with a hand it would stop the gesture: `test_golden.py` checks the source
for one, and only a person can check the rest. Before an image is frozen or the gesture is taught, a
person runs G4, G5a to G5e with `--gesture person`, and G5d and G11 with `--power-cuts` as well.
