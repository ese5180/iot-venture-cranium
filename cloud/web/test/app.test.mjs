/**
 * Tests for the console as a whole: app.js, the very file the browser loads, started
 * in a stand-in for a browser tab. The API is a table of replies, the clock and the
 * timers are the test's, and the tests do what a person does: they look at the page,
 * press buttons, type into fields and wait.
 *
 * What is checked here is what only the whole can show: that the page stops asking
 * while the tab is hidden, that it leaves for the sign-in page in time and not in the
 * middle of something, that it comes back to where it was, and that a dialog tells the
 * truth after the server has said no.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  CORE, VIEWS, all, click, controls, createDocument, one, scriptAddress, textOf,
} from './page.mjs';
import {
  INSTALLING, MANAGER, NEVER, NOW, OFFERED, REASON, WAITING, WITHDRAWN, WORLD, ago, deployment,
  execution, release, repliesFor, revoked,
} from './world.mjs';

// The real timer, kept for waiting on work that is not on the test's clock (hashing).
const realTimeout = globalThis.setTimeout;
const pause = (ms) => new Promise((resolve) => realTimeout(resolve, ms));

/** Let everything that is ready to run, run. */
async function settle() {
  for (let round = 0; round < 4; round += 1) await new Promise((resolve) => setImmediate(resolve));
}

async function until(check, what) {
  for (let waited = 0; waited < 3000; waited += 2) {
    await settle();
    if (check()) return;
    await pause(2);
  }
  assert.fail(`timed out waiting for ${what}`);
}

const LOGIN = 'https://login.example';
const CONFIG = {
  clientId: 'client-1',
  loginOrigin: LOGIN,
  scope: 'openid cranium/console',
  redirectUri: 'https://console.example/',
};
const TOKENS = {
  access_token: 'FRESH-TOKEN', refresh_token: 'REFRESH', token_type: 'Bearer', expires_in: 3600,
};

const refusal = (status, code, message, details) =>
  Response.json({ error: { code, message, requestId: 'req-9', details } }, { status });
/** An answer of the gateway itself, which carries no error code of the API. */
const gateway = (status, message) => Response.json({ message }, { status });

let copies = 0;

/**
 * A browser tab with the console in it, signed in unless told otherwise.
 *
 * @param {object} t                      the test: its clock and timers become the tab's
 * @param {object} [options]
 * @param {object} [options.world]        what the API has (world.mjs)
 * @param {boolean} [options.viewer]      signed in as a viewer
 * @param {string} [options.hash]         the address the tab is opened at
 * @param {string} [options.search]       its query string, as after coming back from sign-in
 * @param {number|null} [options.session] seconds the stored token is still good for; null for none
 * @param {object} [options.stored]       what else session storage holds
 * @param {boolean} [options.touch]       the tab is on a touch screen
 * @param {Function} [options.answer]     (method, url, body) => Response, asked first; whatever
 *                                        it leaves unanswered comes from the table of replies
 * @param {Function} [options.upload]     (body) => { status, body } for an upload
 */
