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
    'client_id', 'code_challenge', 'code_challenge_method', 'redirect_uri', 'response_type', 'scope', 'state',
  ]);
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

test('a deployment is polled every 3 s while installing, every 10 s while waiting, otherwise not', () => {
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

  const board = (online, state) => ({ online, ota: state === null ? null : { state } });
  assert.equal(core.deviceActivity(board(true, 'awaiting_user')), 'QUEUED');
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

// Words.

const PHASES = [
  'waiting_for_device', 'waiting_for_button', 'downloading', 'verifying', 'rebooting', 'testing',
  'succeeded', 'failed', 'rolled_back', 'declined', 'refused', 'cancelled', 'timed_out', 'removed',
];
const TONES = ['wait', 'live', 'good', 'warn', 'bad', 'idle'];
const STEP_STATES = ['done', 'current', 'failed', 'skipped', 'upcoming'];
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

test('every phase has plain words, a tone, an icon and seven steps', () => {
  const variations = [
    {},
    { online: false },
    { running: '1.0.0+3', startedAt: STARTED, reason: 'something_new' },
  ];
  for (const phase of PHASES) {
    for (const extra of variations) {
      const description = describe(phase, extra);
      assert.equal(TONES.includes(description.tone), true, phase);
      assert.match(description.icon, /^[a-z-]+$/);
      assert.equal(description.title.length > 3, true, phase);
      assert.match(description.text, /\.$/, `${phase}: a full sentence`);
      assert.equal(description.text.startsWith(description.brief), true);
      assert.deepEqual(description.steps.map((step) => step.label), core.STEPS);
      assert.equal(states(description).every((state) => STEP_STATES.includes(state)), true);
      assert.equal(states(description).filter((state) => state === 'current').length <= 1, true);
    }
  }
  assert.deepEqual(core.STEPS,
    ['Offered', 'Approved on the board', 'Downloading', 'Verified', 'Restarting', 'Testing', 'Confirmed']);
});

test('waiting is told apart: offline, not picked up yet, waiting for the button', () => {
  const upcoming = new Array(6).fill('upcoming');
  const offline = describe('waiting_for_device', { online: false });
  assert.equal(offline.text, 'The board is offline; it will see this update when it reconnects.');
  assert.deepEqual(states(offline), ['current', ...upcoming]);

  const idle = describe('waiting_for_device', { online: true });
  assert.notEqual(idle.title, offline.title);
  assert.match(idle.text, /has not picked up the offer yet/);

  const button = describe('waiting_for_button');
  assert.equal(button.tone, 'wait');
  assert.match(button.text, /^Waiting for someone to press Button 1 on the board\./);
  assert.deepEqual(states(button), ['done', 'current', ...upcoming.slice(1)]);
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

  const early = describe('cancelled');
  assert.match(early.text, /^Cancelled before the board started\./);
  assert.deepEqual(states(early), new Array(7).fill('skipped'));
  const late = describe('cancelled', { startedAt: STARTED, running: '1.0.0+3' });
  assert.match(late.text, /^Cancelled after the board had started\./);
  assert.match(late.text, reportsOld);
  assert.deepEqual(states(late).slice(0, 3), ['done', 'done', 'skipped']);

  const timedOut = describe('timed_out', { running: '1.0.0+3' });
  assert.equal(timedOut.tone, 'bad');
  assert.match(timedOut.text, reportsOld);
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
  assert.equal(update(ota('awaiting_user')).title, 'Waiting for Button 1');
  assert.equal(update(ota('downloading', { job: null })).title, 'Downloading an update');

  // An offline board's words are old news and say so.
  const stale = update(ota('downloading', { progress: 40 }), false);
  assert.equal(stale.title, 'Was downloading 1.1.0+7 when last seen');
  assert.equal(stale.progress, null);
  assert.equal(stale.tone, 'idle');

  assert.equal(TONES.includes(update(ota('a_new_state')).tone), true);
});

test('a deployment as a whole is summed up from its boards', () => {
  const none = {
    queued: 0, inProgress: 0, succeeded: 0, failed: 0, rejected: 0, canceled: 0, timedOut: 0, removed: 0,
  };
  const summary = (status, counts) =>
    core.describeDeployment({ status, things: [THING, THING], counts: { ...none, ...counts } }).label;
  assert.equal(summary('IN_PROGRESS', { inProgress: 1, queued: 1 }), 'Installing');
  assert.equal(summary('IN_PROGRESS', { queued: 2 }), 'Waiting for boards');
  assert.equal(summary('COMPLETED', { succeeded: 2 }), 'Succeeded');
  assert.equal(summary('COMPLETED', { succeeded: 1, failed: 1 }), 'Partly succeeded');
  assert.equal(summary('COMPLETED', { failed: 1, timedOut: 1 }), 'Failed');
  assert.equal(summary('COMPLETED', { rejected: 2 }), 'Not installed');
  assert.equal(summary('CANCELED', { canceled: 2 }), 'Cancelled');
  assert.equal(summary('SCHEDULED', {}), 'Scheduled');
  assert.equal(summary('DELETION_IN_PROGRESS', {}), 'Being deleted');
  assert.equal(summary('SOMETHING_NEW', {}), 'Unknown');

  const counted = core.describeCounts({ ...none, queued: 2, inProgress: 1, failed: 1 });
  assert.deepEqual(counted.map((entry) => `${entry.count} ${entry.label}`),
    ['1 installing', '2 waiting', '1 failed']);
});

test('an entry of the activity log reads as a sentence and links only to what exists', () => {
  const entry = (action, target, outcome = 'ok') => core.describeAudit({ action, target, outcome });
  assert.deepEqual(entry('firmware.upload', '1.1.0+7'),
    { icon: 'upload', verb: 'uploaded firmware', outcome: null, href: '#/firmware' });
  assert.equal(entry('deployment.create', DEPLOYMENT).href, `#/deployments/${DEPLOYMENT}`);
  assert.equal(entry('deployment.cancel', DEPLOYMENT).verb, 'cancelled deployment');
  assert.equal(entry('firmware.revoke', '1.1.0+7').verb, 'revoked firmware');

  const refused = entry('firmware.upload', 'zephyr.signed.bin', 'rejected');
  assert.equal(refused.href, null);
  assert.equal(refused.verb, 'tried to upload');
  assert.equal(refused.outcome.label, 'Refused');
  assert.equal(entry('deployment.create', '1.1.0+7', 'denied').outcome.label, 'Not allowed');
  assert.equal(entry('deployment.create', '1.1.0+7', 'error').outcome.label, 'Server error');
  assert.equal(entry('something.new', 'javascript:alert(1)', 'odd').href, null);
  assert.equal(entry('something.new', 'x', 'odd').verb, 'something.new');
});

test('entries of the log are filed under the day they happened', () => {
  const now = new Date(2026, 9, 10, 15, 0, 0).getTime();
  assert.equal(core.dayLabel(new Date(2026, 9, 10, 0, 0, 1).toISOString(), now), 'Today');
  assert.equal(core.dayLabel(new Date(2026, 9, 9, 23, 59, 59).toISOString(), now), 'Yesterday');
  assert.notEqual(core.dayLabel(new Date(2026, 9, 8, 12, 0, 0).toISOString(), now), 'Yesterday');
  assert.equal(core.dayLabel('not a time', now), 'Undated');
});
