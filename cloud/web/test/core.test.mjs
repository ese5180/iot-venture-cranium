/**
 * Tests for the part of the console that does not touch the page: grammar, the sign-in
 * flow, the API client and the wording. The module is the very file the browser loads;
 * the browser pieces it uses (storage, location, history, fetch) are stood in for here.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

// The site's scripts are plain ".js" files with no package.json beside them, which Node
// only takes for ES modules from 22.7 on. Importing the source through a data: URL
// works on every Node 22; it suits core.js because core.js imports nothing.
const source = readFileSync(new URL('../src/site/assets/core.js', import.meta.url));
const core = await import(`data:text/javascript;base64,${source.toString('base64')}`);

const THING = 'cranium-fe5b26c0c5b1dcd7';
const DEPLOYMENT = 'cranium-1-1-0-b7-20261010T221500Z-9f3a';
const LARGEST_DEPLOYMENT = 'cranium-255-255-65535-b4294967295-20261010T221500Z-ffff';
const NOON = '2026-10-10T12:00:00Z';
const CONFIG = {
  clientId: 'client-1',
  loginOrigin: 'https://login.example',
  scope: 'openid cranium/console',
  redirectUri: 'https://console.example/',
};

// Grammar.

test('versions are major.minor.revision+build within u8.u8.u16+u32', () => {
  assert.deepEqual(core.parseVersion('1.10.300+4000000000'),
    { major: 1, minor: 10, revision: 300, build: 4000000000 });
  assert.deepEqual(core.parseVersion('0.0.0+0'), { major: 0, minor: 0, revision: 0, build: 0 });
  assert.deepEqual(core.parseVersion('255.255.65535+4294967295'),
    { major: 255, minor: 255, revision: 65535, build: 4294967295 });

  const others = [
    '1.0.0', '1.0+1', '256.0.0+0', '0.256.0+0', '0.0.65536+0', '0.0.0+4294967296', '01.0.0+0',
    '1.0.0+01', ' 1.0.0+1', '1.0.0+1 ', '1.0.0+1\n', 'v1.0.0+1', '1.0.0-rc+1', '1.0.0+', '',
    null, undefined, 100, {},
  ];
  for (const text of others) {
    assert.equal(core.parseVersion(text), null, String(text));
    assert.equal(core.isVersion(text), false);
  }
  assert.equal(core.formatVersion(core.parseVersion('1.2.3+4')), '1.2.3+4');
});

test('versions compare by number, not by text', () => {
  const order = ['1.9.0+0', '1.10.0+0', '1.10.0+1', '1.10.1+0', '2.0.0+0'].map(core.parseVersion);
  for (let i = 0; i < order.length; i += 1) {
    for (let j = 0; j < order.length; j += 1) {
      assert.equal(Math.sign(core.compareVersions(order[i], order[j])), Math.sign(i - j));
    }
  }
});

test('board names and deployment ids follow their patterns exactly', () => {
  assert.equal(core.isThing(THING), true);
  const notThings = [
    'cranium-FE5B26C0C5B1DCD7', 'cranium-fe5b26c0c5b1dcd', 'cranium-fe5b26c0c5b1dcd77',
    'cranium-fe5b26c0c5b1dcdg', `${THING}/`, `x${THING}`, 'cranium-*', '', null, undefined,
  ];
  for (const name of notThings) {
    assert.equal(core.isThing(name), false, String(name));
    assert.equal(core.deviceHref(name), null);
  }
  assert.equal(core.deviceHref(THING), `#/devices/${THING}`);

  assert.equal(core.isDeploymentId(DEPLOYMENT), true);
  assert.equal(core.isDeploymentId(LARGEST_DEPLOYMENT), true);
  const notDeployments = [
    'cranium-1-1-0-7-20261010T221500Z-9f3a', 'cranium-1-1-0-b7-20261010T221500-9f3a',
    'cranium-1-1-0-b7-20261010T221500Z-9F3A', 'cranium-1-1-0-b7-20261010T221500Z-9f3',
    `${DEPLOYMENT}/cancel`, `../${DEPLOYMENT}`, '', null,
  ];
  for (const id of notDeployments) {
    assert.equal(core.isDeploymentId(id), false, String(id));
    assert.equal(core.deploymentHref(id), null);
  }
  assert.equal(core.deploymentHref(DEPLOYMENT), `#/deployments/${DEPLOYMENT}`);
});

test('the version is recovered from a deployment id', () => {
  assert.equal(core.versionOfDeployment(DEPLOYMENT), '1.1.0+7');
  assert.equal(core.versionOfDeployment(LARGEST_DEPLOYMENT), '255.255.65535+4294967295');
  assert.equal(core.versionOfDeployment('cranium-999-0-0-b1-20261010T221500Z-ffff'), null);
  assert.equal(core.versionOfDeployment('something else'), null);
  assert.equal(core.versionOfDeployment(null), null);
});

// Routes.

const ROUTES = [
  '#/overview', '#/devices', `#/devices/${THING}`, '#/firmware', '#/deployments',
  `#/deployments/${DEPLOYMENT}`, '#/activity',
];

test('the console has exactly seven kinds of route', () => {
  assert.deepEqual(ROUTES.map(core.parseRoute), [
    { view: 'overview' },
    { view: 'devices' },
    { view: 'device', thing: THING },
    { view: 'firmware' },
    { view: 'deployments' },
    { view: 'deployment', id: DEPLOYMENT },
    { view: 'activity' },
  ]);
  for (const hash of ROUTES) assert.equal(core.routeHash(core.parseRoute(hash)), hash);
});

test('anything else is not a route, and never becomes one', () => {
  const others = [
    '', '#', '#/', '#overview', '/overview', '#/Overview', '#/overview/', '#/overview/x',
    '#/device', '#/devices/', '#/devices/cranium-xyz', `#/devices/${THING}/x`,
    `#/deployments/${THING}`, `#/devices/${DEPLOYMENT}`, '#/firmware/1.1.0+7', '#/settings',
    '#//evil.example', '#/https://evil.example', 'https://evil.example/#/overview',
    'javascript:alert(1)', '#/overview?next=https://evil.example', '#/devices/../firmware',
    null, undefined, 3, {},
  ];
  for (const hash of others) {
    assert.equal(core.parseRoute(hash), null, String(hash));
    assert.equal(core.routeHash(core.parseRoute(hash)), '#/overview');
  }
  assert.equal(core.routeHash({ view: 'device', thing: '../../evil' }), '#/overview');
  assert.equal(core.routeHash({ view: 'deployment', id: 'x' }), '#/overview');
  assert.equal(core.routeHash({ view: 'nowhere' }), '#/overview');
});

// Numbers and times.

test('times are told relative to now', () => {
  const now = Date.parse(NOON);
  const ago = (ms) => core.timeAgo(new Date(now - ms).toISOString(), now);
  assert.equal(ago(0), 'just now');
  assert.equal(ago(4999), 'just now');
  assert.equal(ago(-30000), 'just now');
  assert.equal(ago(5000), '5 s ago');
  assert.equal(ago(59999), '59 s ago');
  assert.equal(ago(3 * 60000), '3 min ago');
  assert.equal(ago(59 * 60000), '59 min ago');
  assert.equal(ago(5 * 3600000), '5 h ago');
  assert.equal(ago(3 * 86400000), '3 d ago');
  assert.notEqual(ago(30 * 86400000), '30 d ago');
  assert.equal(core.timeAgo(null, now), '');
  assert.equal(core.timeAgo('not a time', now), '');
  assert.equal(core.exactTime('not a time'), '');
  assert.notEqual(core.exactTime(NOON), '');
});

test('durations, sizes and signal strength read naturally', () => {
  assert.equal(core.duration(42), '42 s');
  assert.equal(core.duration(300), '5 min');
  assert.equal(core.duration(8040), '2 h 14 min');
  assert.equal(core.duration(7200), '2 h');
  assert.equal(core.duration(273600), '3 d 4 h');
  assert.equal(core.duration(-1), '');
  assert.equal(core.duration(null), '');

  assert.equal(core.fileSize(933888), '912 KiB');
  assert.equal(core.fileSize(815284), '796 KiB');
  assert.equal(core.fileSize(512), '512 bytes');
  assert.equal(core.fileSize(2 * 1024 * 1024), '2.00 MiB');
  assert.equal(core.exactBytes(815284), '815,284 bytes');

  assert.deepEqual(core.signalQuality(-52), { bars: 4, label: 'Excellent' });
  assert.deepEqual(core.signalQuality(-67), { bars: 3, label: 'Good' });
  assert.deepEqual(core.signalQuality(-75), { bars: 2, label: 'Fair' });
  assert.deepEqual(core.signalQuality(-90), { bars: 1, label: 'Weak' });
  assert.equal(core.signalQuality(null), null);

  assert.equal(core.plural(1, 'board'), '1 board');
  assert.equal(core.plural(2, 'board'), '2 boards');
  assert.equal(core.plural(0, 'board is', 'boards are'), '0 boards are');
});

test('free text is reduced to one line without control characters', () => {
  assert.equal(core.singleLine('  two\nlines\tand a bell\x07  '), 'two lines and a bell');
  assert.equal(core.singleLine('plain text, with accents: é'), 'plain text, with accents: é');
  assert.equal(core.singleLine('\x00\x1f\x7f\x85'), '');
  assert.equal(core.singleLine(null), '');

  // What the API refuses as a control character is wider than what a keyboard types:
  // the separators and the invisible characters of pasted text go as well.
  assert.equal(core.singleLine('line\u2028separator\u2029here'), 'line separator here');
  assert.equal(core.singleLine('zero\u200bwidth, soft\u00adhyphen, mark\u200f'), 'zerowidth, softhyphen, mark');
  assert.equal(core.singleLine('\ufeffwith a byte order mark'), 'with a byte order mark');
  assert.equal(core.singleLine('half a pair \ud83d and private \ue000'), 'half a pair  and private');
  assert.equal(core.singleLine('rocket \u{1F680}, tick \u2714\ufe0f'), 'rocket \u{1F680}, tick \u2714\ufe0f');
  assert.equal(core.singleLine('joined \u{1F468}\u200d\u{1F469}'), 'joined \u{1F468}\u{1F469}');
});

// Firmware images.

function imageHeader(fields = {}) {
  const { magic = 0x96f3b83d, headerSize = 512, payloadSize = 814000, version = [1, 2, 300, 70000] } = fields;
  const bytes = new Uint8Array(fields.length ?? 64);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, magic, true);
  view.setUint32(4, 0x30000, true);
  view.setUint16(8, headerSize, true);
  view.setUint32(12, payloadSize, true);
  view.setUint8(20, version[0]);
  view.setUint8(21, version[1]);
  view.setUint16(22, version[2], true);
  view.setUint32(24, version[3], true);
  return bytes;
}

test('the image header is read at the offsets MCUboot uses', () => {
  assert.deepEqual(core.readImageHeader(imageHeader()),
    { ok: true, headerSize: 512, payloadSize: 814000, version: '1.2.300+70000' });
  const largest = imageHeader({ version: [255, 255, 65535, 4294967295] });
  assert.equal(core.readImageHeader(largest).version, '255.255.65535+4294967295');

  // A view into the middle of a larger buffer, and a bare ArrayBuffer.
  const padded = new Uint8Array(100);
  padded.set(imageHeader(), 36);
  assert.equal(core.readImageHeader(padded.subarray(36)).version, '1.2.300+70000');
  assert.equal(core.readImageHeader(imageHeader().buffer).version, '1.2.300+70000');
});

test('a file that is not an image is said to be one', () => {
  assert.equal(core.readImageHeader(new Uint8Array(0)).ok, false);
  assert.equal(core.readImageHeader(imageHeader().subarray(0, 31)).ok, false);
  const wrong = core.readImageHeader(imageHeader({ magic: 0x96f3b83c }));
  assert.equal(wrong.ok, false);
  assert.match(wrong.message, /not an MCUboot image/);
  // The magic number read big endian is not the magic number.
  const bigEndian = Uint8Array.from([0x96, 0xf3, 0xb8, 0x3d, ...new Array(60).fill(0)]);
  assert.equal(core.readImageHeader(bigEndian).ok, false);
});

test('the preview agrees with a real signed image', async (t) => {
  const fixture = new URL('../../api/test/fixtures/valid-1.2.3+4.signed.bin', import.meta.url);
  if (!existsSync(fixture)) {
    t.skip('the firmware fixtures of the API are not present');
    return;
  }
  const bytes = new Uint8Array(readFileSync(fixture));
  assert.deepEqual(core.readImageHeader(bytes),
    { ok: true, headerSize: 512, payloadSize: 600, version: '1.2.3+4' });
  assert.equal(await core.sha256Hex(bytes), createHash('sha256').update(bytes).digest('hex'));
  assert.equal(core.toBase64(bytes), Buffer.from(bytes).toString('base64'));
});

test('base64 is the standard, padded form at every length', () => {
  for (const length of [0, 1, 2, 3, 4, 0x7fff, 0x8000, 0x8001, 0x10000, 100003]) {
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i += 1) bytes[i] = (i * 31 + 7) & 0xff;
    assert.equal(core.toBase64(bytes), Buffer.from(bytes).toString('base64'), `length ${length}`);
  }
});

test('SHA-256 is computed with the platform, as lowercase hex', async () => {
  assert.equal(await core.sha256Hex(new TextEncoder().encode('abc')),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('the recorded file name uses only what the API accepts', () => {
  assert.equal(core.recordedFilename('zephyr.signed.bin'), 'zephyr.signed.bin');
  assert.equal(core.recordedFilename('valid-1.2.3+4.signed.bin'), 'valid-1.2.3_4.signed.bin');
  assert.equal(core.recordedFilename('my build (2).signed.bin'), 'my_build__2_.signed.bin');
  assert.equal(core.recordedFilename('../../etc/passwd'), '.._.._etc_passwd');
  const long = core.recordedFilename(`${'a'.repeat(100)}.signed.bin`);
  assert.equal(long.length, 64);
  assert.equal(long.endsWith('.signed.bin'), true);
  assert.equal(core.recordedFilename(''), 'image.signed.bin');
  for (const name of ['zephyr.signed.bin', 'x y.bin', '<script>.bin', 'é.bin', '']) {
    assert.match(core.recordedFilename(name), /^[A-Za-z0-9._-]{1,64}$/);
  }
});

test('a chosen file is reviewed against the slot and the releases', () => {
  const header = { ok: true, headerSize: 512, payloadSize: 1000, version: '1.2.0+1' };
  const firmware = {
    slotSize: 933888,
    releases: [
      { version: '1.1.0+7', sha256: 'aa' },
      { version: '1.3.0+0', sha256: 'bb' },
      { version: '1.0.0+0', sha256: 'cc' },
    ],
  };
  const review = (changes = {}, known = firmware) =>
    core.reviewImage({ header, size: 1000, digest: 'dd', ...changes }, known);
  const tones = (result) => result.notes.map((note) => note.tone);

  const notAnImage = review({ header: { ok: false, message: 'Not an image.' } });
  assert.deepEqual(notAnImage, { blocked: true, notes: [{ tone: 'bad', text: 'Not an image.' }] });

  assert.equal(review({ size: 933889 }).blocked, true);

  const notNewer = review({ size: 933888 });
  assert.equal(notNewer.blocked, false);
  assert.deepEqual(tones(notNewer), ['good', 'warn']);
  assert.match(notNewer.notes[1].text, /Not newer than 1\.3\.0\+0/);

  assert.deepEqual(tones(review({ header: { ...header, version: '1.10.0+0' } })), ['good', 'good']);
  assert.match(review({ digest: 'aa' }).notes[1].text, /already registered as 1\.1\.0\+7/);
  assert.match(review({ header: { ...header, version: '1.1.0+7' } }).notes[1].text, /can be used once/);
  assert.match(review({ header: { ...header, version: '0.0.0+0' } }).notes[1].text, /never accepted/);
  assert.match(review({}, { slotSize: 933888, releases: [] }).notes[1].text, /first release/);
  // Before the list of releases has arrived nothing is claimed about the slot or the others.
  assert.deepEqual(review({}, null), { blocked: false, notes: [] });

  // What is registered already says for certain that the server will refuse the file.
  assert.equal(review({ digest: 'aa' }).doomed, true, 'the same file');
  assert.equal(review({ header: { ...header, version: '1.1.0+7' } }).doomed, true, 'a version in use');
  assert.equal(notNewer.doomed, true, 'an older version');
  assert.equal(review({ header: { ...header, version: '0.0.0+0' } }).doomed, true, 'version zero');
  assert.equal(review({ header: { ...header, version: '1.10.0+0' } }).doomed, false);
  assert.equal(review({}, { slotSize: 933888, releases: [] }).doomed, false, 'the first release');
});

// Sign-in.

function memory() {
  const items = new Map();
  const writes = [];
  return {
    writes,
    getItem: (key) => (items.has(key) ? items.get(key) : null),
    setItem(key, value) {
      writes.push([key, String(value)]);
      items.set(key, String(value));
    },
    removeItem: (key) => items.delete(key),
    clear: () => items.clear(),
    contents: () => Object.fromEntries(items),
  };
}

function reply(status, body, headers = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers });
}

const TOKENS = {
  access_token: 'ACCESS-TOKEN',
  id_token: 'ID-TOKEN',
  refresh_token: 'REFRESH-TOKEN',
  token_type: 'Bearer',
  expires_in: 3600,
};

/** A browser as far as sign-in is concerned. `answer` decides what each fetch returns. */
function browser(options = {}) {
  const { search = '', hash = '', answer = () => reply(200, TOKENS), storage = memory() } = options;
  const events = [];
  let time = Date.parse(NOON);
  const location = {
    search,
    hash,
    pathname: '/',
    assign: (url) => events.push({ type: 'navigate', url }),
  };
  const history = {
    replaceState(_state, _title, url) {
      events.push({ type: 'replaceState', url });
      location.search = '';
    },
  };
  const fetch = async (url, request = {}) => {
    events.push({ type: 'fetch', url, options: request });
    return answer(url, request);
  };
  const auth = core.createAuth({
    config: CONFIG,
    storage,
    location,
    history,
    fetch,
    crypto: options.crypto ?? globalThis.crypto,
    now: () => time,
  });
  return {
    auth,
    events,
    storage,
    location,
    fetches: () => events.filter((event) => event.type === 'fetch'),
    navigations: () => events.filter((event) => event.type === 'navigate').map((event) => new URL(event.url)),
    pending: () => JSON.parse(storage.contents()['cranium.signin']),
    advance(seconds) {
      time += seconds * 1000;
    },
  };
}