async function openTab(t, options = {}) {
  const {
    world = WORLD, viewer = false, hash = '#/overview', search = '', session = 3600, stored = {},
    touch = false, answer = () => null, upload = () => ({ status: 500, body: {} }),
  } = options;
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: NOW });

  const replies = repliesFor(world, { viewer });
  const requests = [];
  const navigations = [];
  const document = createDocument(['skip', 'main', 'nav', 'account', 'toasts']);
  document.querySelector = (selector) =>
    (selector === 'meta[name="cranium-config"]' ? { content: JSON.stringify(CONFIG) } : null);

  const storage = new Map(Object.entries(stored));
  if (session !== null) {
    const expiresAt = NOW / 1000 + session;
    storage.set('cranium.session', JSON.stringify({ accessToken: 'TOKEN', expiresAt }));
  }
  const sessionStorage = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
    clear: () => storage.clear(),
  };

  const listeners = new Map();
  const tell = (type) => {
    for (const listener of [...listeners.get(type) ?? []]) listener({ type });
  };
  let address = hash;
  const location = {
    pathname: '/',
    search,
    get hash() {
      return address;
    },
    set hash(value) {
      address = value;
      tell('hashchange');
    },
    assign: (url) => navigations.push(url),
    reload: () => navigations.push('reload'),
  };
  const history = {
    replaceState(_state, _title, url) {
      const mark = url.indexOf('#');
      location.search = '';
      address = mark === -1 ? '' : url.slice(mark);
    },
  };

  async function fetch(url, init = {}) {
    const method = init.method ?? 'GET';
    const json = typeof init.body === 'string' && init.body.startsWith('{');
    const body = json ? JSON.parse(init.body) : init.body;
    requests.push({ method, url, body, token: init.headers?.authorization ?? null });
    const special = answer(method, url, body);
    if (special) return special;
    if (method === 'GET' && replies.has(url)) return Response.json(replies.get(url));
    return refusal(404, 'not_found', `There is nothing at ${url}.`);
  }

  // The little of XMLHttpRequest that the upload uses.
  class Upload {
    constructor() {
      this.upload = {};
    }

    open(method, path) {
      this.method = method;
      this.path = path;
    }

    setRequestHeader() {}

    getResponseHeader() {
      return null;
    }

    send(text) {
      const sent = JSON.parse(text);
      requests.push({ method: this.method, url: this.path, body: { ...sent, data: '(the file)' } });
      const reply = upload(sent);
      this.upload.onprogress({ lengthComputable: true, loaded: 1, total: 2 });
      this.upload.onload();
      this.status = reply.status;
      this.responseText = JSON.stringify(reply.body);
      this.onload();
    }
  }

  const window = {
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    scrollTo() {},
    matchMedia: (query) => ({ matches: touch && query === '(pointer: coarse)' }),
    crypto: globalThis.crypto,
    fetch,
    sessionStorage,
    location,
    history,
    XMLHttpRequest: Upload,
  };
  const navigator = { clipboard: { writeText: async () => {} } };
  for (const [name, value] of Object.entries({ document, window, location, history, navigator })) {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }

  // A copy of app.js of its own: the script starts the console when it is loaded.
  copies += 1;
  await import(scriptAddress('app.js', { 'core.js': CORE, 'views.js': VIEWS }, `tab ${copies}`));
  await settle();

  const main = document.getElementById('main');
  const tab = {
    document,
    location,
    requests,
    navigations,
    replies,
    storage,
    main,
    nav: document.getElementById('nav'),
    account: document.getElementById('account'),
    /** The open dialog, or null. */
    dialog: () => all(document.body, 'dialog').find((el) => el.open) ?? null,
    toasts: () => all(document.getElementById('toasts'), 'div.toast').map(textOf),
    /** Requests since the mark, as "METHOD path". */
    since: (mark) => requests.slice(mark).map((request) => `${request.method} ${request.url}`),
    /** From now on the API has this world. */
    becomes(next) {
      for (const [path, body] of repliesFor(next, { viewer })) replies.set(path, body);
    },
    /** Let time pass on the tab's clock, then let what that set off run. */
    async wait(ms) {
      t.mock.timers.tick(ms);
      await settle();
    },
    async goto(route) {
      location.hash = route;
      await settle();
    },
    async press(root, selector, words) {
      click(one(root, selector, words));
      await settle();
    },
    /** Submit the form of the open dialog, as Enter on its submit button does. */
    async submit() {
      one(tab.dialog(), 'form').dispatchEvent({ type: 'submit' });
      await settle();
    },
    async type(field, text) {
      field.value = text;
      field.dispatchEvent({ type: 'input', target: field });
      await settle();
    },
    async hide(hidden) {
      document.visibilityState = hidden ? 'hidden' : 'visible';
      document.dispatchEvent({ type: 'visibilitychange' });
      await settle();
    },
  };
  return tab;
}

const sentTo = (tab, url) => tab.requests.filter((request) => request.url === url);
const WRITES = new Set([
  'Deploy', 'Revoke', 'Finish revoking', 'Apply the revocation again', 'New deployment',
  'Cancel deployment', 'Upload for verification',
]);
const writes = (root) => controls(root).filter((label) => WRITES.has(label));
const releaseRow = (tab, version) => one(tab.main, 'li.release', version);
const badges = (row) => all(one(row, 'div.release-title'), 'span.badge').map(textOf);

// Starting up.

test('the console starts on the page in the address and loads what that page shows', async (t) => {
  const tab = await openTab(t);
  assert.equal(tab.document.title, 'Overview · Cranium');
  assert.equal(textOf(one(tab.main, 'h1')), 'Overview');
  assert.equal(one(tab.nav, 'a', 'Overview').getAttribute('aria-current'), 'page');
  assert.equal(textOf(one(tab.account, 'span.account-email')), MANAGER.email);
  assert.equal(textOf(one(tab.account, 'span.account-role')), 'Release manager');
  assert.equal(textOf(one(tab.account, 'span.account-session')), 'Session ends in 1 h');

  assert.deepEqual(tab.since(0).sort(), [
    'GET /api/audit?limit=6', 'GET /api/deployments', `GET /api/deployments/${OFFERED}`,
    // Cancelled, but its board is still installing: its boards are followed too.
    `GET /api/deployments/${WITHDRAWN}`,
    'GET /api/devices', 'GET /api/firmware', 'GET /api/me',
  ]);
  assert.equal(tab.requests.every((request) => request.token === 'Bearer TOKEN'), true);
  assert.deepEqual(all(tab.main, 'li.run').map((run) => textOf(one(run, 'a.run-version'))),
    ['1.2.3+5', '1.2.4+0']);
  assert.deepEqual(tab.navigations, []);
});

