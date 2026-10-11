// Tests for firmware releases: what an upload must pass before anything is stored,
// how versions are ordered, and what revoking a release does, in which order.
//
// Most tests upload the fixture images (see fixtures/README.md). Where a version is
// needed that no fixture has, an image is built here and signed with a key that is
// generated for the test run and never leaves the process.

import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { test } from 'node:test';

import { objectKey, releaseFromItem, releaseKey, versionOfKey } from '../src/handlers/firmware.mjs';
import { loadSigningKey, parseVersion, validateImage } from '../src/lib/mcuboot.mjs';
import { createTestConsole, fixture } from './fake-aws.mjs';

const THING = 'cranium-fe5b26c0c5b1dcd7';
const OTHER_THING = 'cranium-0123456789abcdef';
const SLOT_SIZE = 933888;
const LOAD_ADDRESS = 0x30000;

const throwaway = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const throwawayDer = throwaway.publicKey.export({ type: 'spki', format: 'der' });

// What surrounds the payload in a built image: the header, the TLV info, the hash and
// key hash entries, and the signature entry with the longest DER signature (72 bytes).
const IMAGE_OVERHEAD = 0x200 + 4 + 36 + 36 + 4 + 72;

/** A minimal MCUboot image of the given version, signed with the throwaway key. */
function builtImage(version, { fill = 0xa5, payloadSize = 96 } = {}) {
  const { major, minor, revision, build } = parseVersion(version);
  const header = Buffer.alloc(0x200);
  const payload = Buffer.alloc(payloadSize, fill);
  header.writeUInt32LE(0x96f3b83d, 0);
  header.writeUInt32LE(LOAD_ADDRESS, 4);
  header.writeUInt16LE(header.length, 8);
  header.writeUInt32LE(payload.length, 12);
  header.writeUInt32LE(0x100, 16);   // ROM_FIXED
  header.writeUInt8(major, 20);
  header.writeUInt8(minor, 21);
  header.writeUInt16LE(revision, 22);
  header.writeUInt32LE(build, 24);
  const signed = Buffer.concat([header, payload]);
  const entry = (type, data) => {
    const head = Buffer.alloc(4);
    head.writeUInt16LE(type, 0);
    head.writeUInt16LE(data.length, 2);
    return Buffer.concat([head, data]);
  };
  const entries = Buffer.concat([
    entry(0x10, createHash('sha256').update(signed).digest()),
    entry(0x01, createHash('sha256').update(throwawayDer).digest()),
    entry(0x22, sign('sha256', signed, { key: throwaway.privateKey, dsaEncoding: 'der' })),
  ]);
  const info = Buffer.alloc(4);
  info.writeUInt16LE(0x6907, 0);
  info.writeUInt16LE(info.length + entries.length, 2);
  return Buffer.concat([signed, info, entries]);
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const bodyFor = (image, extra = {}) => ({ filename: 'zephyr.signed.bin', data: image.toString('base64'), ...extra });

/** A console whose signing key is the fixtures' key, with one release manager. */
function setup(options) {
  const console_ = createTestConsole(options);
  const manager = console_.addUser('manager', ['release-managers']);
  const viewer = console_.addUser('viewer', ['viewers']);
  const upload = (image, extra) => console_.call('POST', '/api/firmware', { as: manager, body: bodyFor(image, extra) });
  return { ...console_, manager, viewer, upload };
}

/** A console that trusts the throwaway key, so that built images are accepted. */
function setupWithBuiltImages() {
  return setup({ env: { SIGNING_PUBLIC_KEY_B64: throwawayDer.toString('base64') } });
}

test('the image builder of these tests makes images the validator accepts', () => {
  const key = loadSigningKey(throwaway.publicKey.export({ type: 'spki', format: 'pem' }));
  const info = validateImage(builtImage('1.9.0+0'), key, { maxSize: SLOT_SIZE, loadAddress: LOAD_ADDRESS });
  assert.equal(info.version, '1.9.0+0');
  assert.notEqual(sha256(builtImage('1.9.0+0')), sha256(builtImage('1.9.0+0', { fill: 0x5a })));
});

test('a correctly signed image becomes a release', async () => {
  const { fake, manager, upload, config, clock } = setup();
  const image = fixture('valid-1.2.3+4.signed.bin');
  const digest = sha256(image);

  const response = await upload(image, { notes: '  first build with Wi-Fi  ' });
  assert.equal(response.status, 201);
  const expected = validateImage(image, config.signingKey, { maxSize: SLOT_SIZE, loadAddress: LOAD_ADDRESS });
  assert.deepEqual(response.body, {
    release: {
      version: '1.2.3+4',
      size: image.length,
      sha256: digest,
      imageHash: expected.imageHash,
      keyHash: config.signingKeyFingerprint,
      payloadSize: 600,
      headerSize: 512,
      loadAddress: 196608,
      filename: 'zephyr.signed.bin',
      notes: 'first build with Wi-Fi',
      uploadedBy: { sub: manager.sub, email: manager.email },
      uploadedAt: new Date(clock.ms).toISOString(),
      status: 'active',
      revoked: null,
    },
  });

  // The bytes are stored once, under their own digest, with that digest as checksum.
  assert.deepEqual([...fake.objects.keys()], [`firmware/${digest}.bin`]);
  const stored = fake.objects.get(`firmware/${digest}.bin`);
  assert.ok(stored.body.equals(image));
  assert.equal(stored.contentType, 'application/octet-stream');
  assert.equal(stored.sha256Base64, Buffer.from(digest, 'hex').toString('base64'));
  assert.deepEqual(stored.tags, {});

  // The record and the pointer to the highest version.
  assert.deepEqual([...fake.releases.keys()], ['001.002.00003.0000000004']);
  assert.equal(fake.highestRegistered(), '001.002.00003.0000000004');

  // Checked first, stored second, registered third, logged last.
  assert.deepEqual(fake.methodsCalled(),
    ['getUser', 'listUserGroups', 'getRelease', 'highestReleaseKey', 'putFirmwareObject', 'registerRelease',
      'putAudit']);
});

test('the other well-formed fixtures are accepted too', async () => {
  for (const [name, version] of [
    ['valid-1.2.3+5.signed.bin', '1.2.3+5'],
    ['valid-padded-signature.signed.bin', '2.0.0+0'],
    ['with-security-counter.signed.bin', '1.2.3+4'],
  ]) {
    const { upload } = setup();
    const response = await upload(fixture(name));
    assert.equal(response.status, 201, name);
    assert.equal(response.body.release.version, version);
  }
});

test('an image that fails verification is refused before anything is stored', async () => {
  const valid = fixture('valid-1.2.3+4.signed.bin');
  const tampered = Buffer.from(valid);
  tampered[0x200 + 17] ^= 0x01;
  const reversioned = Buffer.from(valid);
  reversioned.writeUInt8(9, 20);
  const refixed = Buffer.from(tampered);
  createHash('sha256').update(refixed.subarray(0, 0x200 + 600)).digest().copy(refixed, 0x200 + 600 + 8);

  const cases = [
    [fixture('signed-with-other-key.signed.bin'), 'wrong_key'],
    [fixture('hash-only-unsigned.bin'), 'unsigned'],
    [fixture('signed-with-rsa.signed.bin'), 'unexpected_tlv'],
    [fixture('full-public-key.signed.bin'), 'unexpected_tlv'],
    [fixture('padded-and-confirmed.signed.bin'), 'trailing_data'],
    [fixture('no-rom-fixed.signed.bin'), 'wrong_target'],
    [fixture('other-load-address.signed.bin'), 'wrong_target'],
    [tampered, 'hash_mismatch'],
    [reversioned, 'hash_mismatch'],
    [refixed, 'bad_signature'],
    [valid.subarray(0, valid.length - 1), 'malformed_tlv'],
    [valid.subarray(0, 0x200 + 300), 'truncated'],
    [Buffer.concat([valid, Buffer.from([0])]), 'trailing_data'],
    [Buffer.from('this is definitely not firmware, just some text in a file'), 'bad_magic'],
    [Buffer.alloc(4096, 0xff), 'bad_magic'],
    [Buffer.alloc(10), 'too_small'],
    [builtImage('3.0.0+0'), 'wrong_key'],
  ];
  for (const [image, code] of cases) {
    const { fake, upload } = setup();
    const response = await upload(image);
    assert.equal(response.status, 422, code);
    assert.equal(response.body.error.code, code);
    assert.ok(response.body.error.message.length > 10);
    assert.equal(fake.objects.size, 0, code);
    assert.equal(fake.releases.size, 0, code);
    assert.ok(!fake.methodsCalled().includes('putFirmwareObject'), code);
    const [entry] = fake.auditLog();
    assert.equal(entry.outcome, 'rejected');
    assert.equal(entry.detail.code, code);
  }
});

test('an image larger than the slot is refused', async () => {
  const image = fixture('valid-1.2.3+4.signed.bin');
  const tight = setup({ env: { SLOT_SIZE: String(image.length - 1) } });
  const refused = await tight.upload(image);
  assert.equal(refused.status, 422);
  assert.equal(refused.body.error.code, 'too_large');

  const exact = setup({ env: { SLOT_SIZE: String(image.length) } });
  assert.equal((await exact.upload(image)).status, 201);

  // A file that fills the real slot passes the size limit of the request itself.
  const full = setup();
  const response = await full.upload(Buffer.alloc(SLOT_SIZE, 0x11));
  assert.equal(response.status, 422);
  assert.equal(response.body.error.code, 'bad_magic');
});

test('an image that fills the slot fits in one request', async () => {
  const { fake, upload } = setupWithBuiltImages();
  // As large as an image can be: at most two bytes short of the slot, depending on
  // the length of its signature.
  const largest = builtImage('3.0.0+1', { payloadSize: SLOT_SIZE - IMAGE_OVERHEAD });
  assert.ok(largest.length <= SLOT_SIZE && largest.length >= SLOT_SIZE - 2, String(largest.length));
  const body = JSON.stringify(bodyFor(largest, { notes: 'n'.repeat(500) }));
  assert.ok(body.length < 1_400_000, String(body.length));

  const response = await upload(largest, { notes: 'n'.repeat(500) });
  assert.equal(response.status, 201);
  assert.equal(response.body.release.size, largest.length);
  assert.ok(fake.objects.get(`firmware/${sha256(largest)}.bin`).body.equals(largest));

  // Three bytes more no longer fit the slot, whatever the signature length.
  const tooLarge = await upload(builtImage('3.0.0+2', { payloadSize: SLOT_SIZE - IMAGE_OVERHEAD + 3 }));
  assert.equal(tooLarge.status, 422);
  assert.equal(tooLarge.body.error.code, 'too_large');
});

test('the request is checked before the image is looked at', async () => {
  const image = fixture('valid-1.2.3+4.signed.bin');
  const data = image.toString('base64');
  const cases = [
    [{ data }, 'invalid_filename'],
    [{ filename: '../zephyr.bin', data }, 'invalid_filename'],
    [{ filename: 'x'.repeat(65), data }, 'invalid_filename'],
    [{ filename: 7, data }, 'invalid_filename'],
    [{ filename: 'a.bin', notes: 'x'.repeat(501), data }, 'invalid_notes'],
    [{ filename: 'a.bin', notes: 'two\nlines', data }, 'invalid_notes'],
    [{ filename: 'a.bin', notes: 5, data }, 'invalid_notes'],
    [{ filename: 'a.bin', notes: null, data }, 'invalid_notes'],
    [{ filename: 'a.bin' }, 'invalid_data'],
    [{ filename: 'a.bin', data: '' }, 'invalid_data'],
    [{ filename: 'a.bin', data: data.replace(/=+$/, '') + (data.endsWith('=') ? '' : '=') }, 'invalid_data'],
    [{ filename: 'a.bin', data: `${data}\n` }, 'invalid_data'],
    [{ filename: 'a.bin', data: [data] }, 'invalid_data'],
    [{ filename: 'a.bin', data: { base64: data } }, 'invalid_data'],
  ];
  for (const [body, code] of cases) {
    const { fake, manager, call } = setup();
    const response = await call('POST', '/api/firmware', { as: manager, body });
    assert.equal(response.status, 400, code);
    assert.equal(response.body.error.code, code);
    assert.equal(fake.objects.size, 0);
    assert.equal(fake.auditLog()[0].outcome, 'rejected');
  }

  for (const [body, code] of [['', 'invalid_json'], ['{"filename":', 'invalid_json'], ['[]', 'invalid_body'],
    ['"data"', 'invalid_body'], ['null', 'invalid_body']]) {
    const { manager, call } = setup();
    const response = await call('POST', '/api/firmware', { as: manager, body });
    assert.equal(response.status, 400, body);
    assert.equal(response.body.error.code, code);
  }
});

test('the request size is limited before the body is parsed', async () => {
  const { fake, manager, call } = setup();
  // A JSON body of exactly the given length.
  const padding = (length) => {
    const empty = JSON.stringify({ filename: 'a.bin', data: '', notes: '' });
    return JSON.stringify({ filename: 'a.bin', data: '', notes: 'x'.repeat(length - empty.length) });
  };

  // Not even JSON: refused for its size alone.
  let response = await call('POST', '/api/firmware', { as: manager, body: 'x'.repeat(1_400_001) });
  assert.equal(response.status, 413);
  assert.equal(response.body.error.code, 'payload_too_large');

  response = await call('POST', '/api/firmware', { as: manager, body: padding(1_400_001) });
  assert.equal(response.status, 413);

  // At the limit the body is read, and then refused for what is in it.
  const atLimit = padding(1_400_000);
  assert.equal(atLimit.length, 1_400_000);
  response = await call('POST', '/api/firmware', { as: manager, body: atLimit });
  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, 'invalid_notes');

  // The same limit when the gateway hands the body over base64 encoded.
  response = await call('POST', '/api/firmware', { as: manager, body: 'x'.repeat(1_400_001), base64: true });
  assert.equal(response.status, 413);
  const image = fixture('valid-1.2.3+4.signed.bin');
  response = await call('POST', '/api/firmware', { as: manager, body: bodyFor(image), base64: true });
  assert.equal(response.status, 201);
  assert.equal(fake.objects.size, 1);
});

