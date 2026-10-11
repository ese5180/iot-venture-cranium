// Tests for the MCUboot image validator.
//
// The fixtures are real images produced by MCUboot's imgtool from a 600-byte payload
// (see fixtures/README.md). The keys that signed them were generated for these tests
// and discarded; only their public halves are kept.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  ImageError, compareVersions, formatVersion, loadSigningKey, parseVersion, validateImage,
} from '../src/lib/mcuboot.mjs';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));

const key = loadSigningKey(fixture('test_signing_pub.pem'));
const otherKey = loadSigningKey(fixture('other_signing_pub.pem'));
const options = { maxSize: 0x10000, loadAddress: 0x30000 };
const valid = fixture('valid-1.2.3+4.signed.bin');

function refuses(image, code, opts = options, signingKey = key) {
  assert.throws(() => validateImage(image, signingKey, opts),
    (error) => error instanceof ImageError && error.code === code,
    `expected the image to be refused with ${code}`);
}

// Offsets inside the fixtures: 0x200 header, 600 bytes of payload, then the TLV area.
const TLV_START = 0x200 + 600;

function writeTlvTotal(image) {
  image.writeUInt16LE(image.length - TLV_START, TLV_START + 2);
  return image;
}

test('accepts a correctly signed image and reports what it is', () => {
  const info = validateImage(valid, key, options);
  assert.equal(info.version, '1.2.3+4');
  assert.deepEqual(info.versionParts, { major: 1, minor: 2, revision: 3, build: 4 });
  assert.equal(info.size, valid.length);
  assert.equal(info.sha256, createHash('sha256').update(valid).digest('hex'));
  assert.equal(info.keyHash, key.keyHash.toString('hex'));
  assert.equal(info.loadAddress, 0x30000);
  assert.equal(info.payloadSize, 600);
  assert.deepEqual(info.flags, ['ROM_FIXED']);
});

test('accepts a signature that imgtool padded to a fixed length', () => {
  assert.equal(validateImage(fixture('valid-padded-signature.signed.bin'), key, options).version, '2.0.0+0');
});

test('accepts an image with a protected TLV area', () => {
  assert.equal(validateImage(fixture('with-security-counter.signed.bin'), key, options).version, '1.2.3+4');
});

test('refuses an image signed with another key', () => {
  refuses(fixture('signed-with-other-key.signed.bin'), 'wrong_key');
  refuses(valid, 'wrong_key', options, otherKey);
});

test('refuses images that are not ECDSA-signed', () => {
  refuses(fixture('hash-only-unsigned.bin'), 'unsigned');
  refuses(fixture('signed-with-rsa.signed.bin'), 'unexpected_tlv');
  refuses(fixture('full-public-key.signed.bin'), 'unexpected_tlv');
});

test('refuses a padded or pre-confirmed image', () => {
  refuses(fixture('padded-and-confirmed.signed.bin'), 'trailing_data');
});

test('refuses an image built for another flash layout', () => {
  refuses(fixture('no-rom-fixed.signed.bin'), 'wrong_target');
  refuses(fixture('other-load-address.signed.bin'), 'wrong_target');
  // Without a required load address the same files are structurally fine.
  assert.equal(validateImage(fixture('no-rom-fixed.signed.bin'), key, { maxSize: 0x10000 }).version, '1.2.3+4');
});

test('refuses a payload that was changed after signing', () => {
  const tampered = Buffer.from(valid);
  tampered[0x200 + 17] ^= 0x01;
  refuses(tampered, 'hash_mismatch');
});

test('refuses a changed payload even when the attacker fixes the hash', () => {
  const tampered = Buffer.from(valid);
  tampered[0x200 + 17] ^= 0x01;
  // The SHA256 entry is first in the TLV area: info (4) + entry header (4) + 32 bytes.
  createHash('sha256').update(tampered.subarray(0, TLV_START)).digest().copy(tampered, TLV_START + 8);
  refuses(tampered, 'bad_signature');
});

test('refuses a changed header, including the version', () => {
  const tampered = Buffer.from(valid);
  tampered.writeUInt8(9, 20); // major version
  refuses(tampered, 'hash_mismatch');
});

test('refuses a damaged signature', () => {
  const tampered = Buffer.from(valid);
  tampered[tampered.length - 5] ^= 0x40;
  assert.throws(() => validateImage(tampered, key, options),
    (error) => error instanceof ImageError &&
      ['bad_signature', 'bad_signature_encoding'].includes(error.code));
});

test('refuses flags this product does not use', () => {
  for (const flag of [0x1, 0x4, 0x8, 0x10, 0x20, 0x200, 0x400, 0x800, 0x80000000]) {
    const tampered = Buffer.from(valid);
    tampered.writeUInt32LE((0x100 | flag) >>> 0, 16);
    refuses(tampered, 'unsupported_flags');
  }
});