test('an address that is not a page of the console becomes the overview', async (t) => {
  const tab = await openTab(t, { hash: '#/https://evil.example/' });
  assert.equal(tab.location.hash, '#/overview');
  assert.equal(textOf(one(tab.main, 'h1')), 'Overview');
});

test('a viewer gets the pages without the controls', async (t) => {
  const tab = await openTab(t, { viewer: true, hash: '#/firmware' });
  assert.equal(textOf(one(tab.account, 'span.account-role')), 'Viewer');
  assert.equal(all(tab.main, 'li.release').length, 4);
  assert.deepEqual(writes(tab.main), []);
  assert.equal(all(tab.main, 'label.drop').length, 0);
  await tab.goto(`#/deployments/${OFFERED}`);
  assert.equal(textOf(one(tab.main, 'h1')), 'Deployment of 1.2.3+5 Waiting for boards');
  assert.deepEqual(writes(tab.main), []);
});

// Refreshing.

test('a page is read again while boards are busy, and not while the tab is hidden', async (t) => {
  const tab = await openTab(t);
  // A board is downloading: every 3 s.
  assert.match(textOf(one(tab.main, 'span.freshness-live')), /Live · every 3 s/);
  let mark = tab.requests.length;
  await tab.wait(2900);
  assert.deepEqual(tab.since(mark), []);
  await tab.wait(100);
  assert.deepEqual(tab.since(mark).sort(), [
    'GET /api/deployments', `GET /api/deployments/${OFFERED}`, `GET /api/deployments/${WITHDRAWN}`,
    'GET /api/devices',
  ], 'the releases and the log are not asked for every time');

  await tab.hide(true);
  mark = tab.requests.length;
  await tab.wait(60000);
  assert.deepEqual(tab.since(mark), [], 'nothing is asked for in the background');

  // Back in front, the page is brought up to date at once.
  await tab.hide(false);
  assert.equal(tab.since(mark).includes('GET /api/devices'), true);
  mark = tab.requests.length;
  await tab.wait(3000);
  assert.equal(tab.since(mark).includes('GET /api/devices'), true, 'and the schedule goes on');
});

test('a page whose boards are at rest is read every 30 s, and the list of releases not at all', async (t) => {
  const calm = { ...WORLD, devices: [WORLD.devices[2]], deployments: [WORLD.deployments[2]] };
  const tab = await openTab(t, { world: calm });
  assert.equal(all(tab.main, 'span.freshness-live').length, 0);
  let mark = tab.requests.length;
  await tab.wait(29000);
  assert.deepEqual(tab.since(mark), []);
  await tab.wait(1000);
  assert.equal(tab.since(mark).includes('GET /api/devices'), true);

  await tab.goto('#/firmware');
  mark = tab.requests.length;
  await tab.wait(120000);
  assert.deepEqual(tab.since(mark), []);
});

test('a page that could not be loaded says so, and is asked for again more slowly', async (t) => {
  let down = true;
  const tab = await openTab(t, {
    answer: (method, url) => (down && url === '/api/devices' ? gateway(503, 'Service Unavailable') : null),
  });
  // Three tries, with pauses between them that are on the tab's clock.
  await tab.wait(2000);
  await tab.wait(2000);
  const notice = one(tab.main, 'div.notice.is-bad');
  assert.match(textOf(notice), /^Could not load the boards\. Service Unavailable \(HTTP 503\)\./);
  assert.equal(sentTo(tab, '/api/devices').length, 3);

  // The page would be read every 3 s; after a failure not before 15 s.
  const mark = tab.requests.length;
  await tab.wait(10000);
  assert.equal(tab.since(mark).includes('GET /api/devices'), false);
  down = false;
  await tab.wait(5000);
  assert.equal(tab.since(mark).includes('GET /api/devices'), true);
  assert.equal(all(tab.main, 'div.notice.is-bad').length, 0);
  assert.equal(all(tab.main, 'li.board-line').length, 3);
});

// The session.

const leaving = (tab) => until(() => tab.navigations.length > 0, 'the way to the sign-in page');
const authorizeUrl = (tab) => new URL(tab.navigations.at(-1));
const pendingRoute = (tab) => JSON.parse(tab.storage.get('cranium.signin')).route;

test('the console leaves for the sign-in page a minute before the token ends', async (t) => {
  const tab = await openTab(t, { session: 100, hash: `#/devices/${WAITING}` });
  await tab.wait(35000);
  assert.deepEqual(tab.navigations, [], 'with 65 s left');
  await tab.wait(5000);
  await leaving(tab);
  assert.equal(authorizeUrl(tab).origin + authorizeUrl(tab).pathname, `${LOGIN}/oauth2/authorize`);
  assert.equal(authorizeUrl(tab).searchParams.get('code_challenge_method'), 'S256');
  // The page to come back to is remembered, and the old token is put away.
  assert.equal(pendingRoute(tab), `#/devices/${WAITING}`);
  assert.equal(tab.storage.has('cranium.session'), false);
  assert.equal(textOf(one(tab.main, 'h1')), 'Taking you to the sign-in page…');
  // It leaves once.
  await tab.wait(30000);
  assert.equal(tab.navigations.length, 1);
});