test('the version comes from the signed header and from nowhere else', async () => {
  const { upload } = setup();
  const response = await upload(fixture('valid-1.2.3+4.signed.bin'), {
    filename: 'firmware-9.9.9.signed.bin', version: '9.9.9+9', sha256: '0'.repeat(64), size: 1, status: 'revoked',
    uploadedAt: '1999-01-01T00:00:00.000Z',
  });
  assert.equal(response.status, 201);
  assert.equal(response.body.release.version, '1.2.3+4');
  assert.equal(response.body.release.status, 'active');
  assert.equal(response.body.release.size, 1264);
  assert.equal(response.body.release.filename, 'firmware-9.9.9.signed.bin');
  assert.notEqual(response.body.release.uploadedAt, '1999-01-01T00:00:00.000Z');
});

test('version 0.0.0+0 is refused', async () => {
  const { fake, upload } = setupWithBuiltImages();
  const response = await upload(builtImage('0.0.0+0'));
  assert.equal(response.status, 422);
  assert.equal(response.body.error.code, 'version_zero');
  assert.equal(fake.objects.size, 0);
  assert.equal(fake.releases.size, 0);
  assert.equal(fake.auditLog()[0].target, '0.0.0+0');
  // The smallest version above it is fine.
  assert.equal((await upload(builtImage('0.0.0+1'))).status, 201);
});