test('refuses files that are not images or are cut short', () => {
  refuses(Buffer.alloc(10), 'too_small');
  refuses(Buffer.alloc(4096, 0xff), 'bad_magic');
  refuses(Buffer.from('this is definitely not firmware, just some text in a file'), 'bad_magic');
  // Shorter than its own header.
  for (const length of [36, 100, 0x1ff]) {
    refuses(valid.subarray(0, length), 'bad_header');
  }
  for (const length of [0x200, 0x200 + 300, TLV_START, TLV_START + 3]) {
    refuses(valid.subarray(0, length), 'truncated');
  }
  for (const length of [TLV_START + 4, TLV_START + 20, valid.length - 1]) {
    refuses(valid.subarray(0, length), 'malformed_tlv');
  }
});

test('refuses data after the signature area', () => {
  refuses(Buffer.concat([valid, Buffer.from([0])]), 'trailing_data');
  refuses(Buffer.concat([valid, Buffer.alloc(64, 0xff)]), 'trailing_data');
});

test('refuses header fields that point outside the file', () => {
  const hugeImage = Buffer.from(valid);
  hugeImage.writeUInt32LE(0xfffffff0, 12);
  refuses(hugeImage, 'truncated');

  const hugeHeader = Buffer.from(valid);
  hugeHeader.writeUInt16LE(0xffff, 8);
  refuses(hugeHeader, 'bad_header');

  const tinyHeader = Buffer.from(valid);
  tinyHeader.writeUInt16LE(16, 8);
  refuses(tinyHeader, 'bad_header');

  const empty = Buffer.from(valid);
  empty.writeUInt32LE(0, 12);
  refuses(empty, 'bad_header');

  const hugeProtected = Buffer.from(valid);
  hugeProtected.writeUInt16LE(0xfff0, 10);
  refuses(hugeProtected, 'truncated');
});

test('refuses malformed TLV entries', () => {
  // An entry whose length runs past the end of the area.
  const overlong = Buffer.from(valid);
  overlong.writeUInt16LE(0x7000, TLV_START + 4 + 2);
  refuses(overlong, 'malformed_tlv');

  // A second SHA256 entry appended inside the area.
  const duplicate = writeTlvTotal(Buffer.concat([valid, valid.subarray(TLV_START + 4, TLV_START + 4 + 36)]));
  refuses(duplicate, 'unexpected_tlv');

  // An unknown entry type.
  const unknown = writeTlvTotal(Buffer.concat([valid, Buffer.from([0xa0, 0x00, 0x02, 0x00, 0xde, 0xad])]));
  refuses(unknown, 'unexpected_tlv');

  // A total that claims more than the file holds.
  const inflated = Buffer.from(valid);
  inflated.writeUInt16LE(0xffff, TLV_START + 2);
  refuses(inflated, 'malformed_tlv');
});

test('enforces the slot size', () => {
  refuses(valid, 'too_large', { maxSize: valid.length - 1, loadAddress: 0x30000 });
  assert.ok(validateImage(valid, key, { maxSize: valid.length, loadAddress: 0x30000 }));
  assert.throws(() => validateImage(valid, key, {}), TypeError);
});

test('only an ECDSA P-256 public key can be the signing key', () => {
  assert.throws(() => loadSigningKey('not a key'), (error) => error.code === 'bad_signing_key');
});

test('versions parse exactly like the firmware parses them', () => {
  assert.deepEqual(parseVersion('1.2.3+4'), { major: 1, minor: 2, revision: 3, build: 4 });
  assert.deepEqual(parseVersion('0.0.0'), { major: 0, minor: 0, revision: 0, build: 0 });
  assert.deepEqual(parseVersion('255.255.65535+4294967295'),
    { major: 255, minor: 255, revision: 65535, build: 4294967295 });
  for (const bad of ['', '1', '1.2', '1.2.3.4', '1.2.3+', '+1', 'v1.2.3', '1.2.3 ', ' 1.2.3', '01.2.3',
    '1.02.3', '1.2.3+04', '256.0.0', '0.256.0', '0.0.65536', '0.0.0+4294967296', '1.2.3-rc1',
    '1.2.3+4+5', '1..3', null, undefined, 123]) {
    assert.equal(parseVersion(bad), null, `"${bad}" must not parse`);
  }
});

test('versions order by major, minor, revision, then build', () => {
  const order = ['0.0.1', '0.1.0', '1.0.0', '1.0.0+1', '1.0.1', '1.2.3+4', '1.2.3+5', '2.0.0'];
  for (let i = 0; i < order.length; i++) {
    for (let j = 0; j < order.length; j++) {
      const result = compareVersions(parseVersion(order[i]), parseVersion(order[j]));
      assert.equal(Math.sign(result), Math.sign(i - j), `${order[i]} vs ${order[j]}`);
    }
  }
  assert.equal(formatVersion(parseVersion('1.2.3')), '1.2.3+0');
});
