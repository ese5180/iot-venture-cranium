# Local secrets

No secret is stored in this repository's folder, not even in an ignored file. Each
developer's secrets live in `~/.cranium/` on their own machine, where they cannot be
committed by accident and are not picked up by a synchronised Desktop or Documents folder.
The tools and the build read the two files below from that folder, and nothing else.

| File in `~/.cranium/` | What it is | How it gets there |
| --- | --- | --- |
| `mcuboot_signing_key.pem` | ECDSA P-256 private key that signs every firmware image. The boards only run images signed with it. | `python tools/keys.py generate`, or from the key custodian over a secure channel. The custodian today is the release manager. |
| `wifi_secrets.h` | Wi-Fi network name and passphrase used when provisioning a board. Owned by root, mode 600: reading it needs an administrator password. With `--unlocked` it stays yours, mode 600. | `python tools/secrets.py wifi` |

`wifi_secrets.h.example` in this directory shows the format of the second file.
`python tools/secrets.py status` lists what exists and who can read it.

The test benches' logs are not secrets, but keep them private too. `build-hil/` and the other `build-*`
folders, which git ignores, hold the Wi-Fi network's name, AWS endpoints and the like.

`python tools/secrets.py wifi --unlocked` writes the file owned by you instead of by root. Then
no administrator password is needed, so a test bench can provision a board with nobody at the
keyboard. The cost is that any program running as you can read it. Use it only on a bench
machine. The passphrase is still typed without echo and never appears on a command line.
The network name must be exact: a phone's hotspot often has a curly apostrophe that nobody types
by hand. The tool offers the spelling this Mac knows.

The public half of the signing key is committed at `firmware/keys/fw_signing_pub.pem`.
That is safe: a public key can only verify signatures, not create them.
`python tools/keys.py check` confirms that the private key on this machine matches it.

If the signing key is lost, no new firmware can be installed over the air on boards
that trust it; they have to be reflashed over the debug port with a bootloader built
for a new key. If it leaks, anyone can sign firmware those boards will accept (see
[If the signing key leaks](#if-the-signing-key-leaks)). Keep exactly as many copies as you need,
and know where each one is.

## The current key

| Key | SHA-256 of the public key starts with | State |
| --- | --- | --- |
| New | `c8f28131` | In use. `firmware/keys/fw_signing_pub.pem` holds its public half. |
| Old | `ab94b01f` | Retired. The console no longer accepts images signed with it. |

The console was told about the change with `cloud/deploy.sh --replace-signing-key`. Without that
option the deployment stops if the key differs from the one the console trusts.
`python tools/keys.py fingerprint` prints the fingerprint of the key on this machine.

**Other boards must be reflashed over the debug port.** A board holds the public key inside its
bootloader, and an update over the air does not change the bootloader. A board flashed before the
change still has the old key's bootloader, so it refuses every image signed with the new key.
Build from this checkout, then run `west flash --recover`, which erases both cores, and provision
the board again with `python tools/provision_device.py`.

**The golden image is signed with the key too.** A bootloader with a new key refuses the old golden
copy. So a new key also means freezing a new golden image:
[`firmware/README.md`](../firmware/README.md#freezing-an-image) has the steps.

## Back up the signing key

An encrypted backup of the key exists. This file does not say where it is. The method:

1. Turn on disk encryption on the machine. FileVault is on for the release builder's Mac.
2. Encrypt the key with `gpg --symmetric`, which asks for a passphrase.
3. Keep the passphrase apart from the encrypted file.
4. Keep the encrypted file away from the machine that holds the key. A copy on the same disk does
   not survive the loss of that disk.

```sh
gpg --symmetric --cipher-algo AES256 \
  --output <backup file>.gpg ~/.cranium/mcuboot_signing_key.pem
```

To restore it:

```sh
( umask 077; gpg --decrypt --output ~/.cranium/mcuboot_signing_key.pem <backup file>.gpg )
python tools/keys.py check
```

`tools/keys.py check` confirms that the restored key matches the committed public key.

## If the signing key leaks

Whoever has the key can sign images that the boards accept. Over the air a board still needs a job
and Button 1. With access to the UART, serial recovery takes the image with no button. An update
over the air cannot change the key in a bootloader, so every board has to be reflashed.

1. Tell the team, and stop building with the old key.
2. Move the old private key out of `~/.cranium/`, then run `python tools/keys.py generate`, which
   refuses to overwrite a key. It also rewrites `firmware/keys/fw_signing_pub.pem`. Commit that file.
3. Run `cloud/deploy.sh --replace-signing-key`, so that the console trusts the new public half and
   refuses images signed with the old key.
4. Freeze a new golden image with the new key:
   [`firmware/README.md`](../firmware/README.md#freezing-an-image). The old one is signed with the
   leaked key, and a bootloader with the new key refuses it.
5. Build from this checkout, reflash every board with `west flash --recover`, and provision it
   again with `python tools/provision_device.py`. A board accepts images signed with the old key
   until this is done.
6. Destroy the old key and its backups, make a new backup, and update the table under
   [The current key](#the-current-key).

Replacing the key for any other reason takes the same steps.