test('versions are ordered as numbers: 1.9.0 is older than 1.10.0', async () => {
  const { fake, upload } = setupWithBuiltImages();
  assert.equal((await upload(builtImage('1.9.0+0'))).status, 201);
  assert.equal((await upload(builtImage('1.10.0+0'))).status, 201);

  const older = await upload(builtImage('1.9.5+0'));
  assert.equal(older.status, 422);
  assert.equal(older.body.error.code, 'version_not_newer');
  assert.match(older.body.error.message, /1\.9\.5\+0/);
  assert.match(older.body.error.message, /1\.10\.0\+0/);

  for (const version of ['1.9.0+1', '1.2.99+7', '0.255.65535+4294967295', '1.10.0+0']) {
    const response = await upload(builtImage(version, { fill: 0x3c }));
    assert.notEqual(response.status, 201, version);
  }
  // A version that cannot be registered leaves no image behind: only the two releases are stored.
  assert.equal(fake.objects.size, 2);
  for (const version of ['1.10.0+1', '1.10.1+0', '1.11.0+0', '2.0.0+0', '10.0.0+0', '255.255.65535+4294967295']) {
    assert.equal((await upload(builtImage(version))).status, 201, version);
  }
  assert.equal(fake.highestRegistered(), '255.255.65535.4294967295');
  assert.equal((await upload(builtImage('255.255.65535+4294967294'))).status, 422);

  // The sort key itself.
  const key = (text) => releaseKey(parseVersion(text));
  assert.equal(key('1.9.0+0'), '001.009.00000.0000000000');
  assert.ok(key('1.9.0+0') < key('1.10.0+0'));
  assert.ok(key('1.2.3+9') < key('1.2.3+10'));
  assert.ok(key('9.0.0+0') < key('10.0.0+0'));
  assert.ok(key('1.2.9+0') < key('1.2.10+0'));
  assert.equal(versionOfKey(key('255.255.65535+4294967295')), '255.255.65535+4294967295');
  assert.equal(versionOfKey('1.2.3+4'), null);
  assert.equal(versionOfKey(undefined), null);
});