test('a hidden tab does not leave for the sign-in page; it does when it is looked at again', async (t) => {
  const tab = await openTab(t, { session: 100, hash: '#/firmware' });
  await tab.hide(true);
  await tab.wait(90000);
  await pause(20);
  assert.deepEqual(tab.navigations, []);
  await tab.hide(false);
  await leaving(tab);
  assert.equal(pendingRoute(tab), '#/firmware');
});

test('an open dialog is not interrupted by the end of the session', async (t) => {
  const tab = await openTab(t, { session: 100, hash: '#/firmware' });
  await tab.press(releaseRow(tab, '1.2.4+0'), 'button', 'Revoke');
  assert.equal(textOf(one(tab.dialog(), 'h2')), 'Revoke 1.2.4+0?');

  await tab.wait(60000);
  await pause(20);
  assert.deepEqual(tab.navigations, [], 'the dialog is left alone');
  assert.notEqual(tab.dialog(), null);

  // Closed, the console leaves at once.
  await tab.press(tab.dialog(), 'button', 'Keep the release');
  assert.equal(tab.dialog(), null);
  await leaving(tab);
  assert.equal(pendingRoute(tab), '#/firmware');
});

/** An MCUboot image as far as the browser looks at one: a header with a version. */
function imageFile(version = [2, 0, 1, 0], name = 'zephyr.signed.bin') {
  const bytes = new Uint8Array(1264);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x96f3b83d, true);
  view.setUint16(8, 512, true);
  view.setUint32(12, 600, true);
  view.setUint8(20, version[0]);
  view.setUint8(21, version[1]);
  view.setUint16(22, version[2], true);
  view.setUint32(24, version[3], true);
  return { name, size: bytes.length, arrayBuffer: async () => bytes.buffer };
}

async function chooseFile(tab, file = imageFile()) {
  const input = one(tab.main, 'input.drop-input');
  input.dispatchEvent({ type: 'change', target: { files: [file], value: file.name } });
  await until(() => all(tab.main, 'ul.checks').length > 0, 'the file to be read');
}

test('a chosen file is not thrown away by the end of the session', async (t) => {
  const tab = await openTab(t, { session: 100, hash: '#/firmware' });
  await chooseFile(tab);
  assert.equal(textOf(one(tab.main, 'p.upload-title')), 'zephyr.signed.bin');
  // With less than five minutes left the panel says what is about to happen.
  assert.match(textOf(one(tab.main, 'div.notice.is-warn')), /^Your session is about to end\. It ends in/);

  await tab.wait(60000);
  await pause(20);
  assert.deepEqual(tab.navigations, [], 'the file is still in hand');
  assert.equal(textOf(one(tab.main, 'p.upload-title')), 'zephyr.signed.bin');

  // The session is over by now; the panel says so and offers the way back in.
  await tab.wait(45000);
  assert.match(textOf(one(tab.main, 'div.notice.is-warn')), /^Your session has ended\./);
  await tab.press(tab.main, 'button', 'Sign in again');
  await leaving(tab);
  assert.equal(pendingRoute(tab), '#/firmware');
});

test('with the file put down again, the console leaves as usual', async (t) => {
  const tab = await openTab(t, { session: 100, hash: '#/firmware' });
  await chooseFile(tab);
  await tab.wait(60000);
  assert.deepEqual(tab.navigations, []);
  await tab.press(tab.main, 'button', 'Choose another file');
  assert.equal(all(tab.main, 'label.drop').length, 1);
  await tab.wait(5000);
  await leaving(tab);
});

/** A tab that comes back from the sign-in page with a code for the sign-in it started. */
function returning(t, route, answer = () => null) {
  const pending = { state: 'STATE-1', verifier: 'v'.repeat(43), route };
  return openTab(t, {
    session: null,
    hash: '',
    search: '?code=THE-CODE&state=STATE-1',
    stored: { 'cranium.signin': JSON.stringify(pending) },
    answer(method, url, body) {
      if (url === `${LOGIN}/oauth2/token`) return Response.json(TOKENS);
      if (url === `${LOGIN}/oauth2/revoke`) return new Response(null, { status: 200 });
      return answer(method, url, body);
    },
  });
}

test('back from the sign-in page, the console redeems the code and returns to where it was', async (t) => {
  const tab = await returning(t, `#/deployments/${OFFERED}`);
  await until(() => tab.document.title.startsWith('Deployment'), 'the page');

  assert.equal(tab.requests[0].url, `${LOGIN}/oauth2/token`, 'before anything else is asked for');
  assert.equal(tab.location.search, '', 'the code is out of the address bar');
  assert.equal(tab.location.hash, `#/deployments/${OFFERED}`);
  assert.equal(textOf(one(tab.main, 'h1')), 'Deployment of 1.2.3+5 Waiting for boards');
  // Neither the code nor the refresh token is kept; the refresh token is revoked.
  assert.deepEqual([...tab.storage.keys()], ['cranium.session']);
  assert.equal(sentTo(tab, `${LOGIN}/oauth2/revoke`).length, 1);
  assert.equal(sentTo(tab, '/api/me')[0].token, 'Bearer FRESH-TOKEN');
  assert.deepEqual(tab.navigations, []);
});

