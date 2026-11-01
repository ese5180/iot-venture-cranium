# Firmware

Zephyr / nRF Connect SDK **v3.4.0** project for the nRF7002 DK
(`nrf7002dk/nrf5340/cpuapp/ns`). One `west build` produces three images:

| Image | Runs on | Role |
| --- | --- | --- |
| `mcuboot` | application core, secure | Bootloader. Verifies the ECDSA P-256 signature of the application image on every boot, installs updates from the secondary slot in external flash, and puts the previous image back if a new one is not confirmed. |
| `app` | application core | Trusted Firmware-M in the secure domain plus the non-secure application. This is the security domain of the product. |
| `netcore_blinky` | network core | Base-function domain: blinks LED2 once a second. No radio stack, no console, no keys. A build for [firmware update over Bluetooth](#firmware-update-over-bluetooth) has `hci_ipc` here instead. |

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
  bt_ota_sysbuild.conf   the one switch for firmware update over Bluetooth, off unless given
  bt_ota.conf            what that switch adds to the application
  sysbuild/hci_ipc.conf  what it sets for the Bluetooth controller on the network core
  sysbuild/mcuboot/      bootloader configuration
    golden/              the golden image's code, a module of the bootloader
  VERSION                firmware version; also the version written into the signed image
netcore/                 network-core image
certs/AmazonRootCA1.pem  root CA that tools/provision_device.py loads onto each board
keys/fw_signing_pub.pem  public half of the signing key
golden.json              the frozen golden image, firmware 1.5.0, written by tools/golden.py
tests/host/              host tests of the job parser, the version code, the console and Bluetooth updates
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
| `tests/hil/golden_bench.py` | Hardware tests of the golden image, with no Wi-Fi but for G15 and G16. `golden_bench.py plan` lists them and touches nothing, and `golden_bench.py images` builds the fault images they upload. |
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
* In a build for [firmware update over Bluetooth](#firmware-update-over-bluetooth), LED1 also shows
  four short flashes while Bluetooth is open, and LED2 stays dark.

## Buttons

* **Button 1** installs an update that is on offer. **Button 2** declines it.
* Holding **Button 2** for five seconds and releasing it erases everything provisioned
  onto the board (device ID, Wi-Fi network, cloud settings, device key and certificates)
  and restarts it in factory mode, like `FACTORY_RESET`. It does nothing while an update
  is offered or under way.
* In a build for [firmware update over Bluetooth](#firmware-update-over-bluetooth), holding
  **Button 1** for five seconds and letting go opens Bluetooth for two minutes, unless an update is
  on offer. Then it is what it always was. `BUTTON|1` on the console opens nothing.
* A button that was already down when the application started does nothing when it is let
  go: only a press that was seen counts. So holding Button 2 through a boot, for the
  [golden image](#golden-image) for example, can never turn into that factory reset.

## Firmware update over Bluetooth

An image can be uploaded from a phone over Bluetooth LE, with nothing of the cloud involved, for a
board that has no Wi-Fi in reach. It is off in a normal build, and the network core needs a
debug-port flash to have it at all.

**None of this has been on the air.** It has been built, its logic has been tested on a host against
fakes, and nothing else: see [Testing it](#testing-it). Whether a phone pairs, how fast an upload goes
and how it gets along with Wi-Fi are what a person still has to find out.

```sh
west build -b nrf7002dk/nrf5340/cpuapp/ns --sysbuild firmware/app -- -DSB_EXTRA_CONF_FILE=bt_ota_sysbuild.conf
```

That one file sets `SB_CONFIG_APP_BT_OTA`, which applies `bt_ota.conf` to the application, and
`SB_CONFIG_NETCORE_HCI_IPC`, which puts Zephyr's `hci_ipc` with the SoftDevice Controller on the
network core in place of the blinky. It needs the console, which is the only way to see a passkey, so
the build stops if it is combined with `-Dapp_CONFIG_APP_CONSOLE=n`. The bootloader and TF-M come out
the same either way.

| Image | Off | On | What it has |
| --- | --- | --- | --- |
| Application, flash | 627,836 | 705,052 | of 794,474 bytes |
| Application, RAM | 359,328 | 393,884 | of 409,600 bytes |
| Network core, flash | 19,024 | 133,232 | of 256 KiB |
| Network core, RAM | 4,240 | 35,168 | of 64 KiB |
| MCUboot, flash | 50,324 | 50,324 | the same file |
| TF-M, flash | 130,008 | 130,008 | the same, but for the build time in its banner |

With it off, the application's `.config` and `zephyr.bin` are the same as before, byte for byte. Only
the sysbuild `.config` has one more line, `# SB_CONFIG_APP_BT_OTA is not set`.

The TLS buffers and everything else that Wi-Fi uses are the same with it on. The system heap is 4,096
bytes larger, because Bluetooth takes from it at the first press and Wi-Fi should not notice. What it
adds takes the RAM that nothing was using.

Firmware with the switch is not kept in `binaries/`: `tools/store_binary.py` says so and leaves
`latest.signed.bin` alone, so that `scripts/ota.sh` cannot pick it up by accident. Take it from the
build directory. `src/bt_ota.c` stops the build if one of the options the security rests on changes:
the characteristic's permission, LE Secure Connections only, no bonds, a passkey drawn by the host, the
image group as the only group, and Bluetooth as the only transport.

### What happens

1. Hold **Button 1** for five seconds and let go. Only a real press counts. `BUTTON|1` on the console
   does not, and neither does anything from the cloud. Bluetooth has not even been started until
   this first press. LED1 shows four short flashes, and the console says `[BT] open for 120 s`.
2. The board advertises as `Cranium-` and four hexadecimal digits, drawn anew for each window, and on
   the console as `[BT] advertising as Cranium-1A2B`. Its address is a resolvable private one that
   changes every 15 minutes (`CONFIG_BT_PRIVACY`), with a key drawn at each start that is never handed
   to anyone. Two windows within those 15 minutes do show the same address. Nothing that identifies the
   board in the cloud goes on the air.
3. A phone connects, and has to pair: LE Secure Connections with MITM protection and a 16-byte key,
   and nothing else. The board prints `[BT] passkey 123456`, and the person types that on the phone. A
   new one is drawn for each attempt. Three failed attempts close the window. No bond is kept, so a
   phone that pairs today has no way back in tomorrow.
4. The phone uploads a signed image to the secondary slot. The first piece has to show an image
   header with a version strictly newer than what runs, for image 0, no longer than what stops short
   of the trailer. Anything else is refused there, before anything is written. While this goes on,
   the board is in the update state `bluetooth`: no cloud update starts, a job waits, and whatever an
   update refuses on the console and by Button 2 is refused.
5. When it has all arrived, the board says what it got, `[BT] firmware 1.6.0+0 has arrived, hash ...:
   press Button 1 to install it, Button 2 to erase it`, and LED1 blinks fast. If nobody presses
   either within two minutes, it is erased, and so is a whole image in a window that closes for any
   other reason. A reset during those two minutes leaves it where it is. That is no different from the
   previous image, which stays in the slot after any update: without a swap request the bootloader
   ignores it, and the only way to one is to upload the image again and press Button 1.
6. Button 1 writes the record, asks the bootloader for a **trial** swap, and restarts: the same call
   as a cloud update, in the same order. MCUboot checks the signature and the version, as it always
   does. An image it does not like is not installed.
7. The image runs on trial. See [The trial](#the-trial).

Button 2 closes the window at any point, and advertising stops at the end of the window or when a
phone connects. A phone that does not finish pairing is dropped after 45 s, and an authenticated link
on which nothing happens after 30 s. A link that keeps busy can outlast the window, because an upload
takes a while, up to 15 minutes in all, plus the two minutes of the offer if the image got there in
time. The window does not open again by itself after that, and it will not open again while the last
phone has not gone, so that a new window always takes a new pairing.

### What a phone can do

| Command | |
| --- | --- |
| `image list` | Allowed on an authenticated link. It is the last step of a proof |
| `image upload` | Allowed on an authenticated link, in a window that takes uploads, until one has arrived |
| `image test`, `image confirm` | **Refused** |
| `image erase` | **Refused** |
| Anything else | Not built in: there is only the image group. No reset, no shell, no files |

All of this is a hook in front of every command, which goes by the policy in `src/bt_ota_policy.c`.
The characteristic also has MCUmgr's own permission for an authenticated link, and
`CONFIG_MCUMGR_GRP_IMG_ALLOW_CONFIRM_NON_ACTIVE_SLOT` is off, which is what would otherwise make an
update permanent, with no revert, from a single command.

MCUmgr's erase takes a slot number from the phone, and on trial the secondary slot holds the image to
go back to. That is why it does not exist here. For the same reason nothing can be uploaded on trial.

This means that Device Manager's **Firmware Upgrade** fails at its last step, when it asks for a
test. The image has arrived by then, and the board offers it. Use **Image Upload** instead.

### What a board with nobody there can be made to do

Nothing that lasts:

- It does not advertise, and its host does not even run, until someone has held the button. The
  cloud, the console, a restart and a stuck button cannot change that: a press only counts when it is
  let go, and one that was already down at boot does not count at all.
- With the window open and nobody there, an attacker within range needs a passkey that only comes out
  on the serial port. Three wrong tries close it, and it closes by itself anyway.
- Nothing installs without a second press, and nothing a phone sends can ask for a swap.
- An image on trial with nobody there reverts, unless it reaches the cloud by itself.
- A window will not open while a cloud update is on offer or under way, or on a board in factory mode
  or not provisioned yet.

It will not open either while the record of a cloud update is waiting. `ota_init()` works out what
became of a job from the running version, so a Bluetooth update in between would have it report
`rolled_back` for an update that went fine. On a board that stays out of Wi-Fi's reach with such a
record, that means no Bluetooth update until it has been online once.

### The trial

An image installed over Bluetooth is not confirmed on boot. Over Wi-Fi the rule is that it must join
Wi-Fi and authenticate to AWS IoT within five minutes, because then it can receive a further update,
and so is safe to keep. On a board with no Wi-Fi in reach that rule would revert every image, so
there it has to be replaced by something that means the same.

**The rule: an image is kept when it can be shown to be able to receive a further update, by whichever
path there is, and no such proof means it reverts.** Either of these:

1. **It reaches the cloud.** The same as any image, and nobody has to do anything. The record says
   `proof: cloud`.
2. **A person proves it over Bluetooth, and only with no Wi-Fi.** That is, the Wi-Fi stack says the
   board is not associated with an access point. On the running image, a person holds Button 1, pairs
   a phone with a new passkey, and reads the image list over that link. That takes the button, the
   console, the controller, an authenticated link, MCUmgr and the external flash, which is the whole
   way a further update would come in. It is also needed that:
   - the image has run for at least 60 s (`CONFIG_APP_BT_OTA_TRIAL_MIN_SECONDS`), with its main loop
     feeding the watchdog, so that it does not fall over soon after starting
   - the board is still provisioned, so that the image can read what TF-M keeps for it
   - the Wi-Fi stack has reported the result of a join attempt, `network not found` being a fine
     result, so that the driver, its firmware and the supplicant all run
   - the link is the one the list was read on

   The record says `proof: person`.

The deadline is the same five minutes, and with neither proof by then the board restarts and the
bootloader goes back. A hang or a crash goes back sooner. The phone has no part in this beyond the
above: it cannot confirm anything. An image that a cloud job installed can only be proved by the
cloud, as before, and so can one on trial with no record of how it got there.

**With Wi-Fi there, a person has no say.** Associated counts, with or without an address, and so does a
Wi-Fi stack that cannot say. An image that has the network and cannot get to the cloud, or cannot even
get an address on it, is exactly what the trial is there to catch, so it reverts.

What this gives up, knowingly: a person can keep an image whose TLS, device key or cloud connection
is broken, because none of that can be tried with no network. Such an image stays, and only another
Bluetooth update can move it. `proof: person` in the record is the way to see which boards that could
be. An image with a broken Bluetooth stack can still be kept by the cloud, and then only the cloud can
move it. A person can also get a bad signed image kept on purpose, but a person at the board could do
much the same with serial recovery.

### The record

There is no job to carry an update like this, so one record of the last one stays in TF-M storage
(`STORE_BT_OTA_RECORD`, 36 bytes), through firmware updates, until a factory reset on an image with this
option. It goes on the console at every boot, and into the device shadow whenever the board connects:

```json
{"bt":{"from":"1.5.0+0","to":"1.6.0+0","result":"succeeded","proof":"person","count":3}}
```

`result` is `pending`, `succeeded`, `rolled_back`, `not_installed`, `trial_lost`, `superseded` (a
cloud job has installed something else since) or `flash_error`. It is a report of its own, sent
again at every connection, so that it cannot make the regular report too long for its buffer and so
that nothing depends on it arriving.

`not_installed` only says that the image never got as far as `ota_init()`. The bootloader may have
refused it, but it may also have started, and crashed or lost power before that point, and then been
reverted, which is a `rolled_back` by any other name. Only code in the new image could tell, and a cloud
update reports the same.

The console in the cloud does not show the record yet. It does not know the state `bluetooth` either:
its API leaves out what it does not know (`OTA_STATES` in `cloud/api/src/lib/shadow.mjs`), so a board
with an open window reads `Nothing reported` under its updates there.

An image built without this option leaves the record where it is and does not look at it, also when
it is factory reset. An image on trial with no knowledge of Bluetooth can only be proved by the cloud.

### Wi-Fi and Bluetooth on this board

Both radios are on 2.4 GHz, and the DK has what it takes to arbitrate between them: the nRF7002's
Packet Traffic Arbiter, wired to the nRF5340 (`nrf_radio_coex`, P0.24, P0.28, P0.29, P0.30), and a
switch on P1.10 between a separate antenna for Bluetooth and a shared one.

**The arbiter is not turned on.** Turning it on means `CONFIG_NRF70_SR_COEX` in the application and
`CONFIG_MPSL_CX` on both cores, which changes how the Wi-Fi driver starts and adds calls after each
join, and Nordic's own samples carry notes about Bluetooth link timeouts when Wi-Fi is granted the
radio, and about a crash, with coexistence on. All of that would be new, and untested here, in the
path the cloud updates depend on. What is lost is performance, not safety: without it the two radios
can collide, and each retries. During a Bluetooth session there is no download to collide with, since
no cloud update can run, only a keep-alive. And a board with no Wi-Fi in reach, which is what this is
for, is not transmitting much. If a person finds that uploads fail or MQTT drops during a session, the
arbiter is the first thing to try.

P1.10 is driven low when Bluetooth starts, for the separate antenna. Nothing else in this project
drives it, and Nordic's documentation describes that as the setting for separate antennas. Nobody has
measured how far apart two antennas this close really are.

### What this does not protect against

- A person at the board with the passkey, who can install any newer image ever signed with this key.
  It is the same person that serial recovery and the debug port already let in.
- Someone who reads the serial port from afar, say on a logged bench, and has a phone in range during
  a window that a person opened. The passkey is only good for one attempt.
- A denial of service during a window: an attacker can fail pairings and close it. A person presses
  again.
- A leaked signing key: the bootloader's check is what decides what runs.
- A compromised application, which can write the secondary slot anyway.
- A controller that stops answering once Bluetooth has been started. The Bluetooth host treats that as
  fatal, so the application halts and the watchdog restarts it, in up to two minutes. Before the first
  press of a boot it cannot happen, because no command goes to the controller. After that it can, even
  with the window closed, because a new private address is set every 15 minutes until the next restart:
  one command, and nothing on the air. A cloud update that was running is then interrupted, as by any
  restart.

### Before relying on it

Stack sizes and the heap have not been measured, because that takes a board with Bluetooth running.
Callbacks of the Bluetooth threads hand everything to the main loop, so that printing does not run on
those stacks, but pairing and the upload still do. On the first bring-up, build with

```sh
-Dapp_CONFIG_THREAD_ANALYZER=y -Dapp_CONFIG_THREAD_ANALYZER_USE_LOG=y -Dapp_CONFIG_THREAD_ANALYZER_AUTO=y \
  -Dapp_CONFIG_THREAD_ANALYZER_AUTO_INTERVAL=10 -Dapp_CONFIG_THREAD_NAME=y
```

and go through a pairing, a whole upload and a proof. Look at:

- The Bluetooth receive thread (2,048 bytes, `CONFIG_BT_RX_STACK_SIZE`), its long work queue (1,800,
  where the keys are worked out through TF-M), its transmit thread (688), the MCUmgr work queue (4,608,
  `CONFIG_MCUMGR_TRANSPORT_WORKQUEUE_STACK_SIZE`, which runs down to the flash driver), and the IPC work
  queue (1,024). Under a quarter free on any of them means raising it.
- `Free heap` in `STATS` before the first press, after it, after an upload, and during a cloud update
  with a window having been open before. It should not be lower than on a build without the option,
  which takes the same `STATS` line. The IPC takes its queues from this heap at the first press.
- TF-M's crypto during a pairing with TLS sessions open: `pairing failed` or a TLS handshake failing
  at that moment would point at its memory (`CONFIG_TFM_CRYPTO_ENGINE_BUF_SIZE`, the same as without
  this option).

The network core's stacks are `hci_ipc`'s own, and nobody here has seen them run on this board either.

### Testing it

Host tests, with no board: `make -C firmware/tests/host` runs `test_bt_ota_policy.c`, every decision;
`test_bt_ota.c`, `src/bt_ota.c` against a fake of the Bluetooth host, MCUmgr and the bootloader that only
reaches what has registered itself for that event; and `test_ota_bt.c`, what the option adds to `ota.c`.
The rest of `ota.c` is compiled there but not exercised: a cloud update stays with `tests/hil/ota_bench.py`.
It also runs the console's, the main loop's and the buttons' tests a second time with the option on.
`test_golden.py` checks that `tools/store_binary.py` keeps such a build out of `binaries/`.

Everything else takes a person, with [nRF Connect Device Manager](https://www.nordicsemi.com/Products/Development-tools/nRF-Connect-Device-Manager)
on a phone, a serial monitor on the console, and the debug port. **None of this has been run.**

**Set up.** Build image A, what runs to begin with, and for each install below an image newer than
what runs by then, with the switch. `KIND` keeps their build directories apart:

```sh
KIND=bta firmware/tests/hil/build_image.sh 1.5.1 0 build-bench/images/bt-a.bin -DSB_EXTRA_CONF_FILE=bt_ota_sysbuild.conf
KIND=btb firmware/tests/hil/build_image.sh 1.5.2 0 build-bench/images/bt-b.bin -DSB_EXTRA_CONF_FILE=bt_ota_sysbuild.conf
KIND=hang firmware/tests/hil/build_image.sh 1.5.9 0 build-bench/images/bt-hang.bin -DSB_EXTRA_CONF_FILE=bt_ota_sysbuild.conf \
  -Dapp_CONFIG_APP_TEST_FAULT_HANG=y
```

Then flash the network core and image A, both over the debug port. **Do not leave out `--options`:** the default
erases everything, TF-M storage and provisioning included.

```sh
nrfutil device program --serial-number <probe> --core Network \
  --firmware build-bench/build-bta/hci_ipc/zephyr/zephyr.hex \
  --options chip_erase_mode=ERASE_RANGES_TOUCHED_BY_FIRMWARE,verify=VERIFY_READ
nrfutil device program --serial-number <probe> \
  --firmware build-bench/build-bta/app/zephyr/zephyr.signed.hex \
  --options chip_erase_mode=ERASE_RANGES_TOUCHED_BY_FIRMWARE,verify=VERIFY_READ
nrfutil device reset --serial-number <probe> --reset-kind RESET_PIN
```

The bootloader stays as it is. Copy the other images to the phone.

**What counts as passing:**

| | Do this | It passes if |
| --- | --- | --- |
| 1 | Scan with the phone before pressing anything | The board is not there |
| 2 | Send `BUTTON\|1` on the console, and press Button 1 briefly | Still not there, and LED1 does not change |
| 3 | Hold Button 1 for 5 s, and let go. Do nothing for 2 minutes | Four flashes, `[BT] open for 120 s`, seen on the phone. Then `[BT] closed`, and gone from the phone |
| 4 | Open it, connect, and type a wrong passkey, three times | `[BT] closed: too many failed pairings` |
| 5 | Open it, connect, and try to upload without pairing, by declining the prompt | Nothing is written |
| 6 | Open it, pair with the passkey from the console, and look at the phone's bond list | Paired for this link, and no bond afterwards |
| 7 | On that link, **Images > Test** and **Confirm**, and **Erase** | Each one refused, `[BT] refused a command` on the console |
| 8 | **Image Upload** of image A, the one that runs | `[BT] refused an upload: it is not newer than what runs` |
| 9 | **Image Upload** of `bt-b.bin` | `[BT] upload started`, then `has arrived`, and LED1 blinks fast. Write down how long it took |
| 10 | Press Button 2 | Slot erased, and `image list` in a next window shows nothing in slot 1 |
| 11 | Upload `bt-b.bin` again, and press Button 1, with Wi-Fi available | Restarts, runs 1.5.2 with a triple flash, reaches AWS IoT, and is confirmed by itself. Record on the console and in the shadow: `succeeded`, `cloud` |
| 12 | Turn off the access point (`CLEAR_WIFI` is not it: the board must stay provisioned). Upload and install a newer image, then do nothing | After 5 minutes it reverts. `rolled_back` on the console |
| 13 | The same, but within 5 minutes hold Button 1, pair, and **Images > Read** | Before 60 s: `[BT] trial: this image has not run for long enough yet`. After that, once `[WIFI] failed reason=network not found` has been seen: `succeeded`, `person`, and it stays after a reset |
| 14 | The same on a board with Wi-Fi up and AWS IoT out of reach, and again on an access point that gives no DHCP lease | `[BT] trial: there is Wi-Fi, so it has to reach the cloud`, and it reverts |
| 15 | Install `bt-hang.bin` | The watchdog fires, and the bootloader goes back. `rolled_back` |
| 16 | Upload a newer image signed with another key, using `imgtool` | Offered, and then the bootloader refuses it: `not_installed` |
| 17 | Open a window during a cloud update on offer, and the other way round: a job created during a window | Refused, and the job is offered after the window closes |
| 18 | A full **cloud** update with the same image, with Bluetooth not touched | As `tests/hil/ota_bench.py` shows it, no slower |
| 19 | An upload with MQTT up, with a download of something else going on nearby | MQTT stays up. If not, see [Wi-Fi and Bluetooth](#wi-fi-and-bluetooth-on-this-board) |

For 19 the phone's upload time should be compared with one with Wi-Fi off. Do the measurements under
[Before relying on it](#before-relying-on-it) in the same session.

**Going back.** The application is back on a normal image by any way that takes an older one: the
golden image's gesture, or serial recovery, since a cloud update only takes a newer one. The network
core only by the debug port, from a normal build:

```sh
nrfutil device program --serial-number <probe> --core Network \
  --firmware build/netcore_blinky/zephyr/zephyr.hex \
  --options chip_erase_mode=ERASE_RANGES_TOUCHED_BY_FIRMWARE,verify=VERIFY_READ
nrfutil device reset --serial-number <probe> --reset-kind RESET_PIN
```

Mixed states should do no harm, and have not been tried. An image with this option on a blinky
network core waits two seconds at the first press, says `the network core does not run the Bluetooth
controller`, and goes on, and does everything else as usual. An image without it on the `hci_ipc`
network core, the golden image for one, never starts the host, so the radio stays off and LED2 stays
dark.

## Golden image

The golden image is one image a person can always go back to, at the board, with no laptop,
no Wi-Fi and no cloud. It is sealed in external flash, and only the bootloader can restore it,
only under a physical gesture, and only if it is the one image pinned by a digest compiled into
the bootloader. There is no cloud, job, console, serial or automatic way to start this.

`CONFIG_CRANIUM_GOLDEN` stays off in the bootloader's `prj.conf` until an image has been frozen, and
is on now: firmware 1.5.0 is the frozen image. With it off nothing of this is built into the bootloader. The one
trace is `golden_partition` in its devicetree, which adds one 16-byte entry to its flash map. With it
on, the bootloader is 50,324 bytes of its 64 KiB in the 1.5.0 and 1.6.0 builds, against 47,452 with it off.
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

These are the steps as they were done for firmware 1.5.0 on 2026-11-01: the version went in at commit
907d8cd, the image was built from that commit, and the pin went in at commit f9685e9.
`golden_bench.py run G0 G1 G2 G3 G4` did steps 4 to 8 on the board, with the debug port holding the
button.

1. Set a new version in `app/VERSION`, commit, and build from a clean tree, with
   `west build --pristine`. The image lands in `binaries/`. `tools/golden.py freeze` refuses an image
   built with uncommitted changes, a tree with uncommitted changes, an image from before the latest
   commit (`--older-commit` is the way round that) and an image built with `-D` settings, which stay
   in a build directory until it is removed.
2. `python tools/golden.py freeze binaries/cranium-<version>-<build>.signed.bin`. This verifies the
   signature with `keys/fw_signing_pub.pem`, copies the file to `binaries/golden/`, writes
   `golden.json`, and sets the three lines in `app/sysbuild/mcuboot/prj.conf`. Commit those two
   files. From here on the copy in `binaries/golden/` is the golden image, and no other: the next step
   builds the same commit again, which writes a new `binaries/cranium-<version>-<build>.signed.bin` with
   another digest, because TF-M and Zephyr put the build time in their boot banners. For 1.5.0 that
   file came out at 759,060 bytes, and the frozen one is 759,058.
3. Rebuild, and check that the build used the pin with
   `python tools/golden.py check --config build/mcuboot/zephyr/.config`.
4. Save the bootloader that is on the board now: `golden_bench.py run G0` reads it back through
   the debug port, into `binaries/golden/mcuboot-before-golden.hex`.
5. `python tools/golden.py restore --reset --serial-number <probe>` puts the image in the primary slot,
   in about 4 minutes, through the bootloader that is still on the board (G2).
6. Flash the bootloader only. This is the command the bench uses (G3), and its options are what keeps
   TF-M storage and provisioning:

   ```sh
   nrfutil device program --serial-number <probe> --firmware build/mcuboot/zephyr/zephyr.hex \
     --options chip_erase_mode=ERASE_RANGES_TOUCHED_BY_FIRMWARE,verify=VERIFY_READ
   nrfutil device reset --serial-number <probe> --reset-kind RESET_PIN
   ```

7. `python tools/recover.py --reset --serial-number <probe> list` shows a hash equal to `hash_tlv` in
   `golden.json`.
8. Do the gesture. The bootloader's log, on the board's first virtual COM port, says `sealed`.
   Do it again, and it says `nothing to do` (G4).
9. When the image has passed the bench on this bootloader, and its over-the-air regression, record
   that: `python tools/golden.py qualify "<the bench run>"`, and commit `golden.json`. The regression
   needs this bootloader, so it comes after the freeze. `golden.py check --qualified` insists on it.
   A run that qualifies has `"rehearsal": false` in `results.jsonl`, with the image's and the
   bootloader's SHA-256, and no `PARTIAL`: `qualify` takes your word for that, and does not read the file.
   This step has not been done for 1.5.0: see [Tests](#tests).

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
Wi-Fi but for G15 and G16: see `golden_bench.py plan`. By default it needs nobody. It holds the button
from the debug port, by driving P1.09 low once the bootloader has configured the pin, and the bootloader
has no test code for this.

What these tests showed on the frozen 1.5.0 and its bootloader is in the
[README](../README.md#the-golden-image-on-firmware-150), test by test.

G14 is the test of the image number check. It sends the first chunk of an upload for image numbers 1
and 3, which a bootloader without the check maps to the primary and the secondary slot, and each has
to be refused. Then the board must still run the image, and the gesture must find nothing to do. It
does not send the numbers that would reach the bootloader's own partition, TF-M storage or the golden
copy, and it stops on a bootloader without the check, so this bench has never run the hole itself. On
the frozen bootloader both numbers got error 3.

G15 and G16 do the gesture during a real update: G15 while a new image runs on trial, G16 in the middle
of the swap. In both, the board has to end up on the golden image with no revert and no resumed swap,
and the update must not report success. They need Wi-Fi and AWS, G15 also `--trial-image`, and **they
have not run yet**. Whether the rest of the over-the-air regression has run is in the
[README](../README.md#over-the-air-on-the-final-firmware).

That stand-in has limits, and a test it cannot finish ends as `PARTIAL`, not `PASS`, with the part that
did not run in its line of `results.jsonl`. It cannot hold the button down into the application, because
every stage of the boot configures the pin again, so G5c leaves out the check in `ui.c` and G5f reaches
it from the input driver on. And it is not a hand. A reading of the pin before the breakpoint would not
be seen on the bench, though with a hand it would stop the gesture: `test_golden.py` checks the source
for one, and only a person can check the rest.

**What needs a person.** G5e, the gesture from power-off, needs a person to pull the cable, and so do
the power cuts in G5d and G11. Those two and G5c are `PARTIAL` on the frozen image for this reason, and
G5e has not run. A person should do this before the gesture is taught. None of it has been done, and
1.5.0 was frozen without it:

```sh
python3 firmware/tests/hil/golden_bench.py run G4 G5a G5b G5c G5d G5e G11 --gesture person --power-cuts
```

Add `--out <folder>` to choose where the logs and `results.jsonl` go: by default that is
`build-hil-golden/`.

`python tools/golden.py qualify` has not been used, because that needs those runs, G15, G16 and the
over-the-air regression. `qualifying_bench_run` in `golden.json` is empty until then, and
`golden.py check --qualified` refuses.