test('the build number orders two builds of the same version', async () => {
  const ascending = setup();
  assert.equal((await ascending.upload(fixture('valid-1.2.3+4.signed.bin'))).status, 201);
  assert.equal((await ascending.upload(fixture('valid-1.2.3+5.signed.bin'))).status, 201);

  const descending = setup();
  assert.equal((await descending.upload(fixture('valid-1.2.3+5.signed.bin'))).status, 201);
  const response = await descending.upload(fixture('valid-1.2.3+4.signed.bin'));
  assert.equal(response.status, 422);
  assert.equal(response.body.error.code, 'version_not_newer');
  assert.match(response.body.error.message, /1\.2\.3\+5/);
  assert.deepEqual([...descending.fake.releases.keys()], ['001.002.00003.0000000005']);
});

test('a version is registered once and never replaced', async () => {
  const { fake, upload } = setup();
  const first = fixture('valid-1.2.3+4.signed.bin');
  assert.equal((await upload(first)).status, 201);

  // The same file again.
  let response = await upload(first);
  assert.equal(response.status, 409);
  assert.equal(response.body.error.code, 'version_exists');

  // Different bytes that carry the same version.
  response = await upload(fixture('with-security-counter.signed.bin'), { notes: 'second try' });
  assert.equal(response.status, 409);
  assert.equal(response.body.error.code, 'version_exists');
  assert.equal(fake.objects.size, 1);

  const [item] = [...fake.releases.values()];
  assert.equal(item.sha256, sha256(first));
  assert.equal(item.notes, '');
  assert.deepEqual(fake.auditLog().map((entry) => [entry.outcome, entry.detail.code ?? null]),
    [['ok', null], ['rejected', 'version_exists'], ['rejected', 'version_exists']]);
});

