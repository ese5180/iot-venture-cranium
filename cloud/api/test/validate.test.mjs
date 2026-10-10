// Tests for the input grammar: every value that can arrive in a path, a query string
// or a body, and the body reader itself.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HttpError, SMALL_BODY_LIMIT, field, readJsonObject } from '../src/http.mjs';
import {
  isThing, parseJobId, requireBase64, requireBoolean, requireFilename, requireJobId, requirePageSize,
  requireText, requireThing, requireThings, requireVersion, strictVersion,
} from '../src/lib/validate.mjs';

function refuses(run, code, status = 400) {
  assert.throws(run, (error) => error instanceof HttpError && error.status === status && error.code === code,
    `expected ${status} ${code}`);
}

const thing = (n) => `cranium-${n.toString(16).padStart(16, '0')}`;

test('a version needs all four numbers and stays within MCUboot\'s ranges', () => {
  for (const good of ['1.2.3+4', '0.0.0+0', '0.0.1+0', '255.255.65535+4294967295', '10.20.300+4000']) {
    assert.equal(strictVersion(good).text, good);
    assert.equal(requireVersion(good).text, good);
  }
  assert.deepEqual(strictVersion('1.10.0+7').parts, { major: 1, minor: 10, revision: 0, build: 7 });

  const bad = [
    '1.2.3', '1.2.3+', '1.2+4', '1.2.3.4+5', '+4', 'v1.2.3+4', '1.2.3+4 ', ' 1.2.3+4', '1.2.3+4\n',
    '01.2.3+4', '1.02.3+4', '1.2.03+4', '1.2.3+04', '256.0.0+0', '0.256.0+0', '0.0.65536+0',
    '0.0.0+4294967296', '1.2.3-4', '1.2.3+4+5', '1..3+4', '1,2.3+4', '1.2.3+-4', '1.2.3+4.0', '1.2.3+0x4',
    '\uff11.2.3+4', '1.2.3+4/../x', '', null, undefined, 123, ['1.2.3+4'], { text: '1.2.3+4' },
  ];
  for (const value of bad) {
    assert.equal(strictVersion(value), null, `${JSON.stringify(value)} must not be a version`);
    refuses(() => requireVersion(value), 'invalid_version');
  }
});

test('a thing name is cranium- and exactly 16 lowercase hex digits', () => {
  assert.equal(requireThing('cranium-fe5b26c0c5b1dcd7'), 'cranium-fe5b26c0c5b1dcd7');
  assert.ok(isThing('cranium-0000000000000000'));
  const bad = [
    'cranium-FE5B26C0C5B1DCD7', 'cranium-fe5b26c0c5b1dcd', 'cranium-fe5b26c0c5b1dcd70', 'cranium-fe5b26c0c5b1dcdg',
    'Cranium-fe5b26c0c5b1dcd7', 'fe5b26c0c5b1dcd7', 'cranium-fe5b26c0c5b1dcd7\n', ' cranium-fe5b26c0c5b1dcd7',
    'cranium-fe5b26c0c5b1dcd7/shadow', 'cranium-*', 'cranium-fe5b26c0-c5b1dcd7', '', null, undefined, 7,
    ['cranium-fe5b26c0c5b1dcd7'],
  ];
  for (const value of bad) {
    assert.equal(isThing(value), false, `${JSON.stringify(value)} must not be a thing name`);
    refuses(() => requireThing(value), 'invalid_thing');
  }
});

test('a deployment id has the fixed shape and names a version', () => {
  const job = requireJobId('cranium-1-1-0-b7-20261010T221500Z-9f3a');
  assert.equal(job.id, 'cranium-1-1-0-b7-20261010T221500Z-9f3a');
  assert.equal(job.version, '1.1.0+7');
  assert.equal(parseJobId('cranium-255-255-65535-b4294967295-20261010T221500Z-0000').version,
    '255.255.65535+4294967295');

  const bad = [
    'cranium-1-1-0-7-20261010T221500Z-9f3a', 'cranium-1-1-0-b7-20261010T221500Z-9F3A',
    'cranium-1-1-0-b7-20261010T221500Z-9f3', 'cranium-1-1-0-b7-20261010T221500Z-9f3a0',
    'cranium-1-1-0-b7-20261010T221500-9f3a', 'cranium-1-1-0-b7-2026101T221500Z-9f3a',
    'cranium-1-1-b7-20261010T221500Z-9f3a', 'cranium-1111-1-0-b7-20261010T221500Z-9f3a',
    'cranium-256-1-0-b7-20261010T221500Z-9f3a', 'cranium-1-256-0-b7-20261010T221500Z-9f3a',
    'cranium-1-1-65536-b7-20261010T221500Z-9f3a', 'cranium-1-1-0-b4294967296-20261010T221500Z-9f3a',
    'other-1-1-0-b7-20261010T221500Z-9f3a', 'cranium-1-1-0-b7-20261010T221500Z-9f3a\n',
    'cranium-1-1-0-b7-20261010T221500Z-9f3a/cancel', '../cranium-1-1-0-b7-20261010T221500Z-9f3a', '', null,
    undefined, 12,
  ];
  for (const value of bad) {
    assert.equal(parseJobId(value), null, `${JSON.stringify(value)} must not be a deployment id`);
    refuses(() => requireJobId(value), 'invalid_deployment');
  }
});

