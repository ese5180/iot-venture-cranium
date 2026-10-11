# Firmware

Zephyr / nRF Connect SDK **v3.4.0** project for the nRF7002 DK
(`nrf7002dk/nrf5340/cpuapp/ns`). One `west build` produces three images:

| Image | Runs on | Role |
| --- | --- | --- |
| `mcuboot` | application core, secure | Bootloader. Verifies the ECDSA P-256 signature of the application image on every boot, installs updates from the secondary slot in external flash, and puts the previous image back if a new one is not confirmed. |
| `app` | application core | Trusted Firmware-M in the secure domain plus the non-secure application. This is the security domain of the product. |
| `netcore_blinky` | network core | Base-function domain: toggles LED2 once a second. No radio stack, no console, no keys. |

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

Zephyr cannot build from a path that contains spaces. If your checkout is under such
a path, build through a symbolic link that has none.

## Layout

```
app/                     application-core image and the sysbuild configuration
  boards/                Kconfig and devicetree for the nRF7002 DK
  sysbuild/mcuboot/      bootloader configuration
  VERSION                firmware version; also the version written into the signed image
netcore/                 network-core image
keys/fw_signing_pub.pem  public half of the signing key
```

## Memory map

Internal flash (1 MiB) and the 8 MiB external SPI flash:

| Region | Start | Size | Contents |
| --- | --- | --- | --- |
| `boot_partition` | `0x00000` | 64 KiB | MCUboot |
| `slot0_partition` | `0x10000` | 912 KiB | running image: TF-M (128 KiB) + application (784 KiB) |
| `tfm_storage_partition` | `0xf4000` | 48 KiB | TF-M internal trusted storage, NV counters, protected storage |
| `slot1_partition` (external flash) | `0x0` | 912 KiB | downloaded image waiting to be installed, then the previous image kept for revert |

## What the LEDs show

* **LED1** is driven by the application core.
* **LED2** is driven by the network core and keeps blinking whatever the application
  core is doing.