/** Start a sign-in in one tab and return what the login page would send back. */
async function began(route = '#/firmware') {
  const tab = browser();
  await tab.auth.signIn(route);
  const [authorize] = tab.navigations();
  return { storage: tab.storage, state: authorize.searchParams.get('state'), authorize };
}

/** A tab that has just come back from the login page with a code for its own sign-in. */
async function returned(options = {}) {
  const { storage, state } = await began(options.route);
  return browser({ search: `?code=THE-CODE&state=${state}`, storage, ...options });
}

test('sign-in settings are read from the page, or not at all', () => {
  assert.deepEqual(core.readConfig(JSON.stringify(CONFIG)), CONFIG);
  const local = { ...CONFIG, loginOrigin: 'http://127.0.0.1:8787', redirectUri: 'http://127.0.0.1:8787/' };
  assert.deepEqual(core.readConfig(JSON.stringify({ ...local, extra: 1 })), local);

  const unusable = [
    undefined, null, '', '%CONFIG%', 'null', '[]', '{}',
    JSON.stringify({ ...CONFIG, clientId: '' }),
    JSON.stringify({ ...CONFIG, scope: 5 }),
    JSON.stringify({ ...CONFIG, loginOrigin: 'javascript:alert(1)' }),
    JSON.stringify({ ...CONFIG, loginOrigin: 'https://login.example/path' }),
    JSON.stringify({ ...CONFIG, redirectUri: '/relative' }),
  ];
  for (const text of unusable) assert.equal(core.readConfig(text), null, String(text));
});