test('a reply from the sign-in page that this tab did not ask for is dropped unredeemed', async (t) => {
  const tab = await openTab(t, { session: null, hash: '', search: '?code=STOLEN&state=someone-elses' });
  assert.equal(textOf(one(tab.main, 'h1')), 'That sign-in did not start here');
  assert.deepEqual(tab.requests, []);
  assert.equal(tab.location.search, '');
  assert.deepEqual(controls(tab.main), ['Sign in']);
});

test('a token the API refuses leads back to sign-in, to the page the user was on', async (t) => {
  const tab = await openTab(t, {
    hash: '#/devices',
    answer: (method, url) => (url === '/api/devices' ? gateway(401, 'Unauthorized') : null),
  });
  await leaving(tab);
  assert.equal(pendingRoute(tab), '#/devices');
  assert.equal(sentTo(tab, '/api/devices').length, 1, 'a refused token is not tried again');
});

test('a token refused straight after signing in does not send the user round in circles', async (t) => {
  const tab = await returning(t, '#/overview',
    (method, url) => (url === '/api/me' ? gateway(401, 'Unauthorized') : null));
  await until(() => all(tab.main, 'h1').length > 0, 'a message');
  assert.equal(textOf(one(tab.main, 'h1')), 'The server did not accept this sign-in');
  assert.deepEqual(tab.navigations, []);
  assert.deepEqual(controls(tab.main), ['Sign out']);
});

// Revoking.

/** The world once revoking `version` has been carried out as far as `mark` says. */
function afterRevoking(version, mark) {
  const releases = WORLD.releases.map((item) =>
    (item.version === version ? { ...item, status: 'revoked', revoked: mark } : item));
  return { ...WORLD, releases };
}

async function openRevoke(tab, version, button = 'Revoke') {
  await tab.press(releaseRow(tab, version), 'button', button);
  return tab.dialog();
}

test('revoking sends the reason, says what it cancelled and shows the release as revoked', async (t) => {
  const done = revoked({ enforcedAt: ago(0) });
  const tab = await openTab(t, {
    hash: '#/firmware',
    answer(method) {
      if (method !== 'POST') return null;
      tab.becomes(afterRevoking('1.2.4+0', done));
      const marked = { ...release('1.2.4+0'), status: 'revoked', revoked: done };
      return Response.json({ release: marked, cancelled: [WITHDRAWN] });
    },
  });
  const dialog = await openRevoke(tab, '1.2.4+0');
  assert.equal(tab.document.activeElement.localName, 'textarea', 'typing starts in the reason');
  await tab.type(one(dialog, 'textarea'), `  ${REASON}\n`);
  const mark = tab.requests.length;
  await tab.submit();

  assert.deepEqual(tab.requests[mark], {
    method: 'POST', url: '/api/firmware/1.2.4+0/revoke', body: { reason: REASON }, token: 'Bearer TOKEN',
  });
  assert.equal(tab.dialog(), null);
  assert.deepEqual(tab.toasts(), ['Revoked 1.2.4+0. 1 unfinished deployment was cancelled.']);
  assert.equal(tab.since(mark).includes('GET /api/firmware'), true);
  assert.deepEqual(badges(releaseRow(tab, '1.2.4+0')), ['Revoked']);
  assert.deepEqual(writes(releaseRow(tab, '1.2.4+0')), []);
});

test('a release that somebody else revoked first is not reported as "not revoked"', async (t) => {
  const already = () => refusal(409, 'already_revoked', 'Release 1.2.4+0 is already revoked.');
  const tab = await openTab(t, {
    hash: '#/firmware',
    answer: (method) => (method === 'POST' ? already() : null),
  });
  const dialog = await openRevoke(tab, '1.2.4+0');
  await tab.type(one(dialog, 'textarea'), 'Second thoughts.');
  await tab.submit();
  assert.equal(tab.dialog(), null, 'the release is revoked: there is nothing left to ask');
  assert.deepEqual(tab.toasts(), ['1.2.4+0 was revoked already, and that revocation is in place.']);
  assert.equal(all(tab.document.body, 'div.notice.is-bad').length, 0);
});

