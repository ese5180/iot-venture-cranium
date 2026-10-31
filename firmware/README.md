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
  VERSION                firmware version; also the version written into the signed image
netcore/                 network-core image
certs/AmazonRootCA1.pem  root CA that tools/provision_device.py loads onto each board
keys/fw_signing_pub.pem  public half of the signing key
tests/host/              host tests of the job parser, the version code and the console
tests/hil/               hardware test benches, and tests of the tools that talk to a board
```

The host tests need no board. Run them from an nRF Connect SDK terminal, which
provides the cJSON and base64 source they use: `make -C firmware/tests/host`. Then
`python3 firmware/tests/hil/test_board.py` and `python3 firmware/tests/hil/test_recover.py`
test the tools, the first of them against the console's real code on a pseudo-terminal. The
host tests compile the console's C files as they are, on a fake UART and a fake network
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
