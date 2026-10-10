# Test fixtures

Small firmware images made with MCUboot's `imgtool` from a 600-byte payload, used by
`../mcuboot.test.mjs`. They are not real firmware and no device trusts the keys that
signed them: those keys were generated for the tests and discarded, and only their
public halves (`test_signing_pub.pem`, `other_signing_pub.pem`) are kept here.

Every image was made with
`imgtool sign --header-size 0x200 --pad-header --align 4 --slot-size 0x10000` plus:

| File | Extra options |
| --- | --- |
| `valid-1.2.3+4.signed.bin`, `valid-1.2.3+5.signed.bin` | `-k test_key --version ... --rom-fixed 0x30000` |
| `valid-padded-signature.signed.bin` | as above with `--version 2.0.0 --pad-sig` |
| `with-security-counter.signed.bin` | `--security-counter 7` (adds a protected TLV area) |
| `no-rom-fixed.signed.bin` | no `--rom-fixed` |
| `other-load-address.signed.bin` | `--rom-fixed 0x10000` |
| `signed-with-other-key.signed.bin` | `-k other_key` |
| `signed-with-rsa.signed.bin` | an RSA-2048 key |
| `hash-only-unsigned.bin` | no key |
| `padded-and-confirmed.signed.bin` | `--pad --confirm` |
| `full-public-key.signed.bin` | `--public-key-format full` |