test('a revocation that stopped half way is finished from the release, reason and all', async (t) => {
  const done = revoked({ enforcedAt: ago(0) });
  const tab = await openTab(t, {
    hash: '#/firmware',
    answer(method) {
      if (method !== 'POST') return null;
      tab.becomes(afterRevoking('2.0.0+0', done));
      return Response.json({ release: { ...WORLD.releases[0], revoked: done }, cancelled: [] });
    },
  });
  assert.deepEqual(badges(releaseRow(tab, '2.0.0+0')), ['Revoked', 'Revocation incomplete']);

  const dialog = await openRevoke(tab, '2.0.0+0', 'Finish revoking');
  assert.equal(textOf(one(dialog, 'h2')), 'Finish revoking 2.0.0+0?');
  assert.equal(all(dialog, 'textarea').length, 0);
  const mark = tab.requests.length;
  await tab.submit();

  assert.equal(tab.requests[mark].url, '/api/firmware/2.0.0+0/revoke');
  assert.deepEqual(tab.requests[mark].body, { reason: REASON });
  assert.equal(tab.dialog(), null);
  assert.deepEqual(tab.toasts(),
    ['The revocation of 2.0.0+0 is in place. No deployment of it was still open.']);
  assert.deepEqual(badges(releaseRow(tab, '2.0.0+0')), ['Revoked']);
  assert.deepEqual(writes(releaseRow(tab, '2.0.0+0')), []);
});

test('a revocation that fails half way leaves a dialog that offers to finish it', async (t) => {
  const reason = 'A fault in the field.';
  const posted = [];
  const tab = await openTab(t, {
    hash: '#/firmware',
    answer(method, url, body) {
      if (method !== 'POST') return null;
      posted.push(body);
      if (posted.length > 1) return refusal(409, 'already_revoked', 'Release 1.2.4+0 is already revoked.');
      // The mark is written; the step after it failed.
      tab.becomes(afterRevoking('1.2.4+0', { ...revoked({ enforcedAt: null }), reason }));
      return refusal(500, 'revoke_incomplete',
        'Release 1.2.4+0 is marked revoked, but its image could not be blocked. Revoke it again to finish.');
    },
  });
  const dialog = await openRevoke(tab, '1.2.4+0');
  await tab.type(one(dialog, 'textarea'), reason);
  await tab.submit();

  // Not closed: nothing is certain. The page behind it was read again and shows the mark.
  assert.notEqual(tab.dialog(), null);
  const said = textOf(one(tab.dialog(), 'span.notice-said'));
  assert.match(said, /^It is not certain whether this went through\. Release 1\.2\.4\+0 is marked revoked/);
  assert.match(said, /its image could not be blocked\. Revoke it again to finish\.$/);
  assert.deepEqual(badges(releaseRow(tab, '1.2.4+0')), ['Revoked', 'Revocation incomplete']);
  // The dialog now speaks of what is true: a revocation to finish, not one to begin.
  assert.equal(textOf(one(tab.dialog(), 'h2')), 'Finish revoking 1.2.4+0?');
  assert.equal(all(tab.dialog(), 'textarea').length, 0);

  await tab.submit();
  assert.deepEqual(posted, [{ reason }, { reason }], 'the second request carries the reason on record');
  assert.equal(tab.dialog(), null);
  assert.deepEqual(tab.toasts(),
    ['The revocation of 1.2.4+0 is in place: its image is refused and no deployment of it is open.']);
});

test('on a touch screen the revoke dialog does not open with the keyboard over what it says', async (t) => {
  const tab = await openTab(t, { hash: '#/firmware', touch: true });
  await openRevoke(tab, '1.2.4+0');
  assert.equal(textOf(tab.document.activeElement), 'Keep the release');
});

// Deploying.

test('a new deployment: the only free board is ticked, and a refusal updates the dialog', async (t) => {
  const rival = 'cranium-1-2-4-b0-20261010T120000Z-0d0d';
  const offline = execution(NEVER, 'waiting_for_device', { online: false });
  const tab = await openTab(t, {
    hash: '#/deployments',
    answer(method) {
      if (method !== 'POST') return null;
      // Somebody else was faster: the board has an update now.
      const taken = deployment(rival, { executions: [offline] });
      tab.becomes({ ...WORLD, deployments: [taken, ...WORLD.deployments] });
      return refusal(409, 'device_busy',
        `${NEVER} still has an update that is not finished. Wait for it or cancel it first.`,
        [{ thing: NEVER, deployment: rival }]);
    },
  });
  await tab.press(tab.main, 'button', 'New deployment');
  const dialog = tab.dialog();
  // Only releases that can be deployed are offered, the newest first and chosen.
  assert.deepEqual(all(dialog, 'label.choice').map((choice) => textOf(one(choice, 'span.choice-title'))),
    ['1.2.4+0', '1.2.3+5', '1.2.3+4']);
  assert.equal(all(dialog, 'input')[0].checked, true);
  await tab.press(dialog, 'button', 'Next');

  // Two boards have an unfinished update. The third is the only choice, and is made.
  const boards = () => all(tab.dialog(), 'label.choice').map((choice) => {
    const box = one(choice, 'input');
    return [textOf(one(one(choice, 'span.choice-title'), 'span.mono')), box.checked, box.disabled];
  });
  assert.deepEqual(boards(), [[WAITING, false, true], [INSTALLING, false, true], [NEVER, true, false]]);
  assert.equal(all(dialog, 'span.dialog-hint').length, 0);
  await tab.press(dialog, 'button', 'Next');
  assert.equal(textOf(one(dialog, 'button.is-primary')), 'Deploy to 1 board');

  const mark = tab.requests.length;
  await tab.press(dialog, 'button', 'Deploy to 1 board');
  assert.deepEqual(tab.requests[mark].body, { version: '1.2.4+0', things: [NEVER] });

  // Back at the boards, read again: the board cannot be chosen once more.
  assert.deepEqual(boards(), [[WAITING, false, true], [INSTALLING, false, true], [NEVER, false, true]]);
  assert.equal(textOf(one(dialog, 'span.dialog-hint')), 'Every board has an unfinished update.');
  assert.equal(one(dialog, 'button', 'Next').disabled, true);
  const notice = one(dialog, 'div.notice.is-bad');
  assert.match(textOf(notice), /^The deployment was not started\. cranium-00000000000000cc still has/);
  assert.equal(one(notice, 'a').getAttribute('href'), `#/deployments/${rival}`);
  // And the page behind the dialog shows the deployment that got there first.
  assert.equal(tab.since(mark).includes('GET /api/deployments'), true);
  assert.equal(all(tab.main, 'li.deployment-row').length, 4);
});