test('a file name is 1 to 64 characters from a small set', () => {
  for (const good of ['zephyr.signed.bin', 'a', 'A-b_c.9', 'x'.repeat(64)]) {
    assert.equal(requireFilename(good), good);
  }
  const bad = ['', 'x'.repeat(65), 'a/b', '../x', 'a\\b', 'a b', 'ü.bin', 'a\n', 'a\u0000b', 'a:b', '<x>', null,
    undefined, 5, ['a']];
  for (const value of bad) refuses(() => requireFilename(value), 'invalid_filename');
});

test('free text is trimmed, one line, and within its limit', () => {
  assert.equal(requireText('  for the demo  ', 'note', { max: 200 }), 'for the demo');
  assert.equal(requireText(undefined, 'note', { max: 200 }), '');
  assert.equal(requireText('', 'notes', { max: 500 }), '');
  assert.equal(requireText('x'.repeat(500), 'notes', { max: 500 }).length, 500);
  assert.equal(requireText(`  ${'x'.repeat(200)}\n`, 'note', { max: 200 }).length, 200);
  assert.equal(requireText('Größe 4 µm, naïve café ☕', 'note', { max: 200 }), 'Größe 4 µm, naïve café ☕');

  refuses(() => requireText('x'.repeat(501), 'notes', { max: 500 }), 'invalid_notes');
  refuses(() => requireText('x'.repeat(201), 'note', { max: 200 }), 'invalid_note');
  refuses(() => requireText('x'.repeat(201), 'reason', { min: 1, max: 200 }), 'invalid_reason');

  // Required text must have something left after trimming.
  for (const empty of ['', '   ', '\n\t', undefined]) {
    refuses(() => requireText(empty, 'reason', { min: 1, max: 200 }), 'invalid_reason');
  }
  assert.equal(requireText(' x ', 'reason', { min: 1, max: 200 }), 'x');

  // Control and format characters inside the text.
  const hostile = [
    'two\nlines', 'tab\there', 'nul\u0000byte', 'del\u007f', 'c1\u0085control', 'escape\u001b[31m',
    'zero\u200bwidth', 'right\u202eto-left', 'isolate\u2066x', 'line\u2028separator', 'paragraph\u2029separator',
    'lone\ud800surrogate', 'bom\ufeffinside', 'private\ue000use',
  ];
  for (const value of hostile) {
    refuses(() => requireText(value, 'note', { max: 200 }), 'invalid_note');
  }

  // Wrong types are refused, not converted.
  for (const value of [null, 5, true, ['a'], { toString: () => 'a' }]) {
    refuses(() => requireText(value, 'notes', { max: 500 }), 'invalid_notes');
  }
});

test('a deployment names 1 to 25 different boards', () => {
  assert.deepEqual(requireThings([thing(2), thing(1)]), [thing(1), thing(2)]);
  assert.equal(requireThings(Array.from({ length: 25 }, (_, n) => thing(n))).length, 25);

  refuses(() => requireThings([]), 'invalid_things');
  refuses(() => requireThings(Array.from({ length: 26 }, (_, n) => thing(n))), 'invalid_things');
  refuses(() => requireThings([thing(1), thing(1)]), 'invalid_things');
  refuses(() => requireThings([thing(1), 'cranium-XYZ']), 'invalid_things');
  refuses(() => requireThings([thing(1), null]), 'invalid_things');
  refuses(() => requireThings([[thing(1)]]), 'invalid_things');
  for (const value of [undefined, null, thing(1), { 0: thing(1), length: 1 }, 3]) {
    refuses(() => requireThings(value), 'invalid_things');
  }
});