test('bytes that are already stored are not written again', async () => {
  const { fake, upload } = setup();
  const image = fixture('valid-1.2.3+4.signed.bin');
  const key = `firmware/${sha256(image)}.bin`;
  // An earlier upload got as far as storing the object and no further.
  await fake.putFirmwareObject({ key, body: image, sha256Base64: createHash('sha256').update(image).digest('base64') });
  const before = fake.objects.get(key);

  const response = await upload(image);
  assert.equal(response.status, 201);
  assert.equal(fake.objects.size, 1);
  assert.equal(fake.objects.get(key), before);
  assert.equal(fake.releases.size, 1);
});

test('a revoked release still counts as the highest version', async () => {
  const { fake, manager, call, upload } = setup();
  assert.equal((await upload(fixture('valid-padded-signature.signed.bin'))).status, 201);   // 2.0.0+0
  const revoked = await call('POST', '/api/firmware/2.0.0+0/revoke', { as: manager, body: { reason: 'bricks the LEDs' } });
  assert.equal(revoked.status, 200);

  const response = await upload(fixture('valid-1.2.3+5.signed.bin'));
  assert.equal(response.status, 422);
  assert.equal(response.body.error.code, 'version_not_newer');
  assert.match(response.body.error.message, /2\.0\.0\+0/);
  assert.equal(fake.highestRegistered(), '002.000.00000.0000000000');

  // The revoked version itself cannot be uploaded again either.
  const again = await upload(fixture('valid-padded-signature.signed.bin'));
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'version_exists');
  assert.equal(fake.releases.get('002.000.00000.0000000000').status, 'revoked');
});

test('two uploads at the same moment cannot both win', async () => {
  const { fake, upload } = setup();
  const original = fake.registerRelease;
  // The transaction reports a conflict with a concurrent write.
  fake.registerRelease = async () => ({ ok: false, reason: 'conflict' });
  const response = await upload(fixture('valid-1.2.3+4.signed.bin'));
  fake.registerRelease = original;
  assert.equal(response.status, 409);
  assert.equal(response.body.error.code, 'upload_conflict');
  assert.equal(fake.releases.size, 0);
});

test('the transaction decides when another upload gets in after the first check', async () => {
  const { fake, upload } = setup();
  const original = fake.registerRelease;

  // The same version was registered in the meantime.
  fake.registerRelease = async () => ({ ok: false, reason: 'exists' });
  let response = await upload(fixture('valid-1.2.3+4.signed.bin'));
  assert.equal(response.status, 409);
  assert.equal(response.body.error.code, 'version_exists');

  // A higher version was registered in the meantime.
  fake.registerRelease = async () => ({ ok: false, reason: 'not_newer', highest: '002.000.00000.0000000000' });
  response = await upload(fixture('valid-1.2.3+4.signed.bin'));
  assert.equal(response.status, 422);
  assert.equal(response.body.error.code, 'version_not_newer');
  assert.match(response.body.error.message, /2\.0\.0\+0/);

  fake.registerRelease = original;
  assert.equal(fake.releases.size, 0);
});

test('releases are listed newest first with the key they are verified against', async () => {
  const { viewer, call, upload, config } = setup();
  const empty = await call('GET', '/api/firmware', { as: viewer });
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.releases, []);

  await upload(fixture('valid-1.2.3+4.signed.bin'));
  await upload(fixture('valid-1.2.3+5.signed.bin'));
  await upload(fixture('valid-padded-signature.signed.bin'));
  const listed = await call('GET', '/api/firmware', { as: viewer });
  assert.deepEqual(listed.body.releases.map((release) => release.version), ['2.0.0+0', '1.2.3+5', '1.2.3+4']);
  assert.equal(listed.body.slotSize, SLOT_SIZE);

  // The fingerprint is the SHA-256 of the DER public key, as MCUboot stores it.
  const der = Buffer.from(fixture('test_signing_pub.pem').toString('ascii')
    .replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, ''), 'base64');
  assert.deepEqual(listed.body.signingKey, { fingerprint: sha256(der) });
  assert.equal(listed.body.signingKey.fingerprint, config.signingKeyFingerprint);
  assert.equal(listed.body.releases[0].keyHash, listed.body.signingKey.fingerprint);
});

