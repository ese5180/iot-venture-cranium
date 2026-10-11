# Local secrets

No secret is stored in this repository's folder, not even in an ignored file. Each
developer's secrets live in `~/.cranium/` on their own machine, where they cannot be
committed by accident and are not picked up by a synchronised Desktop or Documents folder.

| File in `~/.cranium/` | What it is | How it gets there |
| --- | --- | --- |
| `mcuboot_signing_key.pem` | ECDSA P-256 private key that signs every firmware image. The boards only run images signed with it. | `python tools/keys.py generate`, or from the team's key custodian over a secure channel |
| `wifi_secrets.h` | Wi-Fi network name and passphrase used when provisioning a board. Owned by root, mode 600: reading it needs an administrator password. | `python tools/secrets.py wifi` |

`wifi_secrets.h.example` in this directory shows the format of the second file.
`python tools/secrets.py status` lists what exists and who can read it.

The public half of the signing key is committed at `firmware/keys/fw_signing_pub.pem`.
That is safe: a public key can only verify signatures, not create them.
`python tools/keys.py check` confirms that the private key on this machine matches it.

If the signing key is lost, no new firmware can be installed over the air on boards
that trust it; they have to be reflashed over the debug port with a bootloader built
for a new key. If it leaks, anyone can sign firmware those boards will accept. Keep
exactly as many copies as you need, and know where each one is.