test('a deployment that starts takes the console to its page', async (t) => {
  const created = 'cranium-1-2-4-b0-20261010T120000Z-0e0e';
  const offline = execution(NEVER, 'waiting_for_device', { online: false });
  const started = deployment(created, { executions: [offline] });
  const tab = await openTab(t, {
    hash: '#/firmware',
    answer(method) {
      if (method !== 'POST') return null;
      tab.replies.set(`/api/deployments/${created}`, { deployment: started });
      return Response.json({ deployment: started }, { status: 201 });
    },
  });
  // From a release: the dialog starts at the boards.
  await tab.press(releaseRow(tab, '1.2.4+0'), 'button', 'Deploy');
  assert.equal(textOf(one(tab.dialog(), 'legend')), 'Which boards get 1.2.4+0?');
  await tab.press(tab.dialog(), 'button', 'Next');
  await tab.press(tab.dialog(), 'button', 'Deploy to 1 board');

  assert.equal(tab.dialog(), null);
  assert.equal(tab.location.hash, `#/deployments/${created}`);
  assert.equal(textOf(one(tab.main, 'h1')), 'Deployment of 1.2.4+0 Waiting for boards');
  assert.deepEqual(tab.toasts(), ['Deployment of 1.2.4+0 started.']);
});

// Cancelling.

test('cancelling a deployment that somebody else has cancelled: the dialog comes up to date', async (t) => {
  const cancelled = execution(WAITING, 'cancelled', { status: 'CANCELED' });
  const tab = await openTab(t, {
    hash: `#/deployments/${OFFERED}`,
    answer(method) {
      if (method !== 'POST') return null;
      const over = deployment(OFFERED, { status: 'CANCELED', executions: [cancelled] });
      tab.replies.set(`/api/deployments/${OFFERED}`, { deployment: over });
      return refusal(409, 'already_finished',
        'This deployment has already finished; there is nothing left to cancel.');
    },
  });
  await tab.press(tab.main, 'button', 'Cancel deployment');
  assert.match(textOf(tab.dialog()), /Right now 1 board is waiting and 0 boards have started\./);
  // The dialog opens on the safe choice.
  assert.equal(textOf(tab.document.activeElement), 'Keep the deployment');
  const mark = tab.requests.length;
  await tab.submit();

  assert.deepEqual(tab.requests[mark].body, { force: false });
  // A conflict: the page is read again, and the dialog counts from the new record.
  assert.equal(tab.since(mark).includes(`GET /api/deployments/${OFFERED}`), true);
  const dialog = tab.dialog();
  assert.match(textOf(dialog), /Nothing is left to cancel\./);
  assert.doesNotMatch(textOf(dialog), /Right now/);
  assert.equal(one(dialog, 'button.is-danger').disabled, true);
  assert.match(textOf(one(dialog, 'span.notice-said')), /^Not cancelled\. This deployment has already/);
  // Nothing more can be sent from here.
  const before = tab.requests.length;
  await tab.submit();
  assert.equal(tab.requests.length, before);
});