test('a release is looked up by its exact version', async () => {
  const { viewer, call, upload } = setup();
  await upload(fixture('valid-1.2.3+4.signed.bin'));

  // The plus sign as it is, percent-encoded, and as the space a form decoder makes of it.
  for (const path of ['/api/firmware/1.2.3+4', '/api/firmware/1.2.3%2B4', '/api/firmware/1.2.3%2b4',
    '/api/firmware/1.2.3 4', '/api/firmware/1.2.3%204']) {
    const found = await call('GET', path, { as: viewer });
    assert.equal(found.status, 200, path);
    assert.equal(found.body.release.version, '1.2.3+4');
  }
  const missing = await call('GET', '/api/firmware/1.2.3+5', { as: viewer });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'unknown_version');

  for (const text of ['1.2.3', 'latest', '01.2.3+4', '1.2.3+4x', '1.2.3%20%204', '1 2.3+4', '1.2.3+4%20', '1.2.3+4%00',
    '256.0.0+0', '%2e%2e']) {
    const response = await call('GET', `/api/firmware/${text}`, { as: viewer });
    assert.equal(response.status, 400, text);
    assert.equal(response.body.error.code, 'invalid_version');
  }
});

test('stored records are read defensively', () => {
  const item = {
    pk: 'REL', sk: '001.002.00003.0000000004', version: '1.2.3+4', size: 1264, sha256: 'ab'.repeat(32),
    imageHash: 'cd'.repeat(32), keyHash: 'ef'.repeat(32), payloadSize: 600, headerSize: 512, loadAddress: 196608,
    filename: 'zephyr.signed.bin', notes: '', uploadedBy: { sub: 's', email: 'e' },
    uploadedAt: '2026-10-10T22:15:00.000Z', status: 'active', revoked: null,
  };
  assert.equal(releaseFromItem(item).status, 'active');
  assert.equal(Object.hasOwn(releaseFromItem(item), 'pk'), false);
  for (const broken of [null, undefined, 'x', { ...item, version: '1.2.3' }, { ...item, sha256: 'zz' },
    { ...item, size: 0 }, { ...item, size: '1264' }]) {
    assert.equal(releaseFromItem(broken), null);
  }
  // Anything but exactly "active" is not deployable.
  for (const status of ['revoked', 'ACTIVE', '', null, undefined, true]) {
    const release = releaseFromItem({ ...item, status });
    assert.equal(release.status, 'revoked', String(status));
    assert.deepEqual(release.revoked, { by: { sub: '', email: '' }, at: item.uploadedAt, reason: '' });
  }
  assert.equal(objectKey('ab'.repeat(32)), `firmware/${'ab'.repeat(32)}.bin`);
  for (const digest of ['../secret', 'AB'.repeat(32), 'ab'.repeat(31), null]) {
    assert.throws(() => objectKey(digest), TypeError);
  }
});

/** A console with one release of each fixture version and two boards. */
async function withReleases() {
  const context = setup();
  context.fake.addThing(THING);
  context.fake.addThing(OTHER_THING);
  assert.equal((await context.upload(fixture('valid-1.2.3+4.signed.bin'))).status, 201);
  context.deploy = async (version, things) => {
    const response = await context.call('POST', '/api/deployments', { as: context.manager, body: { version, things } });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    context.advance(1000);
    return response.body.deployment.id;
  };
  context.revoke = (version, body = { reason: 'bad build' }) =>
    context.call('POST', `/api/firmware/${version}/revoke`, { as: context.manager, body });
  return context;
}