test('a flag is a boolean and nothing else', () => {
  assert.equal(requireBoolean(true, 'force', false), true);
  assert.equal(requireBoolean(false, 'force', false), false);
  assert.equal(requireBoolean(undefined, 'force', false), false);
  for (const value of ['true', 'false', 1, 0, null, [], {}]) {
    refuses(() => requireBoolean(value, 'force', false), 'invalid_force');
  }
});

test('uploaded data must be canonical base64', () => {
  assert.deepEqual(requireBase64('aGVsbG8=', 'data'), Buffer.from('hello'));
  assert.deepEqual(requireBase64('QQ==', 'data'), Buffer.from('A'));

  const bad = [
    'aGVsbG8',        // padding left out
    'aGVsbG8=\n',     // trailing line break
    'aGVs bG8=',      // white space inside
    'aGVsbG8==',      // too much padding
    'QR==',           // unused bits set: decodes to the same byte as QQ==
    'YWJj-_8=',       // URL-safe alphabet
    'aGVsbG8=AAAA',   // data after the padding
    '!!!!', '', null, undefined, 42, ['aGVsbG8='], Buffer.from('hello'),
  ];
  for (const value of bad) refuses(() => requireBase64(value, 'data'), 'invalid_data');
});

test('the page size of the activity log is 1 to 100', () => {
  assert.equal(requirePageSize(undefined), 50);
  assert.equal(requirePageSize('1'), 1);
  assert.equal(requirePageSize('100'), 100);
  for (const value of ['0', '101', '-1', '1.5', '05', '1e2', ' 5', '5,6', 'ten', '', null, 5]) {
    refuses(() => requirePageSize(value), 'invalid_limit');
  }
});

test('a body is a JSON object, read only after its size is known', () => {
  assert.deepEqual(readJsonObject({ body: '{"a":1,"b":[true]}' }, 100), { a: 1, b: [true] });

  for (const body of ['[1]', '"text"', '5', 'null', 'true']) {
    refuses(() => readJsonObject({ body }, 100), 'invalid_body');
  }
  for (const body of ['', '{', '{"a":}', 'not json', '{"a":1}trailing']) {
    refuses(() => readJsonObject({ body }, 100), 'invalid_json');
  }
  refuses(() => readJsonObject({}, 100), 'invalid_json');
  refuses(() => readJsonObject({ body: null }, 100), 'invalid_json');
  refuses(() => readJsonObject({ body: { a: 1 } }, 100), 'invalid_body');

  // The limit counts characters and is checked before anything is parsed: a body that
  // is too long is refused even though it is not valid JSON.
  const exact = `{"a":"${'x'.repeat(92)}"}`;
  assert.equal(exact.length, 100);
  assert.equal(readJsonObject({ body: exact }, 100).a.length, 92);
  refuses(() => readJsonObject({ body: `${exact} ` }, 100), 'payload_too_large', 413);
  refuses(() => readJsonObject({ body: '{'.repeat(101) }, 100), 'payload_too_large', 413);
});

test('a body the gateway passed on base64 encoded is decoded first', () => {
  const encoded = (text) => ({ body: Buffer.from(text, 'utf8').toString('base64'), isBase64Encoded: true });
  assert.deepEqual(readJsonObject(encoded('{"note":"grüße"}'), 100), { note: 'grüße' });
  // The limit applies to the decoded text, not to its encoding.
  const exact = `{"a":"${'x'.repeat(92)}"}`;
  assert.ok(encoded(exact).body.length > 100);
  assert.equal(readJsonObject(encoded(exact), 100).a.length, 92);
  refuses(() => readJsonObject(encoded(`${exact} `), 100), 'payload_too_large', 413);
  refuses(() => readJsonObject(encoded('x'.repeat(1000)), 100), 'payload_too_large', 413);
  refuses(() => readJsonObject(encoded('not json'), 100), 'invalid_json');
  // Without the flag the same text is not decoded.
  refuses(() => readJsonObject({ body: encoded('{}').body }, 100), 'invalid_json');
});

test('only fields the caller sent are read from a body', () => {
  const body = JSON.parse('{"version":"1.2.3+4","__proto__":{"force":true},"extra":1}');
  assert.equal(field(body, 'version'), '1.2.3+4');
  assert.equal(field(body, 'force'), undefined);
  assert.equal(field(body, 'toString'), undefined);
  assert.equal(field(body, 'constructor'), undefined);
  assert.equal(field({}, 'hasOwnProperty'), undefined);
  assert.ok(SMALL_BODY_LIMIT >= 1024);
});