test('a deployment that was cancelled without force can still have its boards stopped', async (t) => {
  const stopped = deployment(WITHDRAWN, {
    status: 'CANCELED',
    createdAt: ago(1200),
    executions: [execution(INSTALLING, 'cancelled', { status: 'CANCELED', startedAt: ago(100) })],
  });
  const tab = await openTab(t, {
    hash: `#/deployments/${WITHDRAWN}`,
    answer(method) {
      if (method !== 'POST') return null;
      tab.replies.set(`/api/deployments/${WITHDRAWN}`, { deployment: stopped });
      return Response.json({ deployment: stopped });
    },
  });
  // The page is still live: the job is cancelled, the board is not.
  assert.match(textOf(one(tab.main, 'span.freshness-live')), /every 3 s/);
  await tab.press(tab.main, 'button', 'Cancel deployment');
  // Withdrawing the offer is done already; stopping the board is what is left, and chosen.
  assert.deepEqual(all(tab.dialog(), 'input').map((input) => [input.checked, input.disabled]),
    [[false, true], [true, false]]);
  const mark = tab.requests.length;
  await tab.submit();

  assert.deepEqual(tab.requests[mark].body, { force: true });
  assert.equal(tab.dialog(), null);
  assert.deepEqual(tab.toasts(), ['Cancelled. Boards that had started are being stopped.']);
  assert.deepEqual(writes(tab.main), []);
  assert.equal(all(tab.main, 'span.freshness-live').length, 0, 'nothing is left to wait for');
});

// Uploading.

test('an upload: read in the browser, verified by the server, and said once when registered', async (t) => {
  const registered = release('2.0.1+0', { uploadedAt: ago(0), notes: 'Fixes the pads.' });
  const wrongKey = {
    code: 'wrong_key',
    message: 'The image is signed with a different key than this project\'s',
    requestId: 'req-9',
  };
  const answers = [
    { status: 422, body: { error: wrongKey } },
    { status: 201, body: { release: registered } },
  ];
  const sent = [];
  const tab = await openTab(t, {
    hash: '#/firmware',
    upload(body) {
      sent.push(body);
      return answers.shift();
    },
  });
  const panel = () => one(tab.main, 'div.upload-state');

  await chooseFile(tab);
  const facts = Object.fromEntries(all(panel(), 'div.fact')
    .map((fact) => [textOf(one(fact, 'dt')), textOf(one(fact, 'dd'))]));
  assert.equal(facts.Version, '2.0.1+0');
  assert.equal(facts.Size, '1,264 bytes (1 KiB)');
  assert.match(facts['SHA-256'], /^[0-9a-f]{64}$/);
  assert.deepEqual(all(tab.main, 'li.check').map((check) => check.getAttribute('class')),
    ['check is-good', 'check is-good', 'check is-wait']);
  assert.deepEqual(sent, [], 'nothing is sent before it is asked for');

  await tab.type(one(tab.main, 'textarea'), 'Fixes the pads.\n');
  await tab.press(tab.main, 'button', 'Upload for verification');
  assert.equal(sent.length, 1);
  assert.deepEqual(Object.keys(sent[0]).sort(), ['data', 'filename', 'notes']);
  assert.equal(sent[0].filename, 'zephyr.signed.bin');
  assert.equal(sent[0].notes, 'Fixes the pads.');
  assert.equal(Buffer.from(sent[0].data, 'base64').length, 1264);

  // Refused for what the file is: the way on is another file.
  assert.equal(textOf(one(tab.main, 'span.notice-said')),
    'The server refused this image. The image is signed with a different key than this project\'s.');
  assert.deepEqual(controls(panel()), ['Choose another file']);

  await tab.press(tab.main, 'button', 'Choose another file');
  await chooseFile(tab);
  const mark = tab.requests.length;
  await tab.press(tab.main, 'button', 'Upload for verification');
  assert.equal(textOf(one(tab.main, 'p.upload-title')), 'Registered as 2.0.1+0');
  assert.deepEqual(tab.toasts(), [], 'the panel says it; a message on top would say it twice');
  assert.equal(tab.since(mark).includes('GET /api/firmware'), true);
  assert.deepEqual(controls(panel()), ['Deploy this release', 'Upload another']);
});

test('the image the browser reads is the one the API tests sign', async (t) => {
  const fixture = new URL('../../api/test/fixtures/valid-1.2.3+5.signed.bin', import.meta.url);
  if (!existsSync(fixture)) {
    t.skip('the firmware fixtures of the API are not present');
    return;
  }
  const bytes = new Uint8Array(readFileSync(fixture));
  const name = 'valid-1.2.3+5.signed.bin';
  const file = { name, size: bytes.length, arrayBuffer: async () => bytes.buffer };
  const tab = await openTab(t, { hash: '#/firmware', world: { ...WORLD, releases: [release('1.2.3+4')] } });
  await chooseFile(tab, file);
  const state = one(tab.main, 'div.upload-state');
  const fact = (label) => textOf(one(one(state, 'div.fact', label), 'dd'));
  assert.equal(fact('Version'), '1.2.3+5');
  // The name is recorded in the characters the API accepts.
  assert.equal(fact('Recorded as'), 'valid-1.2.3_5.signed.bin');
  assert.match(textOf(state), /Newer than every registered release \(highest so far: 1\.2\.3\+4\)\./);
});