test('revoking marks the record, then blocks the image, then cancels deployments', async () => {
  const context = await withReleases();
  const { fake, manager, clock } = context;
  const image = fixture('valid-1.2.3+4.signed.bin');
  const jobId = await context.deploy('1.2.3+4', [THING, OTHER_THING]);
  assert.equal(fake.execution(jobId, THING).update('IN_PROGRESS', { step: 'downloading' }).accepted, true);
  fake.calls.length = 0;

  const response = await context.revoke('1.2.3+4', { reason: '  bricks the encoder  ' });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.cancelled, [jobId]);
  assert.equal(response.body.release.status, 'revoked');
  assert.deepEqual(response.body.release.revoked, {
    by: { sub: manager.sub, email: manager.email },
    at: new Date(clock.ms).toISOString(),
    reason: 'bricks the encoder',
  });

  // The order of the three steps.
  const order = fake.methodsCalled().filter((name) =>
    ['markReleaseRevoked', 'tagFirmwareRevoked', 'listJobs', 'cancelJob', 'putAudit'].includes(name));
  assert.deepEqual(order, ['markReleaseRevoked', 'tagFirmwareRevoked', 'listJobs', 'cancelJob', 'putAudit']);

  // 1. the record
  assert.equal(fake.releases.get('001.002.00003.0000000004').status, 'revoked');
  // 2. the object: tagged, so the bucket policy stops serving it
  assert.deepEqual(fake.objects.get(`firmware/${sha256(image)}.bin`).tags, { revoked: 'true' });
  // 3. the deployment: cancelled with force, so the board that had started stops too
  const cancel = fake.calls.find((call) => call.method === 'cancelJob').args[0];
  assert.deepEqual(cancel, { jobId, force: true, reasonCode: 'RELEASE_REVOKED', comment: manager.sub });
  assert.equal(fake.execution(jobId, THING).get().status, 'CANCELED');
  assert.equal(fake.execution(jobId, OTHER_THING).get().status, 'CANCELED');
  assert.equal(fake.execution(jobId, THING).update('IN_PROGRESS', { step: 'rebooting' }).accepted, false);

  // It cannot be deployed any more.
  const deploy = await context.call('POST', '/api/deployments',
    { as: manager, body: { version: '1.2.3+4', things: [THING] } });
  assert.equal(deploy.status, 409);
  assert.equal(deploy.body.error.code, 'release_revoked');
  assert.equal(fake.jobs.size, 1);

  const listed = await context.call('GET', '/api/firmware/1.2.3+4', { as: manager });
  assert.equal(listed.body.release.status, 'revoked');
});

test('revoking cancels only unfinished deployments of that version', async () => {
  const context = await withReleases();
  const { fake } = context;
  assert.equal((await context.upload(fixture('valid-1.2.3+5.signed.bin'))).status, 201);

  // Finished: the board installed it.
  const finished = await context.deploy('1.2.3+4', [THING]);
  fake.execution(finished, THING).update('IN_PROGRESS', { step: 'downloading' });
  fake.execution(finished, THING).update('SUCCEEDED', { running: '1.2.3+4' });
  // Cancelled before any board started.
  const cancelled = await context.deploy('1.2.3+4', [THING]);
  await context.call('POST', `/api/deployments/${cancelled}/cancel`, { as: context.manager, body: { force: false } });
  // Cancelled without force while a board was already downloading.
  const halfCancelled = await context.deploy('1.2.3+4', [THING]);
  fake.execution(halfCancelled, THING).update('IN_PROGRESS', { step: 'downloading' });
  await context.call('POST', `/api/deployments/${halfCancelled}/cancel`, { as: context.manager, body: { force: false } });
  assert.equal(fake.execution(halfCancelled, THING).get().status, 'IN_PROGRESS');
  // Waiting on another board.
  const waiting = await context.deploy('1.2.3+4', [OTHER_THING]);
  // A deployment of another version, on a third board.
  const third = 'cranium-00000000000000cc';
  fake.addThing(third);
  const otherVersion = await context.deploy('1.2.3+5', [third]);
  // A job some other tool created on the same account.
  await fake.createJob({
    jobId: 'factory-test-7', things: [OTHER_THING], document: '{}', description: 'not ours',
    urlExpiresInSec: 600, inProgressTimeoutMinutes: 30,
  });
  fake.calls.length = 0;

  const response = await context.revoke('1.2.3+4');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.cancelled, [halfCancelled, waiting].sort());
  assert.equal(fake.execution(halfCancelled, THING).get().status, 'CANCELED');
  assert.equal(fake.execution(waiting, OTHER_THING).get().status, 'CANCELED');
  assert.equal(fake.execution(finished, THING).get().status, 'SUCCEEDED');
  assert.equal(fake.jobs.get('factory-test-7').status, 'IN_PROGRESS');
  assert.equal(fake.jobs.get(otherVersion).status, 'IN_PROGRESS');
  assert.equal(fake.execution(otherVersion, third).get().status, 'QUEUED');
  assert.deepEqual(fake.calls.filter((entry) => entry.method === 'cancelJob').map((entry) => entry.args[0].jobId).sort(),
    [halfCancelled, waiting].sort());
  for (const call of fake.calls.filter((entry) => entry.method === 'cancelJob')) {
    assert.equal(call.args[0].force, true);
    assert.equal(call.args[0].reasonCode, 'RELEASE_REVOKED');
  }
  const entry = fake.auditLog().at(-1);
  assert.equal(entry.action, 'firmware.revoke');
  assert.equal(entry.outcome, 'ok');
  assert.deepEqual(entry.detail, { reason: 'bad build', cancelled: '2' });
});