test('starting a sign-in sends the browser to the login page with state and an S256 challenge', async () => {
  const tab = browser();
  await tab.auth.signIn(`#/devices/${THING}`);

  assert.equal(tab.fetches().length, 0);
  const [authorize] = tab.navigations();
  assert.equal(`${authorize.origin}${authorize.pathname}`, 'https://login.example/oauth2/authorize');
  const query = authorize.searchParams;
  assert.deepEqual([...query.keys()].sort(), [
    'client_id', 'code_challenge', 'code_challenge_method', 'prompt', 'redirect_uri', 'response_type', 'scope', 'state',
  ]);
  // Every sign-in asks for the password and the code, also while the login page's cookie is valid.
  assert.equal(query.get('prompt'), 'login');
  assert.equal(query.get('response_type'), 'code');
  assert.equal(query.get('client_id'), 'client-1');
  assert.equal(query.get('redirect_uri'), 'https://console.example/');
  assert.equal(query.get('scope'), 'openid cranium/console');
  assert.equal(query.get('code_challenge_method'), 'S256');
  assert.match(query.get('state'), /^[A-Za-z0-9_-]{43}$/);

  const stored = tab.pending();
  assert.deepEqual(Object.keys(stored).sort(), ['route', 'state', 'verifier']);
  assert.equal(stored.state, query.get('state'));
  assert.equal(stored.route, `#/devices/${THING}`);
  assert.match(stored.verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(stored.verifier, stored.state);
  assert.equal(query.get('code_challenge'), createHash('sha256').update(stored.verifier).digest('base64url'));
  // The verifier itself never leaves the tab.
  assert.equal(authorize.href.includes(stored.verifier), false);
});

test('state and verifier are 32 bytes each from the CSPRNG, and the challenge matches RFC 7636', async () => {
  // The verifier of RFC 7636 appendix B, as the bytes it is the encoding of.
  const octets = [
    116, 24, 223, 180, 151, 153, 224, 37, 79, 250, 96, 125, 216, 173, 187, 186,
    22, 212, 37, 77, 105, 214, 191, 240, 91, 88, 5, 88, 83, 132, 141, 121,
  ];
  const asked = [];
  const crypto = {
    subtle: globalThis.crypto.subtle,
    getRandomValues(array) {
      asked.push(array.length);
      if (asked.length === 2) array.set(octets);
      else array.fill(asked.length);
      return array;
    },
  };
  const tab = browser({ crypto });
  await tab.auth.signIn('#/overview');

  assert.deepEqual(asked, [32, 32]);
  assert.equal(tab.pending().verifier, 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk');
  assert.equal(tab.navigations()[0].searchParams.get('code_challenge'),
    'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});

test('two sign-ins never share a state or a verifier', async () => {
  const seen = new Set();
  for (let i = 0; i < 20; i += 1) {
    const tab = browser();
    await tab.auth.signIn('#/overview');
    seen.add(tab.pending().state);
    seen.add(tab.pending().verifier);
  }
  assert.equal(seen.size, 40);
});

test('only a route of the console is remembered for after sign-in', async () => {
  const cases = [
    ['#/firmware', '#/firmware'],
    [`#/deployments/${DEPLOYMENT}`, `#/deployments/${DEPLOYMENT}`],
    ['', '#/overview'],
    ['#/nowhere', '#/overview'],
    ['https://evil.example/', '#/overview'],
    ['#//evil.example', '#/overview'],
    ['javascript:alert(1)', '#/overview'],
    [undefined, '#/overview'],
  ];
  for (const [given, kept] of cases) {
    const tab = browser();
    await tab.auth.signIn(given);
    assert.equal(tab.pending().route, kept, String(given));
  }
});

test('coming back with the right state redeems the code and keeps only the access token', async () => {
  const tab = await returned();
  const outcome = await tab.auth.resume('');
  assert.deepEqual(outcome, { status: 'signed-in', route: '#/firmware' });

  // The address bar is cleaned before anything is requested.
  assert.deepEqual(tab.events[0], { type: 'replaceState', url: '/' });
  assert.equal(tab.events.slice(1).every((event) => event.type === 'fetch'), true);

  const [token] = tab.fetches();
  assert.equal(token.url, 'https://login.example/oauth2/token');
  assert.equal(token.options.method, 'POST');
  assert.equal(token.options.headers['content-type'], 'application/x-www-form-urlencoded');
  assert.equal(token.options.credentials, 'omit');
  const sent = new URLSearchParams(token.options.body);
  assert.deepEqual([...sent.keys()].sort(),
    ['client_id', 'code', 'code_verifier', 'grant_type', 'redirect_uri']);
  assert.equal(sent.get('grant_type'), 'authorization_code');
  assert.equal(sent.get('client_id'), 'client-1');
  assert.equal(sent.get('code'), 'THE-CODE');
  assert.equal(sent.get('redirect_uri'), 'https://console.example/');
  assert.match(sent.get('code_verifier'), /^[A-Za-z0-9_-]{43}$/);

  // What is left in storage: the access token and when it ends.
  const kept = tab.storage.contents();
  assert.deepEqual(Object.keys(kept), ['cranium.session']);
  assert.deepEqual(JSON.parse(kept['cranium.session']),
    { accessToken: 'ACCESS-TOKEN', expiresAt: Date.parse('2026-10-10T13:00:00Z') / 1000 });
  assert.equal(tab.auth.accessToken(), 'ACCESS-TOKEN');
  assert.equal(tab.navigations().length, 0);
});

test('the refresh token is revoked at once and never stored, nor the ID token or the code', async () => {
  const tab = await returned();
  await tab.auth.resume('');

  assert.equal(tab.fetches().length, 2);
  const revoke = tab.fetches()[1];
  assert.equal(revoke.url, 'https://login.example/oauth2/revoke');
  assert.equal(revoke.options.method, 'POST');
  assert.equal(revoke.options.credentials, 'omit');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(revoke.options.body)),
    { token: 'REFRESH-TOKEN', client_id: 'client-1' });
  assert.equal(await tab.auth.revocation(), 'revoked');

  for (const [, value] of tab.storage.writes) {
    for (const secret of ['REFRESH-TOKEN', 'ID-TOKEN', 'THE-CODE']) {
      assert.equal(value.includes(secret), false, `${secret} must never be stored`);
    }
  }
});

test('the hash of the address is kept when the query string is removed', async () => {
  const tab = await returned({ hash: '#/activity' });
  await tab.auth.resume('#/activity');
  assert.deepEqual(tab.events[0], { type: 'replaceState', url: '/#/activity' });
});

test('a reply with an unknown state is discarded without redeeming the code', async () => {
  const { state } = await began();
  const replies = [
    '?code=STOLEN&state=someone-elses', '?code=STOLEN', `?code=STOLEN&state=${state}x`, '?code=STOLEN&state=',
  ];
  for (const search of replies) {
    const tab = browser({ search });
    await tab.auth.signIn('#/firmware');
    tab.events.length = 0;
    const outcome = await tab.auth.resume('');
    assert.deepEqual(outcome, { status: 'signed-out', reason: 'unknown-reply' }, search);
    assert.deepEqual(tab.events, [{ type: 'replaceState', url: '/' }], 'nothing is fetched or navigated');
    assert.deepEqual(tab.storage.contents(), {}, 'the pending sign-in is spent');
  }
  // With nothing pending at all.
  const cold = browser({ search: `?code=STOLEN&state=${state}` });
  assert.deepEqual(await cold.auth.resume(''), { status: 'signed-out', reason: 'unknown-reply' });
  assert.equal(cold.fetches().length, 0);
});

test('a state works once', async () => {
  const { storage, state } = await began();
  const first = browser({ search: `?code=FIRST&state=${state}`, storage });
  assert.equal((await first.auth.resume('')).status, 'signed-in');

  // The same reply again, for instance from the browser's history: the session that
  // exists is kept, but the code is not redeemed a second time.
  const second = browser({ search: `?code=SECOND&state=${state}`, storage });
  assert.deepEqual(await second.auth.resume(''), { status: 'signed-in', route: null });
  assert.equal(second.fetches().length, 0);
});

test('an error from the login page is reported without redeeming anything', async () => {
  const { storage, state } = await began();
  const search = `?error=access_denied&error_description=%3Cb%3Ehello%3C%2Fb%3E&state=${state}`;
  const tab = browser({ search, storage });
  assert.deepEqual(await tab.auth.resume(''),
    { status: 'signed-out', reason: 'login-error', message: 'access_denied' });
  assert.equal(tab.fetches().length, 0);
  assert.deepEqual(storage.contents(), {});

  // An error code that is not a code is not repeated.
  const other = await began();
  const hostile = browser({
    search: `?error=%3Cscript%3Ealert(1)%3C%2Fscript%3E&state=${other.state}`,
    storage: other.storage,
  });
  assert.deepEqual(await hostile.auth.resume(''),
    { status: 'signed-out', reason: 'login-error', message: '' });
});

test('a failed token request signs nobody in and is not retried', async () => {
  const unreadable = /could not read/;
  const cases = [
    [() => reply(400, { error: 'invalid_grant', error_description: '<b>hello</b>' }),
      /refused to issue a token \(invalid_grant\)\.$/],
    [() => reply(400, { error: '<script>' }), /refused to issue a token\.$/],
    [() => reply(500), /refused to issue a token\.$/],
    [() => { throw new TypeError('network down'); }, /could not be reached/],
    [() => reply(200, { ...TOKENS, access_token: '' }), unreadable],
    [() => reply(200, { ...TOKENS, access_token: undefined }), unreadable],
    [() => reply(200, { ...TOKENS, token_type: 'mac' }), unreadable],
    [() => reply(200, { ...TOKENS, expires_in: 0 }), unreadable],
    [() => reply(200, { ...TOKENS, expires_in: '3600' }), unreadable],
    [() => new Response('<html>not json</html>', { status: 200 }), unreadable],
  ];
  for (const [answer, message] of cases) {
    const tab = await returned({ answer });
    const outcome = await tab.auth.resume('');
    assert.equal(outcome.status, 'signed-out');
    assert.equal(outcome.reason, 'no-token');
    assert.match(outcome.message, message);
    assert.doesNotMatch(outcome.message, /[<>]/);
    assert.equal(tab.fetches().length, 1);
    assert.deepEqual(tab.storage.contents(), {});
    assert.equal(tab.auth.accessToken(), null);
    assert.equal(tab.navigations().length, 0);
  }
});

test('how the revocation went is known even when its reply cannot be read', async () => {
  const run = async (answerRevoke) => {
    const answer = (url, options) =>
      (url.endsWith('/oauth2/token') ? reply(200, TOKENS) : answerRevoke(options));
    const tab = await returned({ answer });
    await tab.auth.resume('');
    return { result: await tab.auth.revocation(), revokes: tab.fetches().slice(1) };
  };

  assert.equal((await run(() => reply(200))).result, 'revoked');
  assert.equal((await run(() => reply(400, { error: 'invalid_request' }))).result, 'refused');

  // The reply may not be read across origins: the request is sent once more without
  // asking to read it, which succeeds if the network does.
  const blocked = await run((options) => {
    if (options.mode !== 'no-cors') throw new TypeError('Failed to fetch');
    return reply(200);
  });
  assert.equal(blocked.result, 'sent');
  assert.equal(blocked.revokes.length, 2);
  assert.equal(blocked.revokes[1].options.mode, 'no-cors');
  assert.equal(blocked.revokes[1].options.body, blocked.revokes[0].options.body);

  const offline = await run(() => { throw new TypeError('Failed to fetch'); });
  assert.equal(offline.result, 'failed');

  // Without a refresh token in the reply there is nothing to revoke.
  const none = await returned({ answer: () => reply(200, { ...TOKENS, refresh_token: undefined }) });
  await none.auth.resume('');
  assert.equal(await none.auth.revocation(), 'none');
  assert.equal(none.fetches().length, 1);
});

test('without a session, loading the page starts a sign-in and remembers the route', async () => {
  const tab = browser({ hash: `#/devices/${THING}` });
  assert.deepEqual(await tab.auth.resume(`#/devices/${THING}`), { status: 'redirecting' });
  assert.equal(tab.fetches().length, 0);
  assert.equal(tab.navigations().length, 1);
  assert.equal(tab.navigations()[0].pathname, '/oauth2/authorize');
  assert.equal(tab.pending().route, `#/devices/${THING}`);
});

test('with a session, loading the page asks nobody', async () => {
  const signedIn = await returned();
  await signedIn.auth.resume('');

  const tab = browser({ storage: signedIn.storage, hash: '#/activity' });
  assert.deepEqual(await tab.auth.resume('#/activity'), { status: 'signed-in', route: null });
  assert.deepEqual(tab.events, []);
});

test('the session ends with the token, and is renewed a minute before', async () => {
  const tab = await returned();
  await tab.auth.resume('');

  assert.equal(tab.auth.secondsLeft(), 3600);
  assert.equal(tab.auth.needsRenewal(), false);
  assert.equal(tab.auth.signedInWithin(30), true);
  tab.advance(31);
  assert.equal(tab.auth.signedInWithin(30), false);
  tab.advance(3508);
  assert.equal(tab.auth.secondsLeft(), 61);
  assert.equal(tab.auth.needsRenewal(), false);
  tab.advance(1);
  assert.equal(tab.auth.needsRenewal(), true);
  assert.equal(tab.auth.accessToken(), 'ACCESS-TOKEN');
  tab.advance(60);
  assert.equal(tab.auth.accessToken(), null);

  // A page loaded with less than a minute left signs in again straight away.
  const late = browser({ storage: tab.storage });
  late.advance(3600 - 30);
  assert.deepEqual(await late.auth.resume('#/firmware'), { status: 'redirecting' });
  assert.equal(late.storage.contents()['cranium.session'], undefined);
});

test('a damaged session record counts as none', async () => {
  const damaged = [
    '', 'null', '[]', '{}', 'not json',
    JSON.stringify({ accessToken: 5, expiresAt: 9e9 }),
    JSON.stringify({ accessToken: 'x', expiresAt: 'soon' }),
    JSON.stringify({ accessToken: '', expiresAt: 9e9 }),
  ];
  for (const value of damaged) {
    const storage = memory();
    storage.setItem('cranium.session', value);
    const tab = browser({ storage });
    assert.equal(tab.auth.accessToken(), null, value);
    assert.equal(tab.auth.needsRenewal(), true);
    assert.equal(tab.auth.signedInWithin(30), false);
  }
});

test('signing out clears the tab and ends the session at the login pages', async () => {
  const tab = await returned();
  const { storage } = tab;
  await tab.auth.resume('');
  storage.setItem('something.else', 'left by another script');

  tab.auth.signOut();
  assert.deepEqual(storage.contents(), { 'cranium.signedout': '1' });
  assert.equal(tab.auth.accessToken(), null);
  const [logout] = tab.navigations();
  assert.equal(`${logout.origin}${logout.pathname}`, 'https://login.example/logout');
  assert.deepEqual(Object.fromEntries(logout.searchParams),
    { client_id: 'client-1', logout_uri: 'https://console.example/' });

  // Back from the login pages: signed out, and no sign-in starts by itself.
  const back = browser({ storage });
  assert.deepEqual(await back.auth.resume(''), { status: 'signed-out', reason: 'signed-out' });
  assert.deepEqual(back.events, []);
  assert.deepEqual(storage.contents(), {});
  // The next load is an ordinary one.
  assert.deepEqual(await browser({ storage }).auth.resume(''), { status: 'redirecting' });
});

// The API client.

function client({ answers, token = 'TOKEN-1' }) {
  const calls = [];
  const pauses = [];
  let refused = 0;
  const queue = [...answers];
  const api = core.createApi({
    auth: { accessToken: () => token },
    crypto: globalThis.crypto,
    clock: core.createClock(),
    onUnauthorized: () => { refused += 1; },
    pause: async (ms) => { pauses.push(ms); },
    fetch: async (path, options) => {
      calls.push({ path, options });
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  });
  return { api, calls, pauses, refused: () => refused };
}

/** The API client with a single reply waiting for it. */
const answering = (status, body) => client({ answers: [reply(status, body)] });

const failure = async (promise) => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the request to fail');
};

test('requests carry the access token and nothing else that identifies the browser', async () => {
  const { api, calls } = answering(200, { devices: [], generatedAt: NOON });
  assert.deepEqual(await api.devices(), { devices: [], generatedAt: NOON });
  assert.equal(calls[0].path, '/api/devices');
  assert.equal(calls[0].options.method, 'GET');
  assert.deepEqual(calls[0].options.headers, { authorization: 'Bearer TOKEN-1', accept: 'application/json' });
  assert.equal(calls[0].options.credentials, 'omit');
  assert.equal(calls[0].options.cache, 'no-store');
  assert.equal(calls[0].options.body, undefined);
});

test('without a token nothing is sent', async () => {
  const { api, calls, refused } = client({ answers: [], token: null });
  const error = await failure(api.devices());
  assert.equal(error.status, 401);
  assert.equal(calls.length, 0);
  assert.equal(refused(), 1);
});

test('a 401 is not retried and is reported so that sign-in can start again', async () => {
  const { api, calls, refused } = answering(401, { message: 'Unauthorized' });
  const error = await failure(api.firmware());
  assert.equal(error instanceof core.ApiError, true);
  assert.equal(error.status, 401);
  assert.equal(calls.length, 1);
  assert.equal(refused(), 1);
});

test('a GET is tried three times on 429, 502, 503 and 504, with a growing, jittered pause', async () => {
  for (const status of [429, 502, 503, 504]) {
    const busy = () => reply(status, { message: 'Busy' });
    const { api, calls, pauses } = client({ answers: [busy(), busy(), reply(200, { deployments: [] })] });
    assert.deepEqual(await api.deployments(), []);
    assert.equal(calls.length, 3, String(status));
    assert.equal(pauses.length, 2);
    assert.equal(pauses[0] >= 200 && pauses[0] < 600, true, `first pause ${pauses[0]}`);
    assert.equal(pauses[1] >= 400 && pauses[1] < 1200, true, `second pause ${pauses[1]}`);
  }

  const down = () => reply(503, { message: 'Service Unavailable' });
  const { api, calls } = client({ answers: [down(), down(), down()] });
  const error = await failure(api.deployments());
  assert.equal(calls.length, 3);
  assert.equal(error.status, 503);
  assert.equal(error.message, 'Service Unavailable (HTTP 503).');
});

test('a GET is not retried on other failures', async () => {
  for (const status of [400, 403, 404, 409, 422, 500]) {
    const { api, calls, pauses } = answering(status, { error: { code: 'some_code', message: 'No.' } });
    const error = await failure(api.devices());
    assert.equal(calls.length, 1, String(status));
    assert.equal(pauses.length, 0);
    assert.equal(error.status, status);
  }
});

const SOME_DEPLOYMENT = {
  id: DEPLOYMENT,
  version: '1.1.0+7',
  status: 'IN_PROGRESS',
  things: [THING],
  executions: [],
};

test('a POST is retried on 429 only', async () => {
  const throttled = () => reply(429, { message: 'Too Many Requests' });
  const twice = client({ answers: [throttled(), throttled(), reply(200, { deployment: SOME_DEPLOYMENT })] });
  assert.equal((await twice.api.cancel(DEPLOYMENT, true)).id, DEPLOYMENT);
  assert.equal(twice.calls.length, 3);
  assert.deepEqual(JSON.parse(twice.calls[0].options.body), { force: true });
  assert.equal(twice.calls[0].options.headers['content-type'], 'application/json');

  for (const status of [500, 502, 503, 504]) {
    const { api, calls } = answering(status, { message: 'Bad Gateway' });
    await failure(api.cancel(DEPLOYMENT, false));
    assert.equal(calls.length, 1, String(status));
  }
});

test('a failed request carries the server\'s own message', async () => {
  const busy = {
    code: 'device_busy',
    message: 'A board still has an unfinished update.',
    requestId: 'req-7',
    details: [{ thing: THING, deployment: DEPLOYMENT }, { thing: '<img>', deployment: 'x' }, null],
  };
  const { api } = answering(409, { error: busy });
  const error = await failure(api.deploy({ version: '1.1.0+7', things: [THING] }));
  assert.equal(error.status, 409);
  assert.equal(error.code, 'device_busy');
  assert.equal(error.message, 'A board still has an unfinished update.');
  assert.equal(error.requestId, 'req-7');
  assert.deepEqual(core.busyBoards(error), [{ thing: THING, deployment: DEPLOYMENT }]);
  assert.deepEqual(core.busyBoards(new Error('other')), []);

  const gateway = await failure(answering(403, { message: 'Forbidden' }).api.me());
  assert.equal(gateway.message, 'Forbidden (HTTP 403).');
  assert.equal(gateway.code, 'gateway');

  const page = new Response('<html>oops</html>', { status: 500 });
  const bare = await failure(client({ answers: [page] }).api.me());
  assert.equal(bare.message, 'The server answered with HTTP 500.');

  const offline = new TypeError('Failed to fetch');
  assert.equal((await failure(client({ answers: [offline] }).api.me())).code, 'network');
  const slow = new DOMException('timed out', 'TimeoutError');
  assert.equal((await failure(client({ answers: [slow] }).api.me())).code, 'timeout');
  const garbled = new Response('not json', { status: 200 });
  assert.equal((await failure(client({ answers: [garbled] }).api.me())).code, 'bad_response');
});

test('names are checked before they are put into a path', async () => {
  const { api, calls } = client({ answers: [] });
  const attempts = [
    () => api.device('../firmware'),
    () => api.device(`${THING}/../../me`),
    () => api.device(''),
    () => api.deployment('cranium-1'),
    () => api.deployment(`${DEPLOYMENT}?x=1`),
    () => api.cancel('../../firmware/1.0.0+1/revoke', true),
    () => api.revoke('1.0.0', 'reason'),
    () => api.revoke('1.0.0+1/../..', 'reason'),
    () => api.deploy({ version: 'latest', things: [THING] }),
    () => api.deploy({ version: '1.0.0+1', things: [THING, 'cranium-*'] }),
    () => api.audit({ before: 'a b' }),
    () => api.audit({ before: '../x' }),
  ];
  for (const attempt of attempts) {
    assert.equal((await failure(attempt())) instanceof core.ApiError, true);
  }
  assert.equal(calls.length, 0);
});

test('paths and bodies are what the API expects', async () => {
  const deployment = { deployment: SOME_DEPLOYMENT };
  const revokedRelease = {
    version: '1.1.0+7',
    status: 'revoked',
    revoked: { by: { sub: 's', email: 'e' }, at: NOON, reason: 'r' },
  };
  const { api, calls } = client({ answers: [
    reply(200, { device: { thing: THING }, certificates: [], executions: [] }),
    reply(200, deployment),
    reply(200, { entries: [], next: null }),
    reply(200, { entries: [], next: null }),
    reply(201, deployment),
    reply(201, deployment),
    reply(200, deployment),
    reply(200, { release: revokedRelease, cancelled: [DEPLOYMENT, 'not-an-id'] }),
  ] });

  await api.device(THING);
  await api.deployment(DEPLOYMENT);
  await api.audit();
  await api.audit({ limit: 6, before: 'MjAyNi0xMC0xMA_-' });
  await api.deploy({ version: '1.1.0+7', things: [THING], note: 'a note' });
  await api.deploy({ version: '1.1.0+7', things: [THING], note: '' });
  await api.cancel(DEPLOYMENT, false);
  const revoked = await api.revoke('1.1.0+7', 'the reason');

  assert.deepEqual(calls.map((call) => `${call.options.method} ${call.path}`), [
    `GET /api/devices/${THING}`,
    `GET /api/deployments/${DEPLOYMENT}`,
    'GET /api/audit?limit=50',
    'GET /api/audit?limit=6&before=MjAyNi0xMC0xMA_-',
    'POST /api/deployments',
    'POST /api/deployments',
    `POST /api/deployments/${DEPLOYMENT}/cancel`,
    'POST /api/firmware/1.1.0+7/revoke',
  ]);
  const sent = (index) => JSON.parse(calls[index].options.body);
  assert.deepEqual(sent(4), { version: '1.1.0+7', things: [THING], note: 'a note' });
  assert.deepEqual(sent(5), { version: '1.1.0+7', things: [THING] });
  assert.deepEqual(sent(6), { force: false });
  assert.deepEqual(sent(7), { reason: 'the reason' });
  assert.deepEqual(revoked.cancelled, [DEPLOYMENT]);
  assert.equal(revoked.release.revoked.reason, 'r');
});

test('what a board reports is cut down to known shapes', async () => {
  const hostile = {
    thing: THING,
    online: 'yes',
    lastSeen: 'not a date',
    fw: { version: '<script>alert(1)</script>', confirmed: 1 },
    ota: {
      state: '<img src=x onerror=alert(1)>',
      job: '../../etc/passwd',
      progress: 4000,
      last: 'none\u202eevil',
      error: `${'x'.repeat(200)}\x07`,
    },
    rssi: 12,
    uptime: -5,
    extra: { nested: true },
  };
  const honest = {
    thing: THING,
    online: true,
    lastSeen: NOON,
    fw: { version: '1.0.0+3', confirmed: true },
    ota: { state: 'downloading', job: DEPLOYMENT, progress: 40, last: 'none', error: '' },
    rssi: -52,
    uptime: 8040,
  };
  const { api } = answering(200, { devices: [hostile, { thing: 7 }, honest], generatedAt: 5 });
  const { devices, generatedAt } = await api.devices();

  assert.equal(generatedAt, null);
  assert.equal(devices.length, 2, 'a row without a name is dropped');
  const [bad, good] = devices;
  assert.deepEqual(Object.keys(bad).sort(), ['fw', 'lastSeen', 'online', 'ota', 'rssi', 'thing', 'uptime']);
  assert.equal(bad.online, false);
  assert.equal(bad.lastSeen, null);
  assert.equal(bad.fw, null);
  assert.equal(bad.rssi, null);
  assert.equal(bad.uptime, null);
  assert.equal(bad.ota.job, null);
  assert.equal(bad.ota.progress, 0);
  assert.equal(bad.ota.state.length <= 24, true);
  assert.equal(bad.ota.last, 'none?evil');
  assert.equal(bad.ota.error.length, 64);
  assert.match(bad.ota.error, /^[\x20-\x7e]*$/);
  assert.deepEqual(good, honest);
});

test('a board\'s reason and note are plain ASCII and short', async () => {
  const execution = {
    thing: THING,
    status: 'FAILED',
    phase: 'failed',
    progress: 'half',
    reason: 'café\u202e<script>',
    detail: 'y'.repeat(300),
    running: '9.9.9',
    online: 1,
    queuedAt: NOON,
    startedAt: null,
    lastUpdatedAt: 'x',
    secondsLeft: -3,
  };
  const { api } = answering(200, { deployment: {
    id: DEPLOYMENT,
    version: '1.1.0+7',
    status: 'COMPLETED',
    createdAt: NOON,
    completedAt: null,
    createdBy: null,
    note: 4,
    things: [THING, 9],
    counts: { failed: 1, queued: 'many' },
    executions: [execution, { thing: null }],
  } });
  const deployment = await api.deployment(DEPLOYMENT);

  assert.deepEqual(deployment.things, [THING]);
  assert.equal(deployment.note, '');
  assert.deepEqual(deployment.counts,
    { queued: 0, inProgress: 0, succeeded: 0, failed: 1, rejected: 0, canceled: 0, timedOut: 0, removed: 0 });
  assert.equal(deployment.executions.length, 1);
  const [read] = deployment.executions;
  assert.equal(read.reason, 'caf??<script>');
  assert.equal(read.detail.length, 96);
  assert.equal(read.running, null);
  assert.equal(read.progress, null);
  assert.equal(read.online, false);
  assert.equal(read.lastUpdatedAt, null);
  assert.equal(read.secondsLeft, null);
});

test('a reply with the wrong outline is an error, not a blank page', async () => {
  const cases = [
    [(api) => api.devices(), { devices: 'none' }],
    [(api) => api.devices(), []],
    [(api) => api.devices(), null],
    [(api) => api.device(THING), { device: null, certificates: [], executions: [] }],
    [(api) => api.firmware(), { releases: {} }],
    [(api) => api.deployments(), { deployments: null }],
    [(api) => api.deployment(DEPLOYMENT), { deployment: [] }],
    [(api) => api.deployment(DEPLOYMENT), { deployment: { id: DEPLOYMENT } }],
    [(api) => api.audit(), { entries: 5 }],
    [(api) => api.me(), 'text'],
  ];
  for (const [call, body] of cases) {
    const error = await failure(call(answering(200, body).api));
    assert.equal(error.code, 'bad_response', JSON.stringify(body));
  }
});

test('releases, the audit log and the caller are read field by field', async () => {
  const release = {
    version: '1.1.0+7',
    size: 815284,
    sha256: 'a'.repeat(64),
    imageHash: 'b'.repeat(64),
    keyHash: 'c'.repeat(64),
    payloadSize: 814000,
    headerSize: 512,
    loadAddress: 196608,
    filename: 'zephyr.signed.bin',
    notes: 'n',
    uploadedBy: { sub: 's', email: 'e', role: 'x' },
    uploadedAt: NOON,
    status: 'anything else',
    revoked: null,
    extra: 1,
  };
  const entry = {
    at: NOON,
    actor: { sub: 's', email: 'e' },
    action: 'firmware.upload',
    target: '1.1.0+7',
    outcome: 'ok',
    detail: { size: 815284, nested: { a: 1 }, code: 'x' },
    requestId: 'r-1',
  };
  const { api } = client({ answers: [
    reply(200, { releases: [release], signingKey: { fingerprint: 'd'.repeat(64) }, slotSize: 933888 }),
    reply(200, { entries: [entry], next: 'not a cursor!' }),
    reply(200, { sub: 's', email: 'e', groups: ['release-managers', 4], canWrite: 'yes', expiresAt: 1 }),
  ] });

  const firmware = await api.firmware();
  assert.equal(firmware.fingerprint, 'd'.repeat(64));
  assert.equal(firmware.slotSize, 933888);
  assert.equal(firmware.releases[0].status, 'revoked', 'only "active" counts as active');
  assert.deepEqual(firmware.releases[0].uploadedBy, { sub: 's', email: 'e' });
  assert.equal('extra' in firmware.releases[0], false);

  const audit = await api.audit();
  assert.deepEqual(audit.entries[0].detail, [['size', '815284'], ['code', 'x']]);
  assert.equal(audit.next, null);

  assert.deepEqual(await api.me(), { sub: 's', email: 'e', groups: ['release-managers'], canWrite: false });
});

test('uploading reports progress and returns the release', async () => {
  const sent = [];
  const answers = [
    { status: 429, body: { message: 'Too Many Requests' } },
    { status: 201, body: { release: { version: '1.2.3+4', status: 'active', size: 1264 } } },
    { status: 422, body: { error: { code: 'wrong_key', message: 'Signed with a different key' } } },
  ];
  // The little of XMLHttpRequest the upload uses.
  class Request {
    constructor() {
      this.headers = {};
      this.upload = {};
    }

    open(method, path) {
      this.method = method;
      this.path = path;
    }

    setRequestHeader(name, value) {
      this.headers[name] = value;
    }

    getResponseHeader() {
      return null;
    }

    send(body) {
      sent.push(this);
      this.body = body;
      const answer = answers.shift();
      this.upload.onprogress({ lengthComputable: true, loaded: 50, total: 200 });
      this.upload.onload();
      this.status = answer.status;
      this.responseText = JSON.stringify(answer.body);
      this.onload();
    }
  }
  const progress = [];
  const pauses = [];
  const api = core.createApi({
    auth: { accessToken: () => 'TOKEN-1' },
    XMLHttpRequest: Request,
    crypto: globalThis.crypto,
    clock: core.createClock(),
    onUnauthorized: () => {},
    pause: async (ms) => { pauses.push(ms); },
    fetch: async () => { throw new Error('the upload does not use fetch'); },
  });

  const image = { filename: 'zephyr.signed.bin', notes: '', data: 'AAAA' };
  const release = await api.upload(image, (step) => progress.push(step));
  assert.equal(release.version, '1.2.3+4');
  assert.equal(sent.length, 2, 'a throttled upload is sent again');
  assert.equal(pauses.length, 1);
  assert.equal(sent[1].method, 'POST');
  assert.equal(sent[1].path, '/api/firmware');
  assert.equal(sent[1].headers.authorization, 'Bearer TOKEN-1');
  assert.equal(sent[1].headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(sent[1].body), { filename: 'zephyr.signed.bin', data: 'AAAA' });
  assert.deepEqual(progress.slice(-3), [
    { stage: 'sending', sent: 0 },
    { stage: 'sending', sent: 0.25 },
    { stage: 'checking', sent: 1 },
  ]);

  const refused = await failure(api.upload({ ...image, notes: 'with notes' }));
  assert.equal(refused.status, 422);
  assert.equal(refused.code, 'wrong_key');
  assert.equal(refused.message, 'Signed with a different key');
  assert.equal(JSON.parse(sent[2].body).notes, 'with notes');
});

test('a clock that is far off is corrected from the server\'s Date header', () => {
  let local = Date.parse('2026-10-10T10:00:00Z');
  const clock = core.createClock(() => local);
  assert.equal(clock.now(), local);
  clock.observe('Sat, 10 Oct 2026 10:00:02 GMT');
  assert.equal(clock.now(), local, 'a couple of seconds is within what the header can tell');
  clock.observe('Sat, 10 Oct 2026 12:00:00 GMT');
  assert.equal(clock.now(), Date.parse(NOON));
  local += 5000;
  assert.equal(clock.now(), Date.parse('2026-10-10T12:00:05Z'));
  clock.observe(null);
  clock.observe('yesterday-ish');
  assert.equal(clock.now(), Date.parse('2026-10-10T12:00:05Z'));
});

// Polling.

test('a deployment is polled every 3 s while a board can move, every 10 s while it cannot, otherwise not', () => {
  assert.equal(core.pollInterval(['SUCCEEDED', 'IN_PROGRESS', 'QUEUED']), 3000);
  assert.equal(core.pollInterval(['QUEUED', 'IN_PROGRESS']), 3000);
  assert.equal(core.pollInterval(['SUCCEEDED', 'QUEUED', 'FAILED']), 10000);
  const finished = ['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'REJECTED', 'REMOVED', 'CANCELED'];
  for (const status of [...finished, null, 'SOMETHING_NEW']) {
    assert.equal(core.pollInterval([status]), 0, String(status));
  }
  assert.equal(core.pollInterval([]), 0);

  const counts = (values) => ({ counts: { queued: 0, inProgress: 0, succeeded: 0, ...values } });
  assert.equal(core.summaryActivity(counts({ inProgress: 1, queued: 3 })), 'IN_PROGRESS');
  assert.equal(core.summaryActivity(counts({ queued: 3 })), 'QUEUED');
  assert.equal(core.summaryActivity(counts({ succeeded: 2 })), null);
  // Someone may be standing at a board that is online: the summary is watched as closely
  // as a board that is at work, once the board list has said that one is.
  const waiting = { ...counts({ queued: 1 }), things: ['a', 'b'] };
  assert.equal(core.summaryActivity(waiting, [{ thing: 'a', online: false }, { thing: 'b', online: false }]), 'QUEUED');
  assert.equal(core.summaryActivity(waiting, [{ thing: 'a', online: false }, { thing: 'b', online: true }]), 'IN_PROGRESS');
  assert.equal(core.summaryActivity(waiting, [{ thing: 'c', online: true }]), 'QUEUED');

  assert.equal(core.executionActivity({ status: 'QUEUED', online: true }), 'IN_PROGRESS');
  assert.equal(core.executionActivity({ status: 'QUEUED', online: false }), 'QUEUED');
  assert.equal(core.executionActivity({ status: 'CANCELED', online: true }), 'CANCELED');

  const board = (online, state) => ({ online, ota: state === null ? null : { state } });
  assert.equal(core.deviceActivity(board(true, 'awaiting_user')), 'IN_PROGRESS');
  for (const state of ['downloading', 'verifying', 'rebooting', 'testing']) {
    assert.equal(core.deviceActivity(board(true, state)), 'IN_PROGRESS');
    assert.equal(core.deviceActivity(board(false, state)), null, 'an offline board is not waited on');
  }
  assert.equal(core.deviceActivity(board(true, 'idle')), null);
  assert.equal(core.deviceActivity(board(true, null)), null);

  assert.equal(core.isUnfinished('QUEUED'), true);
  assert.equal(core.isUnfinished('IN_PROGRESS'), true);
  assert.equal(core.isUnfinished('CANCELED'), false);
});

test('a deployment is under way while a board is waiting or at work, whatever the job says', () => {
  const deployment = (status, counts = {}) =>
    ({ status, counts: { queued: 0, inProgress: 0, succeeded: 0, canceled: 0, ...counts } });
  assert.equal(core.isUnderWay(deployment('IN_PROGRESS', { queued: 1 })), true);
  assert.equal(core.isUnderWay(deployment('IN_PROGRESS', { inProgress: 1 })), true);
  // AWS creates the executions a moment after the job.
  assert.equal(core.isUnderWay(deployment('IN_PROGRESS')), true);
  // Cancelled without force while a board was installing: that board carries on.
  assert.equal(core.isUnderWay(deployment('CANCELED', { inProgress: 1, canceled: 1 })), true);
  assert.equal(core.isUnderWay(deployment('CANCELED', { queued: 1 })), true, 'the counts follow the status');
  assert.equal(core.isUnderWay(deployment('CANCELED', { canceled: 2 })), false);
  assert.equal(core.isUnderWay(deployment('COMPLETED', { succeeded: 2 })), false);
  assert.equal(core.isUnderWay(deployment('DELETION_IN_PROGRESS')), false);
});

// The decisions of the timers.

test('a page is read again on its schedule, more slowly after a failure, and not in the background', () => {
  const plan = (interval, failed = false, visible = true) => core.refreshPlan({ interval, failed, visible });
  assert.deepEqual(plan(3000), { every: 3000, wait: 3000 });
  assert.deepEqual(plan(10000), { every: 10000, wait: 10000 });
  assert.deepEqual(plan(0), { every: 0, wait: 0 });
  assert.deepEqual(plan(0, true), { every: 0, wait: 0 }, 'a page that is not polled is not retried either');
  assert.deepEqual(plan(3000, true), { every: 15000, wait: 15000 });
  assert.deepEqual(plan(30000, true), { every: 30000, wait: 30000 });
  // In the background the page still says how often it is read, but no timer is set.
  assert.deepEqual(plan(3000, false, false), { every: 3000, wait: 0 });
  assert.deepEqual(plan(3000, true, false), { every: 15000, wait: 0 });
});

test('sign-in starts again shortly before the token ends, unless work is in hand', () => {
  const idle = { needsRenewal: true, visible: true, gate: false, dialogOpen: false, uploadStage: 'idle' };
  const renew = (changes) => core.shouldRenew({ ...idle, ...changes });
  assert.equal(renew({}), true);
  assert.equal(renew({ needsRenewal: false }), false);
  assert.equal(renew({ visible: false }), false, 'not while the tab is in the background');
  assert.equal(renew({ gate: true }), false, 'a message already fills the page');
  assert.equal(renew({ dialogOpen: true }), false, 'a dialog is left alone');
  // A chosen file would be gone after the round trip, and an upload on its way cut off.
  for (const stage of ['reading', 'ready', 'sending', 'checking', 'refused']) {
    assert.equal(core.uploadInHand(stage), true, stage);
    assert.equal(renew({ uploadStage: stage }), false, stage);
  }
  for (const stage of ['idle', 'done']) {
    assert.equal(core.uploadInHand(stage), false, stage);
    assert.equal(renew({ uploadStage: stage }), true, stage);
  }
  assert.equal(core.SESSION_WARNING_S > 60, true, 'the warning comes before the token is about to end');
});

test('a refused token leads back to sign-in, except where that would go round in circles', () => {
  assert.equal(core.afterUnauthorized({ gate: null, fresh: false }), 'sign-in');
  // Straight after signing in, signing in again would only repeat the refusal.
  assert.equal(core.afterUnauthorized({ gate: null, fresh: true }), 'refused');
  // A message that only says "loading" gives way; one about signing in stays.
  assert.equal(core.afterUnauthorized({ gate: { waiting: true }, fresh: false }), 'sign-in');
  assert.equal(core.afterUnauthorized({ gate: { waiting: true }, fresh: true }), 'refused');
  assert.equal(core.afterUnauthorized({ gate: { title: 'You are signed out' }, fresh: false }), 'stay');
  assert.equal(core.afterUnauthorized({ gate: { leaving: true }, fresh: true }), 'stay');
  // With work in hand the console stays, and the request that failed says what happened.
  assert.equal(core.afterUnauthorized({ gate: null, fresh: false, holding: true }), 'stay');
  assert.equal(core.afterUnauthorized({ gate: null, fresh: true, holding: true }), 'stay');
});

test('a board that a cancellation found at work is followed until it has settled', () => {
  const id = 'cranium-1-1-0-b7-20261010T115900Z-0a0a';
  const at = Date.parse(NOON);
  const cancelled = { status: 'CANCELED', startedAt: NOON, lastUpdatedAt: NOON };
  const board = (state, job = id) => ({ ota: { state, job } });
  const settling = (execution, device, now = at + 60000) => core.stillSettling(execution, device, id, now);

  assert.equal(settling(cancelled, board('rebooting')), true);
  assert.equal(settling(cancelled, board('downloading')), true);
  // The board has moved on, is on to something else, or never said anything.
  assert.equal(settling(cancelled, board('idle')), false);
  assert.equal(settling(cancelled, board('rebooting', 'another')), false);
  assert.equal(settling(cancelled, { ota: null }), false);
  assert.equal(settling(cancelled, undefined), false);
  // Withdrawn before it had started, or not cancelled at all: nothing to follow.
  assert.equal(settling({ ...cancelled, startedAt: null }, board('rebooting')), false);
  assert.equal(settling({ ...cancelled, status: 'IN_PROGRESS' }, board('rebooting')), false);
  // A board that never comes back is not followed for ever.
  assert.equal(settling(cancelled, board('rebooting'), at + 3600000), false);
});

test('a board that said that it restarts counts as restarting only while it counts as online', () => {
  const restarting = { online: true, ota: { state: 'rebooting' } };
  assert.equal(core.isRestarting(restarting), true);
  assert.equal(core.isRestarting({ ...restarting, online: false }), false);
  assert.equal(core.isRestarting({ online: true, ota: { state: 'downloading' } }), false);
  assert.equal(core.isRestarting({ online: true, ota: null }), false);
});

test('a screen reader hears when a board changes state, and not at every percent', () => {
  const board = (state, progress = 0) => ({
    thing: 'cranium-f55e9c7723a34296',
    online: true,
    fw: null,
    ota: { state, job: 'cranium-1-2-3-b5-20261010T115900Z-0a0a', progress, last: 'none', error: '' },
  });
  // The first look at a board says nothing: that is not news.
  const first = core.boardChanges(new Map(), [board('awaiting_user')]);
  assert.deepEqual(first.said, []);
  assert.equal(first.seen.size, 1);

  const pressed = core.boardChanges(first.seen, [board('downloading', 10)]);
  assert.deepEqual(pressed.said, ['cranium-f55e…: Downloading 1.2.3+5.']);
  assert.deepEqual(core.boardChanges(pressed.seen, [board('downloading', 20)]).said, []);
});

// Failed requests.

test('a failed request is a refusal, or it is not known whether it went through', () => {
  const error = (status, code = 'some_code') => new core.ApiError(status, code, 'No.');
  for (const status of [400, 403, 404, 409, 413, 422, 429]) {
    assert.equal(core.isRefusal(error(status)), true, String(status));
  }
  for (const status of [0, 500, 502, 503, 504]) {
    assert.equal(core.isRefusal(error(status)), false, String(status));
  }

  // The page is read again unless the server plainly said no. A conflict is a no that
  // says the page is out of date.
  assert.equal(core.staleAfter(error(422)), false);
  assert.equal(core.staleAfter(error(403)), false);
  assert.equal(core.staleAfter(error(404)), false);
  assert.equal(core.staleAfter(error(409, 'device_busy')), true);
  assert.equal(core.staleAfter(error(409, 'already_finished')), true);
  assert.equal(core.staleAfter(error(500)), true);
  assert.equal(core.staleAfter(error(0, 'network')), true);
});

test('an upload is offered again only where the same file could end differently', () => {
  const error = (status, code) => new core.ApiError(status, code, 'No.');
  const final = [
    [422, 'wrong_key'], [422, 'unsigned'], [422, 'bad_signature'], [422, 'trailing_data'],
    [422, 'wrong_target'], [422, 'version_zero'], [422, 'version_not_newer'], [409, 'version_exists'],
    [413, 'gateway'], [400, 'invalid_data'], [403, 'release_manager_required'],
  ];
  for (const [status, code] of final) {
    assert.equal(core.canRetryUpload(error(status, code)), false, code);
  }
  const passing = [
    [429, 'gateway'], [409, 'upload_conflict'], [500, 'internal'], [503, 'gateway'], [0, 'network'],
    [0, 'timeout'], [0, 'bad_response'],
  ];
  for (const [status, code] of passing) {
    assert.equal(core.canRetryUpload(error(status, code)), true, code);
  }
});

test('a message of the server is finished as a sentence', () => {
  assert.equal(core.sentence('The image is signed with a different key than this project\'s'),
    'The image is signed with a different key than this project\'s.');
  assert.equal(core.sentence('This is not an MCUboot image (upload the *.signed.bin file)'),
    'This is not an MCUboot image (upload the *.signed.bin file).');
  assert.equal(core.sentence('There is no release 1.2.3+4.'), 'There is no release 1.2.3+4.');
  assert.equal(core.sentence('Is it?'), 'Is it?');
  assert.equal(core.sentence('Wait…'), 'Wait…');
  assert.equal(core.sentence('  padded  '), 'padded.');
  assert.equal(core.sentence(''), '');
  assert.equal(core.sentence(undefined), '');
});

// Revocation.

test('a revocation counts as complete only when the server has recorded that it is', async () => {
  const mark = { by: { sub: 's', email: 'e' }, at: NOON, reason: 'r' };
  const release = (revoked, status = 'revoked') => ({ version: '1.1.0+7', status, revoked });
  const done = '2026-10-10T12:00:05Z';
  const { api } = answering(200, {
    releases: [
      release(null, 'active'),
      release(mark),
      release({ ...mark, enforcedAt: null }),
      release({ ...mark, enforcedAt: done }),
      release({ ...mark, enforcedAt: 'not a time' }),
      release({ ...mark, enforcedAt: 1 }),
      release(null),
    ],
    signingKey: { fingerprint: 'd'.repeat(64) },
    slotSize: 933888,
  });
  const { releases } = await api.firmware();

  // 'unknown' is a server that keeps no record at all; the field is then left out here
  // too, so that the console holds exactly what the API sent.
  assert.deepEqual(releases.map(core.revocationState),
    [null, 'unknown', 'incomplete', 'complete', 'incomplete', 'incomplete', 'unknown']);
  assert.deepEqual(Object.keys(releases[1].revoked), ['by', 'at', 'reason']);
  assert.deepEqual(Object.keys(releases[2].revoked), ['by', 'at', 'reason', 'enforcedAt']);
  assert.equal(releases[2].revoked.enforcedAt, null);
  assert.equal(releases[3].revoked.enforcedAt, done);
  // Anything that is not a time is no record of completion.
  assert.equal(releases[4].revoked.enforcedAt, null);
  assert.equal(releases[5].revoked.enforcedAt, null);
});

test('a repeated revocation that finds everything in place is a success, and is said as one', async () => {
  const already = { code: 'already_revoked', message: 'Release 1.1.0+7 is already revoked.' };
  const { api } = answering(409, { error: already });
  assert.equal(core.revocationInPlace(await failure(api.revoke('1.1.0+7', 'the reason'))), true);

  assert.equal(core.revocationInPlace(new core.ApiError(409, 'version_exists', 'x')), false);
  assert.equal(core.revocationInPlace(new core.ApiError(404, 'already_revoked', 'x')), false);
  // Marked revoked, but a step after the mark failed: that is not in place.
  assert.equal(core.revocationInPlace(new core.ApiError(500, 'revoke_incomplete', 'x')), false);
  assert.equal(core.revocationInPlace(new Error('other')), false);

  const notice = (result) => core.revocationNotice('1.1.0+7', result);
  // A board that runs the release is not touched by the revocation. That has to be said.
  assert.match(notice({ cancelled: [], again: false, running: [THING] }),
    new RegExp(`^Revoked 1\\.1\\.0\\+7\\. No deployment of it was still open\\. ${THING} still runs it; `));
  assert.match(notice({ cancelled: null, again: true, running: [THING, THING] }), /2 boards still run it; /);
  assert.doesNotMatch(notice({ cancelled: [], again: false, running: [] }), /still run/);
  assert.equal(notice({ cancelled: [], again: false }),
    'Revoked 1.1.0+7. No deployment of it was still open.');
  assert.equal(notice({ cancelled: [DEPLOYMENT], again: false }),
    'Revoked 1.1.0+7. 1 unfinished deployment was cancelled.');
  assert.equal(notice({ cancelled: [DEPLOYMENT, DEPLOYMENT], again: true }),
    'The revocation of 1.1.0+7 is in place. 2 unfinished deployments were cancelled.');
  assert.equal(notice({ cancelled: [], again: true }),
    'The revocation of 1.1.0+7 is in place. No deployment of it was still open.');
  // The server only said "already revoked": nothing is claimed about what it cancelled.
  assert.match(notice({ cancelled: null, again: true }), /^The revocation of 1\.1\.0\+7 is in place: /);
  assert.match(notice({ cancelled: null, again: false }), /^1\.1\.0\+7 was revoked already, and that /);
  for (const cancelled of [null, [], [DEPLOYMENT]]) {
    for (const again of [true, false]) {
      assert.doesNotMatch(notice({ cancelled, again }), /\bnot\b|\bfailed\b/i);
    }
  }
});

// Choosing boards.

test('the only free board is chosen without being asked, unless it would refuse the offer', () => {
  const board = (thing, version) => ({ thing, fw: version ? { version, confirmed: true } : null });
  const older = board('cranium-00000000000000aa', '1.0.0+3');
  const same = board('cranium-00000000000000bb', '1.1.0+7');
  const silent = board('cranium-00000000000000cc', null);

  assert.equal(core.alreadyRuns(older, '1.1.0+7'), false);
  assert.equal(core.alreadyRuns(same, '1.1.0+7'), true);
  assert.equal(core.alreadyRuns(same, '1.0.0+3'), true, 'newer than the release counts too');
  assert.equal(core.alreadyRuns(silent, '1.1.0+7'), false, 'a board that has said nothing is not held back');
  assert.equal(core.alreadyRuns(older, null), false);

  const none = new Map();
  assert.equal(core.onlyChoice([older], none, '1.1.0+7'), older.thing);
  assert.equal(core.onlyChoice([silent], none, '1.1.0+7'), silent.thing);
  assert.equal(core.onlyChoice([older, silent], none, '1.1.0+7'), null, 'there is a choice to make');
  assert.equal(core.onlyChoice([older, silent], new Map([[silent.thing, {}]]), '1.1.0+7'), older.thing);
  assert.equal(core.onlyChoice([older], new Map([[older.thing, {}]]), '1.1.0+7'), null);
  assert.equal(core.onlyChoice([same], none, '1.1.0+7'), null);
  assert.equal(core.onlyChoice([], none, '1.1.0+7'), null);
});

// Words.

const PHASES = [
  'waiting_for_device', 'waiting_for_button', 'downloading', 'verifying', 'rebooting', 'testing',
  'succeeded', 'failed', 'rolled_back', 'declined', 'refused', 'cancelled', 'timed_out', 'removed',
];
const TONES = ['act', 'wait', 'live', 'good', 'warn', 'bad', 'idle'];
const STEP_STATES = ['done', 'current', 'failed', 'stopped', 'skipped', 'upcoming'];
const STEP_NAMES = [
  'Offered', 'Approved on the board', 'Downloading', 'Download checked', 'Restarting', 'On trial', 'Confirmed',
];
const STARTED = '2026-10-10T12:01:00Z';

function execution(phase, extra = {}) {
  return {
    thing: THING,
    phase,
    status: 'QUEUED',
    progress: null,
    reason: null,
    detail: null,
    running: null,
    online: true,
    queuedAt: NOON,
    startedAt: null,
    lastUpdatedAt: NOON,
    secondsLeft: null,
    ...extra,
  };
}

const describe = (phase, extra) => core.describeExecution(execution(phase, extra));
const states = (description) => description.steps.map((step) => step.state);
const labels = (description) => description.steps.map((step) => step.label);

/** Every phase, in the variations that change its words. */
function everyDescription() {
  const variations = [
    {},
    { online: false },
    { running: '1.0.0+3', startedAt: STARTED, reason: 'something_new' },
  ];
  const reasons = [
    'download_failed', 'digest_mismatch', 'header_mismatch', 'flash_error', 'interrupted', 'not_installed',
    'not_newer', 'declined', 'rolled_back',
  ];
  const all = [];
  for (const phase of PHASES) {
    for (const extra of variations) all.push([phase, describe(phase, extra)]);
    for (const reason of reasons) all.push([phase, describe(phase, { reason })]);
  }
  return all;
}

test('every phase has plain words, a tone, an icon and seven steps', () => {
  for (const [phase, description] of everyDescription()) {
    assert.equal(TONES.includes(description.tone), true, phase);
    assert.match(description.icon, /^[a-z-]+$/);
    assert.equal(description.title.length > 3, true, phase);
    assert.match(description.text, /\.$/, `${phase}: a full sentence`);
    assert.equal(description.text.startsWith(description.brief), true);
    assert.equal(description.steps.length, 7, phase);
    assert.equal(states(description).every((state) => STEP_STATES.includes(state)), true);
    assert.equal(states(description).filter((state) => state === 'current').length <= 1, true);
    assert.equal(labels(description).every((label) => label.length > 3), true);
  }
  assert.deepEqual(core.STEPS.map((step) => step.name), STEP_NAMES);
});

test('a step is called by what is true of it: done, being waited for, or where it stopped', () => {
  // Done and still ahead: the name. Everything is done after a success.
  assert.deepEqual(labels(describe('succeeded')), STEP_NAMES);
  assert.deepEqual(labels(describe('waiting_for_device')), STEP_NAMES);
  assert.equal(labels(describe('downloading'))[1], 'Approved on the board');
  assert.equal(labels(describe('rebooting'))[3], 'Download checked');

  // Nobody has approved anything while the board waits for its button, or after Button 2.
  // "Button 1" is one word to a line break: the space in it is a no-break space.
  assert.equal(labels(describe('waiting_for_button'))[1], 'Waiting for Button\u00a01');
  assert.equal(labels(describe('declined'))[1], 'Not approved');
  // A board that refuses has not been turned down by anybody.
  assert.equal(labels(describe('refused', { reason: 'not_newer' }))[1], 'Refused');

  // Nothing is verified while the board is checking, or after the check failed.
  assert.equal(labels(describe('verifying'))[3], 'Checking the download');
  assert.equal(labels(describe('failed', { reason: 'digest_mismatch' }))[3], 'Check failed');
  assert.equal(labels(describe('failed', { reason: 'header_mismatch' }))[3], 'Check failed');

  assert.equal(labels(describe('failed', { reason: 'download_failed' }))[2], 'Download failed');
  assert.equal(labels(describe('failed', { reason: 'not_installed' }))[4], 'Did not start');
  assert.equal(labels(describe('rolled_back'))[5], 'Rolled back');

  // Whatever the phase: the step a board is at, or stopped at, never reads as done,
  // and every other step keeps its name.
  for (const [phase, description] of everyDescription()) {
    description.steps.forEach((step, index) => {
      if (step.state === 'current' || step.state === 'failed' || step.state === 'stopped') {
        assert.doesNotMatch(step.label, /^(?:Approved|Download checked|Confirmed)/, `${phase}: ${step.label}`);
      } else {
        assert.equal(step.label, STEP_NAMES[index], phase);
      }
    });
  }
});

test('waiting is told apart: offline, not picked up yet, waiting for the button', () => {
  const upcoming = new Array(6).fill('upcoming');
  const offline = describe('waiting_for_device', { online: false });
  assert.equal(offline.text, 'The board is offline; it will see this update when it reconnects.');
  assert.deepEqual(states(offline), ['current', ...upcoming]);

  const idle = describe('waiting_for_device', { online: true });
  assert.notEqual(idle.title, offline.title);
  assert.match(idle.text, /has not picked up the offer yet/);
  assert.equal(idle.tone, 'wait');
  assert.equal(offline.tone, 'wait');

  // The one state that waits for a person is an instruction, in a tone of its own.
  const button = describe('waiting_for_button');
  assert.equal(button.tone, 'act');
  // A heading that takes two lines must not end the first one on "Button".
  assert.equal(button.title, 'Press Button\u00a01 on the board');
  assert.equal(button.brief, 'The board has the offer and waits for someone to press Button\u00a01.');
  assert.match(button.text, /LED1 blinks quickly while the offer is open; Button 2 declines it\.$/);
  assert.deepEqual(states(button), ['done', 'current', ...upcoming.slice(1)]);
  for (const [phase, description] of everyDescription()) {
    assert.equal(description.tone === 'act', phase === 'waiting_for_button', phase);
  }
});

test('the installing phases move along the steps, with the download in percent', () => {
  const downloading = describe('downloading', { status: 'IN_PROGRESS', progress: 40 });
  assert.equal(downloading.title, 'Downloading 40%');
  assert.equal(downloading.progress, 40);
  assert.equal(downloading.tone, 'live');
  assert.deepEqual(states(downloading),
    ['done', 'done', 'current', 'upcoming', 'upcoming', 'upcoming', 'upcoming']);
  // Without a figure from the board there is no percentage to show.
  assert.equal(describe('downloading').title, 'Downloading');
  assert.equal(describe('downloading').progress, null);

  for (const [phase, step] of [['verifying', 3], ['rebooting', 4], ['testing', 5]]) {
    assert.equal(states(describe(phase)).indexOf('current'), step);
    assert.equal(describe(phase).progress, null);
  }
});

test('the ways an update ends are said plainly', () => {
  const reportsOld = /The board reports that it runs 1\.0\.0\+3\.$/;

  const done = describe('succeeded', { running: '1.1.0+7' });
  assert.equal(done.tone, 'good');
  assert.equal(done.text, 'The board runs 1.1.0+7 and has confirmed it.');
  assert.deepEqual(states(done), new Array(7).fill('done'));

  const rolledBack = describe('rolled_back', { reason: 'rolled_back', running: '1.0.0+3' });
  assert.equal(rolledBack.tone, 'bad');
  assert.match(rolledBack.text, /^The bootloader put the previous firmware back\./);
  assert.match(rolledBack.text, reportsOld);
  assert.deepEqual(states(rolledBack), ['done', 'done', 'done', 'done', 'done', 'failed', 'skipped']);

  const refused = describe('refused', { reason: 'not_newer' });
  assert.equal(refused.text, 'Refused: the board already runs this version or a newer one.');
  assert.equal(refused.code, null);
  assert.deepEqual(states(refused), ['done', 'failed', ...new Array(5).fill('skipped')]);
  for (const reason of ['too_large', 'bad_document', 'unsupported', 'url_not_allowed']) {
    assert.match(describe('refused', { reason }).text, /^Refused: /);
  }

  const declined = describe('declined', { reason: 'declined' });
  assert.match(declined.text, /Button 2/);
  assert.match(declined.text, /Nothing was installed\./);

  // The offer was made, and withdrawn before the board acted on it.
  const early = describe('cancelled');
  assert.match(early.text, /^Cancelled before the board started\./);
  assert.deepEqual(states(early), ['done', ...new Array(6).fill('skipped')]);
  const late = describe('cancelled', { startedAt: STARTED, running: '1.0.0+3' });
  assert.match(late.text, /^Cancelled after the board had started\./);
  assert.match(late.text, reportsOld);
  // It got as far as the download, and no further: that is a place, not a failure.
  assert.deepEqual(states(late), ['done', 'done', 'stopped', ...new Array(4).fill('skipped')]);
  assert.equal(late.tone, 'idle');

  const timedOut = describe('timed_out', { running: '1.0.0+3' });
  assert.equal(timedOut.tone, 'bad');
  assert.match(timedOut.text, reportsOld);
});

test('a board that has never connected is not said to be offline, or to come back', () => {
  const never = core.describeExecution(execution('waiting_for_device', { online: false }),
    { board: { lastSeen: null } });
  assert.equal(never.title, 'Never connected');
  assert.match(never.text, /Power it up and check that it was provisioned/);
  assert.match(never.text, /when it first connects/);
  assert.doesNotMatch(never.text, /reconnect/);

  // A board that has been seen is offline; without the board list that is all that is known.
  const seen = core.describeExecution(execution('waiting_for_device', { online: false }),
    { board: { lastSeen: NOON } });
  assert.equal(seen.title, 'Board offline');
  assert.equal(describe('waiting_for_device', { online: false }).title, 'Board offline');
});

test('a cancelled update says what became of the board, not only that it was cancelled', () => {
  const id = 'cranium-1-1-0-b7-20261010T115900Z-0a0a';
  const known = (ota, fw = { version: '1.0.0+3', confirmed: true }) =>
    ({ board: { lastSeen: NOON, fw, ota }, deployment: id, version: '1.1.0+7' });
  const cancelled = (changes, board) =>
    core.describeExecution(execution('cancelled', { startedAt: STARTED, running: '1.0.0+3', ...changes }), board);

  // Stopped at the step the board last reported, with the steps before it done.
  const verifying = cancelled({}, known({ state: 'verifying', job: id }));
  assert.deepEqual(states(verifying), ['done', 'done', 'done', 'stopped', 'skipped', 'skipped', 'skipped']);
  assert.equal(labels(verifying)[3], 'Checking the download');
  assert.equal(verifying.retry, true);

  // Too far along to be stopped: the page does not claim that it was.
  for (const [state, step] of [['rebooting', 4], ['testing', 5]]) {
    const finishing = cancelled({}, known({ state, job: id }));
    assert.equal(finishing.title, 'Finishing despite the cancellation');
    assert.equal(finishing.tone, 'live');
    assert.equal(states(finishing).indexOf('current'), step);
    assert.equal(finishing.retry, false);
    assert.doesNotMatch(finishing.text, /not installed/);
  }
  // A report about another deployment says nothing about this one.
  assert.equal(cancelled({}, known({ state: 'rebooting', job: 'another' })).title, 'Cancelled');

  // And there it is: the board runs what was cancelled.
  const installed = cancelled({ running: '1.1.0+7' }, known({ state: 'idle', job: null }, { version: '1.1.0+7', confirmed: true }));
  assert.equal(installed.title, 'Installed despite the cancellation');
  assert.equal(installed.tone, 'warn');
  assert.deepEqual(states(installed), new Array(7).fill('done'));
  assert.match(installed.text, /It now runs 1\.1\.0\+7\.$/);
  assert.match(installed.next, /upload a newer version/);
  const onTrial = cancelled({ running: '1.1.0+7' },
    known({ state: 'idle', job: null }, { version: '1.1.0+7', confirmed: false }));
  assert.equal(states(onTrial)[5], 'current');
});

test('a version on a board that another deployment put there is not put down to this one', () => {
  const id = 'cranium-1-1-0-b7-20261010T115900Z-0a0a';
  const other = 'cranium-1-1-0-b7-20261010T120500Z-0b0b';
  const board = { lastSeen: NOON, fw: { version: '1.1.0+7', confirmed: true }, ota: { state: 'idle', job: null } };
  const entry = (deployment, status, version = '1.1.0+7') => ({ deployment, version, status });
  const told = (history) => core.describeExecution(
    execution('cancelled', { startedAt: STARTED, running: '1.1.0+7' }),
    { board, deployment: id, version: '1.1.0+7', history });

  // Offered again, and installed by that: this deployment stopped where it was told to.
  const later = told([entry(id, 'CANCELED'), entry(other, 'SUCCEEDED')]);
  assert.equal(later.title, 'Cancelled');
  assert.equal(later.tone, 'idle');
  assert.equal(later.installed, undefined);
  assert.equal(later.installedBy, other);
  assert.match(later.text, /and it stopped there\. Another deployment installed 1\.1\.0\+7\.$/);
  assert.deepEqual(states(later), ['done', 'done', 'stopped', ...new Array(4).fill('skipped')]);
  assert.equal(later.retry, false, 'the board runs it already: offering it again would be refused');
  assert.equal(told([entry(id, 'CANCELED'), entry(other, 'IN_PROGRESS')]).installedBy, other, 'on trial under the other');

  // Nobody else installed it: it went through all the same.
  for (const history of [[], [entry(id, 'CANCELED')], [entry(id, 'CANCELED'), entry(other, 'REJECTED')],
    [entry(id, 'CANCELED'), entry(other, 'SUCCEEDED', '1.0.0+3')]]) {
    const installed = told(history);
    assert.equal(installed.title, 'Installed despite the cancellation');
    assert.equal(installed.installed, true);
    assert.equal(installed.installedBy, undefined);
  }
  // Without a version on the entry, the name of the deployment has it.
  assert.equal(told([{ deployment: other, version: null, status: 'SUCCEEDED' }]).installedBy, other);

  // Not read yet: nothing is claimed either way.
  const unknown = told(null);
  assert.equal(unknown.title, 'Cancelled');
  assert.equal(unknown.unsure, true);
  assert.match(unknown.text, /The board now runs 1\.1\.0\+7\.$/);
  assert.doesNotMatch(unknown.text, /keeps the firmware it had/);
  assert.equal(unknown.retry, false);

  // A board that is still restarting says so, whatever its list holds.
  const restarting = core.describeExecution(execution('cancelled', { startedAt: STARTED, running: '1.1.0+7' }),
    { board: { ...board, ota: { state: 'rebooting', job: id } }, deployment: id, version: '1.1.0+7', history: null });
  assert.equal(restarting.title, 'Finishing despite the cancellation');
});

test('how a cancelled update ended is not claimed where it cannot be known', () => {
  const id = 'cranium-1-1-0-b7-20261010T115900Z-0a0a';
  const board = (fw, ota = { state: 'idle', job: null }) => ({ lastSeen: NOON, fw: { version: fw, confirmed: true }, ota });
  const said = (changes, known) => core.describeExecution(execution('cancelled', changes), { deployment: id, version: '1.1.0+7', ...known });

  // A newer version came later. Whether this one had finished before that is on no record.
  const movedOn = said({ startedAt: STARTED, running: '2.0.0+0' }, { board: board('2.0.0+0'), history: [] });
  assert.equal(movedOn.title, 'Cancelled');
  assert.equal(movedOn.unsure, true);
  assert.equal(movedOn.retry, false, 'the board would refuse an older version');
  assert.match(movedOn.text, /has since moved on to 2\.0\.0\+0, so this page cannot tell how this update ended\.$/);
  assert.doesNotMatch(movedOn.text, /stops there|keeps the firmware/);
  assert.deepEqual(states(movedOn), ['done', 'done', ...new Array(5).fill('unknown')]);

  // The board list has not been read, so a restart cannot be told from a stop.
  const unread = said({ startedAt: STARTED, running: '1.0.0+3' }, { board: null, history: null, unread: true });
  assert.equal(unread.unsure, true);
  assert.equal(unread.retry, false);
  assert.doesNotMatch(unread.text, /stops there|keeps the firmware/);
  assert.deepEqual(states(unread), ['done', 'done', ...new Array(5).fill('unknown')]);
  // Once it has been, it can.
  const read = said({ startedAt: STARTED, running: '1.0.0+3' }, { board: board('1.0.0+3'), history: null });
  assert.match(read.text, /it stops there and keeps the firmware it had/);
  assert.equal(read.retry, true);

  // The board runs this version, and its own list has not been read.
  const unsure = said({ startedAt: STARTED, running: '1.1.0+7' }, { board: board('1.1.0+7'), history: null });
  assert.deepEqual(states(unsure), ['done', 'done', ...new Array(5).fill('unknown')]);

  // Cancelled at the button, and a later deployment put this version on the board or a newer one.
  for (const running of ['1.1.0+7', '2.0.0+0']) {
    const later = said({ running }, { board: board(running), history: null });
    assert.equal(later.laterCame, true);
    assert.equal(later.retry, false);
    assert.equal(later.next, null);
    assert.match(later.text, new RegExp(`^Cancelled before the board started, so this deployment installed nothing\\. A later one put ${running.replace(/[.+]/g, '\\$&')}`));
  }
  // With the old version still on it, it can be offered again as before.
  const early = said({ running: '1.0.0+3' }, { board: board('1.0.0+3') });
  assert.equal(early.retry, true);
  assert.equal(early.laterCame, undefined);
});

test('a board that a cancellation found restarting keeps a deployment going until it has settled', () => {
  const at = Date.parse(NOON);
  const job = 'cranium-1-1-0-b7-20261010T115900Z-0a0a';
  const run = { id: job, status: 'CANCELED' };
  const board = (state, online = true, lastSeen = NOON) => ({ online, lastSeen, ota: { state, job } });
  assert.equal(core.stillFinishing(run, [board('rebooting')], at), true);
  assert.equal(core.stillFinishing(run, [board('testing')], at), true);
  // A board can drop off AWS during the swap, which takes over a minute.
  assert.equal(core.stillFinishing(run, [board('rebooting', false)], at + 60000), true);
  // And not for ever.
  assert.equal(core.stillFinishing(run, [board('rebooting', false)], at + 3600000), false);
  // Nothing else counts.
  assert.equal(core.stillFinishing(run, [board('downloading')], at), false);
  assert.equal(core.stillFinishing(run, [board('idle')], at), false);
  assert.equal(core.stillFinishing({ ...run, id: 'another' }, [board('rebooting')], at), false);
  assert.equal(core.stillFinishing({ ...run, status: 'COMPLETED' }, [board('rebooting')], at), false);
  assert.equal(core.stillFinishing(run, null, at), false);
  assert.equal(core.stillFinishing(run, [{ online: false, lastSeen: null, ota: null }], at), false);
});

test('a board that already runs a version is not offered it again', () => {
  const refused = describe('refused', { reason: 'not_newer' });
  assert.equal(refused.retry, false);
  assert.match(refused.next, /upload a newer version and deploy that/);
  assert.doesNotMatch(refused.next, /Deal with that/);
});

test('what the server checks about an image has a name for every way it can refuse one', () => {
  const source = new URL('../../api/src/lib/mcuboot.mjs', import.meta.url);
  const handler = new URL('../../api/src/handlers/firmware.mjs', import.meta.url);
  const named = new Set(core.IMAGE_CHECKS.flatMap((check) => check.codes));
  // The one that is not about an image: the server's own key does not load.
  const refusals = [...readFileSync(source, 'utf8').matchAll(/\bfail\('([a-z_]+)'/g)]
    .map((match) => match[1]).filter((code) => code !== 'bad_signing_key');
  assert.equal(refusals.length > 10, true);
  for (const code of refusals) {
    assert.equal(named.has(code), true, `the refusal ${code} has no check`);
    assert.notEqual(core.failedCheck(code), null, code);
  }
  for (const code of ['version_zero', 'version_exists', 'version_not_newer']) {
    assert.match(readFileSync(handler, 'utf8'), new RegExp(`'${code}'`));
    assert.equal(core.failedCheck(code), 'Version');
  }
  // Not a check of the image.
  for (const code of ['upload_conflict', 'release_manager_required', 'gateway', 'constructor']) {
    assert.equal(core.failedCheck(code), null, code);
  }
});

test('an update that ended short says what to do next, and whether offering it again makes sense', () => {
  const rolledBack = describe('rolled_back');
  assert.match(rolledBack.next, /upload a newer version/);
  assert.equal(rolledBack.retry, false, 'the same image would only roll back again');
  for (const [phase, extra] of [
    ['declined', {}], ['refused', { reason: 'too_large' }], ['failed', { reason: 'download_failed' }],
    ['failed', { reason: 'something_new' }], ['cancelled', {}], ['timed_out', {}],
  ]) {
    const ended = describe(phase, extra);
    assert.equal(ended.retry, true, phase);
    assert.match(ended.next, /new deployment/, phase);
  }
  for (const phase of ['waiting_for_device', 'waiting_for_button', 'downloading', 'succeeded']) {
    assert.equal(describe(phase).next, null, phase);
    assert.equal(describe(phase).retry, false, phase);
  }
});

test('the newest entry of a board\'s history uses the board\'s own word for how it ended', () => {
  const label = (status, last) => core.describeHistory(status, last).label;
  assert.equal(label('FAILED', 'rolled_back'), 'Rolled back');
  assert.equal(label('REJECTED', 'declined'), 'Declined on the board');
  assert.equal(label('REJECTED', 'refused'), 'Refused by the board');
  // Only where the status leaves it open, and where the board's word fits the status.
  assert.equal(label('FAILED', 'declined'), 'Failed');
  assert.equal(label('SUCCEEDED', 'rolled_back'), 'Installed');
  assert.equal(label('REJECTED', null), 'Refused or declined');
  assert.equal(label('FAILED', 'constructor'), 'Failed');
});

test('what the server says in the terms of the file format is said in plain words', () => {
  const said = (code, message = 'Its own words.') => core.plainMessage(new core.ApiError(422, code, message));
  assert.match(said('unexpected_tlv'), /not signed the way this project requires/);
  assert.match(said('malformed_tlv'), /cannot be read/);
  assert.equal(said('wrong_key'), 'Its own words.');
  assert.equal(said('constructor'), 'Its own words.');
});

test('what a cancellation did is told by what the boards were doing, and as asked for', () => {
  const said = (changes) => core.cancelNotice({ force: false, withdrawn: false, started: 0, ...changes });
  assert.match(said({}), /no longer offered/);
  assert.match(said({ started: 1 }), /^Cancelled\. 1 board that had started carries on\.$/);
  assert.match(said({ started: 2 }), /^Cancelled\. 2 boards that had started carry on\.$/);
  assert.match(said({ force: true }), /no longer offered/);
  assert.match(said({ force: true, started: 1 }), /have been asked to stop/);
  assert.match(said({ force: true, withdrawn: true, started: 1 }), /^Stop requested\./);
  assert.doesNotMatch(said({ force: true, started: 1 }), /being stopped/);
});

test('the time of day is said for today, and with the day for another day', () => {
  const now = Date.parse('2026-10-10T12:00:00');
  assert.doesNotMatch(core.clockTime('2026-10-10T09:30:00', now), /Oct/);
  assert.match(core.clockTime('2026-10-10T09:30:00', now), /09|9/);
  assert.match(core.clockTime('2026-10-08T09:30:00', now), /Oct/);
  assert.equal(core.clockTime('not a time', now), '');
});

test('a failure is pinned to the step the board names, and only then', () => {
  const failedAt = (reason) => states(describe('failed', { reason })).indexOf('failed');
  assert.equal(failedAt('download_failed'), 2);
  assert.equal(failedAt('digest_mismatch'), 3);
  assert.equal(failedAt('header_mismatch'), 3);
  assert.equal(failedAt('not_installed'), 4);
  assert.equal(failedAt('flash_error'), -1);
  assert.equal(failedAt('interrupted'), -1);
  assert.equal(failedAt('something_new'), -1);
  assert.equal(failedAt(null), -1);

  const known = [
    'download_failed', 'digest_mismatch', 'header_mismatch', 'flash_error', 'interrupted', 'not_installed',
  ];
  for (const reason of known) {
    const description = describe('failed', { reason });
    assert.equal(description.tone, 'bad');
    assert.equal(description.code, null);
    assert.match(description.text, /It keeps running the firmware it had\./);
  }
});

test('a reason the console has no words for is shown as the board gave it', () => {
  assert.equal(describe('failed', { reason: 'something_new' }).code, 'something_new');
  assert.equal(describe('refused', { reason: 'something_new' }).code, 'something_new');
  assert.equal(describe('failed', { reason: null }).code, null);
  // A refusal reported while the update was already under way is a failure with that reason.
  assert.match(describe('failed', { reason: 'not_newer' }).text, /already runs this version or a newer one/);

  const unknown = describe('a_phase_from_the_future');
  assert.equal(unknown.code, 'a_phase_from_the_future');
  assert.equal(unknown.steps.length, 7);
});

test('a word from a board is never mistaken for something every object has', () => {
  const inherited = ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf'];
  for (const word of inherited) {
    for (const phase of ['failed', 'refused']) {
      const description = describe(phase, { reason: word });
      assert.equal(description.code, word);
      assert.doesNotMatch(description.text, /undefined|native code|\[object/);
    }
    const update = core.describeUpdate({
      thing: THING,
      online: true,
      ota: { state: 'idle', job: null, progress: 0, last: word, error: word },
    });
    assert.equal(update.title, 'No update in progress');
    assert.equal(update.text, '');

    const line = core.describeAudit({ action: word, target: word, outcome: word });
    assert.equal(line.verb, word);
    assert.deepEqual(line.outcome, { tone: 'idle', icon: 'minus', label: word });
    assert.equal(line.href, null);
  }
});

test('an execution status has words even when the phase is not known', () => {
  const statuses = [
    'QUEUED', 'IN_PROGRESS', 'SUCCEEDED', 'FAILED', 'TIMED_OUT', 'REJECTED', 'REMOVED', 'CANCELED',
    'NEW_STATUS',
  ];
  for (const status of statuses) {
    const description = core.describeStatus(status);
    assert.equal(TONES.includes(description.tone), true);
    assert.equal(description.label.length > 3, true);
  }
});

test('what a board last reported about updates is put into words', () => {
  const ota = (state, extra = {}) =>
    ({ state, job: DEPLOYMENT, progress: 0, last: 'none', error: '', ...extra });
  const update = (report, online = true) => core.describeUpdate({ thing: THING, online, ota: report });
  const idle = (extra = {}) => update(ota('idle', { job: null, ...extra }));

  assert.equal(update(null).title, 'Nothing reported');
  assert.equal(idle().title, 'No update in progress');
  assert.equal(idle({ last: 'succeeded' }).tone, 'good');
  assert.equal(idle({ last: 'rolled_back', error: 'not confirmed' }).tone, 'bad');
  assert.equal(idle({ last: 'failed', error: 'download_failed' }).text, 'The download failed');
  assert.match(idle({ last: 'refused', error: 'not_newer' }).text, /already runs this version/);
  assert.equal(idle({ last: 'a new word' }).title, 'No update in progress');

  const downloading = update(ota('downloading', { progress: 40 }));
  assert.equal(downloading.title, 'Downloading 1.1.0+7');
  assert.equal(downloading.progress, 40);
  assert.equal(downloading.deployment, DEPLOYMENT);
  assert.equal(update(ota('downloading', { job: null })).title, 'Downloading an update');

  // A board that waits for its button asks for a person, in the tone kept for that.
  const waiting = update(ota('awaiting_user'));
  assert.equal(waiting.title, 'Press Button\u00a01 on the board');
  assert.equal(waiting.tone, 'act');
  assert.match(waiting.text, /^1\.1\.0\+7 is on offer\. Button 1 on the board installs it/);
  assert.equal(waiting.deployment, DEPLOYMENT);

  // An offline board's words are old news and say so.
  const stale = update(ota('downloading', { progress: 40 }), false);
  assert.equal(stale.title, 'Was downloading 1.1.0+7 when last seen');
  assert.equal(stale.progress, null);
  assert.equal(stale.tone, 'idle');
  const gone = update(ota('awaiting_user'), false);
  assert.equal(gone.title, 'Was waiting for Button\u00a01 when last seen');
  assert.equal(gone.tone, 'idle');
  assert.equal(gone.text, '');
  for (const state of ['awaiting_user', 'downloading', 'verifying', 'rebooting', 'testing', 'a_new_state']) {
    assert.match(update(ota(state), false).title, /^Was [a-z].* when last seen$/, state);
  }

  assert.equal(TONES.includes(update(ota('a_new_state')).tone), true);
});

test('a deployment as a whole is summed up from its boards', () => {
  const none = {
    queued: 0, inProgress: 0, succeeded: 0, failed: 0, rejected: 0, canceled: 0, timedOut: 0, removed: 0,
  };
  const summary = (status, counts) =>
    core.describeDeployment({ status, things: [THING, THING], counts: { ...none, ...counts } }).label;
  assert.equal(summary('IN_PROGRESS', { inProgress: 1, queued: 1 }), 'Updating');
  assert.equal(summary('IN_PROGRESS', { queued: 2 }), 'Waiting for boards');
  assert.equal(summary('COMPLETED', { succeeded: 2 }), 'Succeeded');
  assert.equal(summary('COMPLETED', { succeeded: 1, failed: 1 }), 'Partly succeeded');
  assert.equal(summary('COMPLETED', { failed: 1, timedOut: 1 }), 'Failed');
  assert.equal(summary('COMPLETED', { rejected: 2 }), 'Not installed');
  assert.equal(summary('CANCELED', { canceled: 2 }), 'Cancelled');
  // Cancelling leaves boards that had started alone, and the badge does not hide them.
  assert.equal(summary('CANCELED', { inProgress: 1, canceled: 1 }), 'Cancelled, 1 board still working');
  assert.equal(summary('CANCELED', { succeeded: 2 }), 'Cancelled, 2 boards finished');
  // A deployment that is over and went wrong has a sentence of its own, for the overview.
  const said = (status, counts) =>
    core.describeDeployment({ status, things: [THING, THING], counts: { ...none, ...counts } }).said ?? null;
  assert.equal(said('COMPLETED', { failed: 2 }), 'The last deployment failed.');
  assert.equal(said('COMPLETED', { succeeded: 1, failed: 1 }), 'The last deployment partly succeeded.');
  assert.equal(said('CANCELED', { succeeded: 1 }), 'The last deployment was cancelled, but 1 board finished it.');
  // One that went through has its own, so that it is not the quietest outcome.
  assert.equal(said('COMPLETED', { succeeded: 2 }), 'The update is installed and confirmed on 2 boards.');
  assert.equal(core.describeDeployment({
    status: 'COMPLETED', version: '1.1.0+7', things: [THING], counts: { ...none, succeeded: 1 },
  }).said, '1.1.0+7 is installed and confirmed.');
  assert.equal(said('CANCELED', { canceled: 2 }), null);
  assert.equal(summary('SCHEDULED', {}), 'Scheduled');
  assert.equal(summary('DELETION_IN_PROGRESS', {}), 'Being deleted');
  assert.equal(summary('SOMETHING_NEW', {}), 'Unknown');

  const counted = core.describeCounts({ ...none, queued: 2, inProgress: 1, failed: 1 });
  assert.deepEqual(counted.map((entry) => `${entry.count} ${entry.label}`),
    ['1 updating', '2 waiting', '1 failed']);
  // A board that waits for a person is told apart from one that only has yet to come online.
  const words = (counts, atButton) =>
    core.describeCounts({ ...none, ...counts }, atButton).map((entry) => `${entry.count} ${entry.label}`);
  assert.deepEqual(words({ queued: 3 }, 1), ['1 waiting for Button\u00a01', '2 waiting']);
  assert.deepEqual(words({ queued: 1 }, 1), ['1 waiting for Button\u00a01']);
  assert.deepEqual(words({ queued: 1 }, 5), ['1 waiting for Button\u00a01'], 'never more than are waiting');
  assert.equal(core.describeCounts({ ...none, queued: 1 }, 1)[0].tone, 'act');
});

test('an entry of the activity log reads as a sentence and links only to what exists', () => {
  const entry = (action, target, outcome = 'ok', detail = []) =>
    core.describeAudit({ action, target, outcome, detail });
  const said = (line) => `${line.verb} ${line.label}`.trim();

  assert.deepEqual(entry('firmware.upload', '1.1.0+7'), {
    icon: 'upload', verb: 'uploaded firmware', label: '1.1.0+7', outcome: null, href: '#/firmware', facts: [], scripted: false,
  });
  // What a script sent past the gateway is told apart. A request through the gateway cannot carry this id.
  assert.equal(core.describeAudit({ action: 'firmware.revoke', target: '1.1.0+7', outcome: 'ok', detail: [], requestId: 'bench-0123' }).scripted, true);
  assert.equal(core.describeAudit({ action: 'firmware.revoke', target: '1.1.0+7', outcome: 'ok', detail: [], requestId: 'LvC5hbench-=' }).scripted, false);
  assert.equal(said(entry('firmware.revoke', '1.1.0+7')), 'revoked firmware 1.1.0+7');

  // A deployment is called by the version it installs. Its id is one of the details,
  // and the version is not said twice.
  const started = entry('deployment.create', DEPLOYMENT, 'ok', [['version', '1.1.0+7'], ['things', '2']]);
  assert.equal(said(started), 'started a deployment of 1.1.0+7');
  assert.equal(started.href, `#/deployments/${DEPLOYMENT}`);
  assert.deepEqual(started.facts.map((fact) => [fact.label, fact.value, fact.code]),
    [['Boards', '2', false], ['Deployment', DEPLOYMENT, true]]);
  assert.equal(said(entry('deployment.cancel', DEPLOYMENT)), 'cancelled the deployment of 1.1.0+7');
  assert.equal(said(entry('deployment.cancel', DEPLOYMENT, 'rejected')),
    'tried to cancel the deployment of 1.1.0+7');
  assert.equal(said(entry('deployment.create', '1.1.0+7', 'rejected')), 'tried to deploy 1.1.0+7');
  assert.equal(said(entry('deployment.create', DEPLOYMENT, 'rejected')), 'tried to deploy 1.1.0+7');
  // An id whose version is out of range is shown as it is.
  const odd = 'cranium-999-0-0-b1-20261010T221500Z-ffff';
  assert.equal(entry('deployment.cancel', odd).label, odd);
  // Without a target no sentence ends in "of".
  assert.equal(said(entry('deployment.cancel', '', 'rejected')), 'tried to cancel the deployment');
  assert.equal(said(entry('deployment.create', '')), 'started a deployment');
  assert.equal(said(entry('deployment.create', '', 'rejected')), 'tried to deploy');

  const refused = entry('firmware.upload', 'zephyr.signed.bin', 'rejected');
  assert.equal(refused.href, null);
  assert.equal(said(refused), 'tried to upload zephyr.signed.bin');
  assert.equal(refused.outcome.label, 'Refused');
  assert.equal(entry('deployment.create', '1.1.0+7', 'denied').outcome.label, 'Not allowed');
  assert.equal(entry('deployment.create', '1.1.0+7', 'error').outcome.label, 'Server error');
  assert.equal(entry('something.new', 'javascript:alert(1)', 'odd').href, null);
  assert.equal(entry('something.new', 'x', 'odd').verb, 'something.new');
});

test('the details of an entry are put in the words of the console, not in the API\'s field names', () => {
  const facts = (action, outcome, detail) =>
    core.describeAudit({ action, target: '1.1.0+7', outcome, detail }).facts;
  const said = (list) => list.map((fact) => `${fact.label}${fact.phrase ? '' : ':'} ${fact.value}`);
  const digest = 'ab'.repeat(32);

  // In an order that reads well, whatever order the API sent them in.
  const upload = facts('firmware.upload', 'rejected',
    [['sha256', digest], ['size', '1264'], ['filename', 'zephyr.signed.bin'], ['code', 'wrong_key']]);
  assert.deepEqual(said(upload),
    ['Refused with wrong_key', 'File zephyr.signed.bin', 'Size 1,264 bytes', `SHA-256 ${digest}`]);
  // Identifiers are marked as such; a size or a count is not one.
  assert.deepEqual(upload.map((fact) => fact.code), [true, true, false, true]);
  // A refusal is said in words where there are words for it, and only there.
  assert.equal(upload[0].words, 'Signed with a different key than this project’s');
  assert.equal(facts('firmware.upload', 'rejected', [['code', 'something_new']])[0].words, null);
  // The name of the file is not said twice, when it is what the entry is about.
  const named = core.describeAudit({
    action: 'firmware.upload', target: 'x.bin', outcome: 'rejected', detail: [['filename', 'x.bin']],
  });
  assert.deepEqual(named.facts, []);

  // A reason is prose, kept whole, and a revocation counts the deployments it cancelled.
  const reason = 'Pads stop responding after a few minutes of use.';
  const revoke = facts('firmware.revoke', 'ok', [['reason', reason], ['cancelled', '1']]);
  assert.deepEqual(said(revoke), [`Reason: ${reason}`, 'Deployments cancelled 1']);
  assert.equal(revoke[0].code, false);

  assert.deepEqual(said(facts('deployment.cancel', 'ok', [['force', 'true']])), ['Forced yes']);
  assert.deepEqual(said(facts('deployment.cancel', 'error', [['force', 'false'], ['cancelled', 'true'],
    ['code', 'internal']])), ['Failed with internal', 'Forced no', 'Cancelled yes']);
  assert.deepEqual(said(facts('deployment.create', 'rejected', [['version', '1.1.0+7'], ['things', '2'],
    ['code', 'device_busy']])), ['Refused with device_busy', 'Boards 2']);
  // A version that is not the target is said.
  assert.deepEqual(said(facts('deployment.create', 'ok', [['version', '9.9.9+9']])), ['Version 9.9.9+9']);

  // A revocation that could not be completed says which steps are left. One that
  // completes what an earlier request began says so in its sentence.
  assert.deepEqual(said(facts('firmware.revoke', 'error', [['reason', 'A fault.'], ['cancelled', '0'],
    ['incomplete', 'tag cancel record'], ['code', 'revoke_incomplete']])), [
    'Failed with revoke_incomplete',
    'Left undone: refusing the image, cancelling the deployments, recording that it is done',
    'Reason: A fault.', 'Deployments cancelled 0',
  ]);
  assert.deepEqual(said(facts('firmware.revoke', 'error', [['incomplete', 'a_new_step']])),
    ['Left undone: a_new_step']);
  const finished = core.describeAudit({
    action: 'firmware.revoke',
    target: '1.1.0+7',
    outcome: 'ok',
    detail: [['cancelled', '1'], ['resumed', 'true']],
  });
  assert.equal(finished.verb, 'finished revoking firmware');
  assert.deepEqual(said(finished.facts), ['Deployments cancelled 1']);

  // What the console has no word for is shown as the API named it, last.
  assert.deepEqual(said(facts('firmware.upload', 'ok', [['somethingNew', 'x'], ['size', 'unknown'],
    ['constructor', 'y']])), ['Size unknown', 'somethingNew: x', 'constructor: y']);
});

test('a detail of the activity log is kept as long as the API stores it', async () => {
  const reason = 'r'.repeat(200);
  const { api } = answering(200, { entries: [{
    at: NOON,
    actor: { sub: 's', email: 'e' },
    action: 'firmware.revoke',
    target: '1.1.0+7',
    outcome: 'ok',
    detail: { reason: `${reason}and more`, ['k'.repeat(30)]: 'v' },
    requestId: 'r-1',
  }], next: null });
  const [entry] = (await api.audit()).entries;
  assert.deepEqual(entry.detail, [['reason', reason], ['k'.repeat(24), 'v']]);
});

test('a person is named by the address, and the account id is never far', () => {
  const sub = '0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d';
  assert.equal(core.shortAccount(sub), '0b1c2d3e…');
  assert.equal(core.shortAccount('short'), 'short');
  assert.equal(core.shortAccount(undefined), '');
  assert.equal(core.shortAccount(7), '');

  // A reserved domain that can never receive mail; the address exists only here.
  const address = `teammate@${'example.invalid'}`;
  assert.equal(core.nameOf({ sub, email: address }), address);
  // Without an address the account is named by its id, not as "someone".
  assert.equal(core.nameOf({ sub, email: '' }), 'account 0b1c2d3e…');
  assert.equal(core.nameOf({ sub: '', email: '' }), 'an unknown account');
  assert.equal(core.nameOf(null), 'an unknown account');
});

test('entries of the log are filed under the day they happened', () => {
  const now = new Date(2026, 9, 10, 15, 0, 0).getTime();
  assert.equal(core.dayLabel(new Date(2026, 9, 10, 0, 0, 1).toISOString(), now), 'Today');
  assert.equal(core.dayLabel(new Date(2026, 9, 9, 23, 59, 59).toISOString(), now), 'Yesterday');
  assert.notEqual(core.dayLabel(new Date(2026, 9, 8, 12, 0, 0).toISOString(), now), 'Yesterday');
  assert.equal(core.dayLabel('not a time', now), 'Undated');
});