test('a release is revoked once', async () => {
  const context = await withReleases();
  assert.equal((await context.revoke('1.2.3+4')).status, 200);
  const first = context.fake.releases.get('001.002.00003.0000000004').revoked;

  context.advance(60_000);
  const again = await context.revoke('1.2.3+4', { reason: 'another reason' });
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'already_revoked');
  assert.deepEqual(context.fake.releases.get('001.002.00003.0000000004').revoked, first);
  assert.equal(context.fake.auditLog().at(-1).outcome, 'rejected');
  assert.equal(context.fake.auditLog().at(-1).detail.code, 'already_revoked');
});

test('revoking needs a known version and a reason', async () => {
  const context = await withReleases();
  const unknown = await context.revoke('7.7.7+7');
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error.code, 'unknown_version');

  const malformed = await context.revoke('1.2.3');
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.error.code, 'invalid_version');

  for (const body of [{}, { reason: '' }, { reason: '   ' }, { reason: 'x'.repeat(201) }, { reason: 'a\nb' },
    { reason: 5 }, { reason: null }, { reason: ['x'] }]) {
    const response = await context.revoke('1.2.3+4', body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(response.body.error.code, 'invalid_reason');
  }
  assert.equal((await context.revoke('1.2.3+4', '[]')).body.error.code, 'invalid_body');
  assert.equal(context.fake.releases.get('001.002.00003.0000000004').status, 'active');
  assert.ok(!context.fake.methodsCalled().includes('markReleaseRevoked'));
  assert.equal((await context.revoke('1.2.3+4', { reason: 'x'.repeat(200) })).status, 200);
});

test('a revocation that was interrupted is completed by asking again', async () => {
  const context = await withReleases();
  const { fake } = context;
  const image = fixture('valid-1.2.3+4.signed.bin');
  const jobId = await context.deploy('1.2.3+4', [THING]);

  // The object cannot be tagged: the release is revoked and the job is still
  // cancelled, but the caller is told that the revocation is not complete.
  fake.failNext('tagFirmwareRevoked');
  const first = await context.revoke('1.2.3+4');
  assert.equal(first.status, 500);
  assert.equal(first.body.error.code, 'revoke_incomplete');
  assert.equal(fake.releases.get('001.002.00003.0000000004').status, 'revoked');
  assert.equal(fake.execution(jobId, THING).get().status, 'CANCELED');
  assert.deepEqual(fake.objects.get(`firmware/${sha256(image)}.bin`).tags, {});
  assert.equal(fake.auditLog().at(-1).outcome, 'error');

  // Asking again finishes the job and then says what is true: it was revoked already.
  const second = await context.revoke('1.2.3+4');
  assert.equal(second.status, 409);
  assert.equal(second.body.error.code, 'already_revoked');
  assert.deepEqual(fake.objects.get(`firmware/${sha256(image)}.bin`).tags, { revoked: 'true' });
});

test('a deployment that cannot be cancelled does not stop the others', async () => {
  const context = await withReleases();
  const { fake } = context;
  const first = await context.deploy('1.2.3+4', [THING]);
  const second = await context.deploy('1.2.3+4', [OTHER_THING]);

  fake.failNext('cancelJob');
  const response = await context.revoke('1.2.3+4');
  assert.equal(response.status, 500);
  assert.equal(response.body.error.code, 'revoke_incomplete');
  const states = [first, second].map((id) => fake.jobs.get(id).status).sort();
  assert.deepEqual(states, ['CANCELED', 'IN_PROGRESS']);
  assert.deepEqual(fake.objects.get(`firmware/${sha256(fixture('valid-1.2.3+4.signed.bin'))}.bin`).tags, { revoked: 'true' });

  const again = await context.revoke('1.2.3+4');
  assert.equal(again.status, 409);
  assert.deepEqual([first, second].map((id) => fake.jobs.get(id).status), ['CANCELED', 'CANCELED']);
});

test('nothing is revoked when the record cannot be written', async () => {
  const context = await withReleases();
  const { fake } = context;
  const jobId = await context.deploy('1.2.3+4', [THING]);
  fake.failNext('markReleaseRevoked');
  const response = await context.revoke('1.2.3+4');
  assert.equal(response.status, 500);
  assert.equal(response.body.error.code, 'internal_error');
  assert.equal(fake.releases.get('001.002.00003.0000000004').status, 'active');
  assert.equal(fake.jobs.get(jobId).status, 'IN_PROGRESS');
  assert.ok(!fake.methodsCalled().includes('tagFirmwareRevoked'));
});
