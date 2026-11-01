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
  CORE, HISTORY, NEIGHBOURS, SERIAL, VIEWS, all, click, controls, createDocument, one, scriptAddress, textOf,
} from './page.mjs';
import {
  INSTALLING, MANAGER, NEVER, NOW, OFFERED, REASON, WAITING, WITHDRAWN, WORLD, ago, deployment, device,
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

/** Give the tab's browser Web Serial, with no port to offer. */
function navigatorSerial() {
  globalThis.navigator.serial = {
    requestPort: async () => { throw Object.assign(new Error('none'), { name: 'NotFoundError' }); },
    addEventListener() {},
  };
}

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
 * @param {Function} [options.BroadcastChannel]  what the tab has for a line to other tabs; by
 *                                        default nothing, as in a browser without one
 */
async function openTab(t, options = {}) {
  const {
    world = WORLD, viewer = false, hash = '#/overview', search = '', session = 3600, stored = {},
    touch = false, answer = () => null, upload = () => ({ status: 500, body: {} }), BroadcastChannel,
  } = options;
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: NOW });

  const replies = repliesFor(world, { viewer });
  const requests = [];
  const navigations = [];
  const document = createDocument(['skip', 'main', 'nav', 'account', 'toasts', 'announcer']);
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
    BroadcastChannel,
  };
  const navigator = { clipboard: { writeText: async () => {} } };
  for (const [name, value] of Object.entries({ document, window, location, history, navigator })) {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }

  // A copy of app.js of its own: the script starts the console when it is loaded.
  copies += 1;
  await import(scriptAddress('app.js', {
    'core.js': CORE, 'views.js': VIEWS, 'serial.js': SERIAL, 'history.js': HISTORY,
  }, `tab ${copies}`));
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
// The buttons of a release are named with its version, as in "Revoke 1.2.3+5".
const writes = (root) => controls(root).filter((label) => WRITES.has(label.replace(/ \d\S*$/, '')));
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

test('an address that is not a page of the console becomes the overview, and says so', async (t) => {
  const tab = await openTab(t, { hash: '#/https://evil.example/' });
  assert.equal(tab.location.hash, '#/overview');
  assert.equal(textOf(one(tab.main, 'h1')), 'Overview');
  assert.deepEqual(tab.toasts(), ['That address is not a page of this console. Here is the overview.']);
});

test('the console opened without an address is not an address that went wrong', async (t) => {
  const tab = await openTab(t, { hash: '' });
  assert.equal(tab.location.hash, '#/overview');
  assert.deepEqual(tab.toasts(), []);
});

test('the title of the tab tells open tabs apart', async (t) => {
  const tab = await openTab(t, { hash: `#/devices/${WAITING}` });
  assert.equal(tab.document.title, 'cranium-0000… · Cranium');
  await tab.goto(`#/deployments/${OFFERED}`);
  assert.equal(tab.document.title, 'Deployment of 1.2.3+5 · Cranium');
  await tab.goto('#/firmware');
  assert.equal(tab.document.title, 'Firmware · Cranium');
});

test('a screen reader hears a board change state on every page but the one that says it itself', async (t) => {
  const waiting = { ...WORLD, devices: [WORLD.devices[0]] };
  const tab = await openTab(t, { world: waiting });
  const heard = () => textOf(tab.document.getElementById('announcer'));
  assert.equal(heard(), '', 'the first look at a board is not news');
  const moved = { ...WORLD.devices[0], ota: { state: 'downloading', job: OFFERED, progress: 10, last: 'none', error: '' } };
  tab.becomes({ ...WORLD, devices: [moved] });
  await tab.wait(3000);
  assert.equal(heard(), 'cranium-0000…: Downloading 1.2.3+5.');
});

test('a toast stays until it has been read, and can be closed', async (t) => {
  const tab = await openTab(t, { hash: '#/firmware' });
  const copy = async () => {
    click(all(tab.main, 'button').find((item) => item.getAttribute('aria-label') === 'Copy the key fingerprint'));
    await settle();
  };
  await copy();
  assert.deepEqual(tab.toasts(), ['Copied the key fingerprint.']);
  const [toast] = all(tab.document.getElementById('toasts'), 'div.toast');
  // Held while the pointer is on it.
  toast.dispatchEvent({ type: 'mouseenter' });
  await tab.wait(60000);
  assert.equal(tab.toasts().length, 1);
  toast.dispatchEvent({ type: 'mouseleave' });
  await tab.wait(5000);
  assert.deepEqual(tab.toasts(), []);

  await copy();
  click(one(tab.document.getElementById('toasts'), 'button'));
  assert.deepEqual(tab.toasts(), []);
});

test('closing a toast with the keyboard leaves the keyboard in the page', async (t) => {
  const tab = await openTab(t, { hash: '#/firmware' });
  click(all(tab.main, 'button').find((item) => item.getAttribute('aria-label') === 'Copy the key fingerprint'));
  await settle();
  const toast = one(tab.document.getElementById('toasts'), 'div.toast');
  const close = one(toast, 'button');
  const before = one(tab.main, 'h1');
  // Where the keyboard came from is where it goes back to.
  const from = all(tab.main, 'button').find((item) => item.getAttribute('aria-label') === 'Copy the key fingerprint');
  from.focus();
  close.focus();
  toast.dispatchEvent({ type: 'focusin', relatedTarget: from });
  click(close);
  assert.deepEqual(tab.toasts(), []);
  assert.equal(tab.document.activeElement, from);

  // If that is gone, the page's title has it.
  click(from);
  await settle();
  const second = one(tab.document.getElementById('toasts'), 'div.toast');
  one(second, 'button').focus();
  second.dispatchEvent({ type: 'focusin', relatedTarget: null });
  click(one(second, 'button'));
  assert.equal(tab.document.activeElement.id, 'page-title');
  assert.equal(before.id, 'page-title');
});

test('a toast that goes by itself does not move the keyboard', async (t) => {
  const tab = await openTab(t, { hash: '#/firmware' });
  const from = all(tab.main, 'button').find((item) => item.getAttribute('aria-label') === 'Copy the key fingerprint');
  from.focus();
  click(from);
  await settle();
  await tab.wait(5000);
  assert.deepEqual(tab.toasts(), []);
  assert.equal(tab.document.activeElement, from);
});

test('the second press of a double click does not close the dialog that the first one opened', async (t) => {
  const tab = await openTab(t, { hash: '#/firmware' });
  await tab.press(releaseRow(tab, '1.2.4+0'), 'button', 'Revoke');
  const dialog = tab.dialog();
  const pressBackdrop = () => {
    dialog.dispatchEvent({ type: 'mousedown', target: dialog });
    dialog.dispatchEvent({ type: 'click', target: dialog });
  };
  pressBackdrop();
  assert.notEqual(tab.dialog(), null);
  await tab.wait(400);
  pressBackdrop();
  assert.equal(tab.dialog(), null, 'after that, the backdrop closes it as usual');
});

test('when the control that had the focus goes away, the keyboard stays in the page', async (t) => {
  const finished = deployment(OFFERED, {
    status: 'COMPLETED',
    completedAt: ago(0),
    executions: [execution(WAITING, 'succeeded', { status: 'SUCCEEDED', startedAt: ago(100) })],
  });
  const tab = await openTab(t, { hash: `#/deployments/${OFFERED}` });
  one(tab.main, 'button', 'Cancel deployment').focus();
  tab.becomes({ ...WORLD, deployments: [finished] });
  await tab.wait(3000);
  assert.deepEqual(writes(tab.main), []);
  assert.equal(tab.document.activeElement.id, 'page-title');
});

test('a deployment that ends while its cancel button has the focus does not hand it to another button', async (t) => {
  const declined = deployment(OFFERED, {
    status: 'COMPLETED',
    completedAt: ago(0),
    executions: [execution(WAITING, 'declined', { status: 'REJECTED', reason: 'declined', startedAt: null })],
  });
  const tab = await openTab(t, { hash: `#/deployments/${OFFERED}` });
  one(tab.main, 'button', 'Cancel deployment').focus();
  tab.becomes({ ...WORLD, deployments: [declined] });
  await tab.wait(3000);
  assert.equal(one(tab.main, 'button', 'Offer again').getAttribute('class'), 'btn');
  assert.equal(tab.document.activeElement.id, 'page-title');
});

test('an account that was removed or disabled is told that, and not that it can be added to a group', async (t) => {
  const tab = await openTab(t, {
    answer: (method, url) => (url === '/api/me'
      ? refusal(403, 'account_inactive', 'Your account is disabled or not confirmed.')
      : null),
  });
  const words = textOf(tab.main);
  assert.match(words, /^.*Your account is not active/);
  assert.match(words, /disabled or removed/);
  assert.doesNotMatch(words, /no access yet|neither|add you/);
  assert.equal(all(tab.main, 'button').map(textOf).join(), 'Sign out');
});

test('an account that is in no group is told so', async (t) => {
  const tab = await openTab(t, {
    answer: (method, url) => (url === '/api/me' ? refusal(403, 'no_access', 'Not in a group.') : null),
  });
  assert.match(textOf(tab.main), /Your account has no access yet/);
});

test('the same message twice is one toast, that stays for longer', async (t) => {
  const tab = await openTab(t, { hash: '#/firmware' });
  const copy = async () => {
    click(all(tab.main, 'button').find((item) => item.getAttribute('aria-label') === 'Copy the key fingerprint'));
    await settle();
  };
  await copy();
  await tab.wait(4000);
  await copy();
  assert.deepEqual(tab.toasts(), ['Copied the key fingerprint.']);
  await tab.wait(4000);
  assert.deepEqual(tab.toasts(), ['Copied the key fingerprint.'], 'its time started again');
  await tab.wait(1000);
  assert.deepEqual(tab.toasts(), []);
  await copy();
  assert.deepEqual(tab.toasts(), ['Copied the key fingerprint.'], 'and once it is gone it can come again');
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

test('a page whose boards are at rest is read every 30 s, and so are lists that others can change', async (t) => {
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
  await tab.wait(29000);
  assert.deepEqual(tab.since(mark), []);
  await tab.wait(1000);
  assert.deepEqual(tab.since(mark), ['GET /api/firmware']);

  await tab.goto('#/activity');
  mark = tab.requests.length;
  await tab.wait(30000);
  assert.equal(tab.since(mark).includes('GET /api/audit?limit=50'), true);
});

test('a refresh by the clock waits while it would get in the way', async (t) => {
  const tab = await openTab(t, { hash: '#/firmware' });
  // With a dialog open.
  await tab.press(releaseRow(tab, '1.2.4+0'), 'button', 'Revoke');
  let mark = tab.requests.length;
  await tab.wait(60000);
  assert.deepEqual(tab.since(mark), []);
  await tab.press(tab.dialog(), 'button', 'Keep the release');
  mark = tab.requests.length;
  await tab.wait(30000);
  assert.deepEqual(tab.since(mark), ['GET /api/firmware']);

  // With a file in hand.
  await chooseFile(tab);
  mark = tab.requests.length;
  await tab.wait(60000);
  assert.deepEqual(tab.since(mark), []);
  await tab.press(tab.main, 'button', 'Choose another file');
  await tab.wait(30000);
  assert.deepEqual(tab.since(mark), ['GET /api/firmware']);
});

test('the log does not take away the pages that were loaded by hand', async (t) => {
  const entries = Array.from({ length: 51 }, () => WORLD.entries[0]);
  const tab = await openTab(t, {
    hash: '#/activity',
    answer: (method, url) => {
      if (url === '/api/audit?limit=50') return Response.json({ entries: entries.slice(0, 50), next: 'more' });
      if (url === '/api/audit?limit=50&before=more') return Response.json({ entries: entries.slice(50), next: null });
      return null;
    },
  });
  await tab.press(tab.main, 'button', 'Load more');
  assert.equal(all(tab.main, 'li.log-line').length, 51);
  const mark = tab.requests.length;
  await tab.wait(60000);
  assert.deepEqual(tab.since(mark), []);
  assert.equal(all(tab.main, 'li.log-line').length, 51);
});

test('a board that a forced cancellation found restarting is followed until it is back', async (t) => {
  const started = { status: 'CANCELED', startedAt: ago(100), lastUpdatedAt: ago(1) };
  const run = (reported) => deployment(OFFERED, {
    status: 'CANCELED',
    executions: [execution(WAITING, 'cancelled', { ...started, reported })],
  });
  const restarting = device(WAITING, {
    ota: { state: 'rebooting', job: OFFERED, progress: 0, last: 'none', error: '' },
  });
  const tab = await openTab(t, {
    hash: `#/deployments/${OFFERED}`,
    world: { ...WORLD, devices: [restarting], deployments: [run('1.2.3+4')] },
  });
  await tab.wait(0);
  assert.match(textOf(one(tab.main, 'p.execution-title')), /^Finishing despite the cancellation/);
  assert.match(textOf(one(tab.main, 'span.freshness-live')), /every 3 s/);
  assert.equal(all(tab.main, 'button').some((item) => textOf(item) === 'Offer again'), false);

  tab.becomes({
    ...WORLD,
    devices: [device(WAITING, {
      fw: { version: '1.2.3+5', confirmed: true },
      ota: { state: 'idle', job: null, progress: 0, last: 'succeeded', error: '' },
    })],
    deployments: [run('1.2.3+5')],
  });
  await tab.wait(3000);
  await tab.wait(0);
  assert.match(textOf(one(tab.main, 'p.execution-title')), /^Installed despite the cancellation/);
  assert.equal(all(tab.main, 'span.freshness-live').length, 0, 'and then it stops');
  const mark = tab.requests.length;
  await tab.wait(60000);
  assert.deepEqual(tab.since(mark), []);
});

test('a board\'s list of updates is not read again while the copy in hand is of what it reports now', async (t) => {
  const board = device(WAITING, {
    fw: { version: '1.2.3+5', confirmed: true },
    ota: { state: 'testing', job: OFFERED, progress: 0, last: 'none', error: '' },
  });
  const run = deployment(OFFERED, {
    status: 'CANCELED',
    executions: [execution(WAITING, 'cancelled', { status: 'CANCELED', startedAt: ago(100), lastUpdatedAt: ago(1), reported: '1.2.3+5' })],
  });
  const tab = await openTab(t, { hash: `#/deployments/${OFFERED}`, world: { ...WORLD, devices: [board], deployments: [run] } });
  await tab.wait(0);
  assert.match(textOf(one(tab.main, 'span.freshness-live')), /every 3 s/);
  const mark = tab.requests.length;
  await tab.wait(3000);
  await tab.wait(3000);
  const asked = tab.since(mark);
  assert.equal(asked.includes(`GET /api/deployments/${OFFERED}`), true, 'the page is being followed');
  assert.equal(asked.includes(`GET /api/devices/${WAITING}`), false);
});

test('a release revoked elsewhere stops being offered again on a page that is already open', async (t) => {
  const declined = deployment(OFFERED, {
    status: 'COMPLETED',
    completedAt: ago(10),
    executions: [execution(WAITING, 'declined', { status: 'REJECTED', reason: 'declined' })],
  });
  const world = { ...WORLD, deployments: [declined] };
  const tab = await openTab(t, { hash: `#/deployments/${OFFERED}`, world });
  assert.equal(all(tab.main, 'button').some((item) => textOf(item) === 'Offer again'), true);

  tab.becomes({
    ...world,
    releases: WORLD.releases.map((item) => (item.version === '1.2.3+5'
      ? release('1.2.3+5', { status: 'revoked', revoked: revoked({ enforcedAt: ago(1) }) })
      : item)),
  });
  await tab.wait(30000);
  assert.equal(all(tab.main, 'button').some((item) => textOf(item) === 'Offer again'), false);
  assert.match(textOf(tab.main), /was revoked/);
  // There is no more to wait for.
  const mark = tab.requests.length;
  await tab.wait(60000);
  assert.deepEqual(tab.since(mark), []);
});

test('a copy of a board\'s history from before it ran the version is read again, and a failed read is said and retried', async (t) => {
  const board = (version) => device(WAITING, { fw: { version, confirmed: true } });
  const cancelled = deployment(OFFERED, {
    status: 'CANCELED',
    executions: [execution(WAITING, 'cancelled', { status: 'CANCELED', startedAt: ago(100), reported: '1.2.3+4' })],
  });
  let down = false;
  const tab = await openTab(t, {
    hash: `#/devices/${WAITING}`,
    world: { ...WORLD, devices: [board('1.2.3+4')], deployments: [cancelled] },
    answer: (method, url) => (down && url === `/api/devices/${WAITING}` ? gateway(500, 'Internal Server Error') : null),
  });
  // The board moves on while this copy stays in memory. A later deployment did it.
  const later = deployment('cranium-1-2-3-b5-20261010T115800Z-0d0d', {
    status: 'COMPLETED',
    executions: [execution(WAITING, 'succeeded', { status: 'SUCCEEDED', startedAt: ago(50), ranAtEnd: '1.2.3+5' })],
  });
  const run = deployment(OFFERED, {
    status: 'CANCELED',
    executions: [execution(WAITING, 'cancelled', { status: 'CANCELED', startedAt: ago(100), reported: '1.2.3+5' })],
  });
  tab.becomes({ ...WORLD, devices: [board('1.2.3+5')], deployments: [run, later] });
  down = true;
  await tab.goto(`#/deployments/${OFFERED}`);
  await tab.wait(2000);
  await tab.wait(2000);
  // The read fails, and the copy is not taken for an answer.
  const words = () => textOf(tab.main);
  assert.doesNotMatch(words(), /Installed despite/);
  assert.match(words(), /Could not refresh the board’s list of updates/);
  assert.equal(all(tab.main, 'button').some((item) => textOf(item) === 'Offer again'), false);

  down = false;
  await tab.press(tab.main, 'button', 'Try again');
  assert.doesNotMatch(words(), /Installed despite|Could not refresh the board/);
  assert.match(words(), /Another deployment installed 1\.2\.3\+5\./);
});

test('while a board restarts after a forced cancel the overview follows it and does not say that nothing is going on', async (t) => {
  const run = deployment(OFFERED, {
    status: 'CANCELED',
    executions: [execution(WAITING, 'cancelled', { status: 'CANCELED', startedAt: ago(100), lastUpdatedAt: ago(1) })],
  });
  const restarting = device(WAITING, { ota: { state: 'rebooting', job: OFFERED, progress: 0, last: 'none', error: '' } });
  const tab = await openTab(t, { world: { ...WORLD, devices: [restarting], deployments: [run] } });
  assert.doesNotMatch(textOf(tab.main), /No update is in progress/);
  assert.match(textOf(one(tab.main, 'li.run')), /Finishing despite the cancellation/);
  assert.match(textOf(one(tab.main, 'span.freshness-live')), /every 3 s/);

  const done = device(WAITING, { fw: { version: '1.2.3+5', confirmed: true } });
  tab.becomes({ ...WORLD, devices: [done], deployments: [run] });
  await tab.wait(3000);
  assert.equal(all(tab.main, 'li.run').length, 0);
  assert.match(textOf(tab.main), /No update is in progress/);
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

test('a request made after the session has ended says so, and keeps the dialog with what was typed', async (t) => {
  const tab = await openTab(t, { session: 100, hash: '#/firmware' });
  const dialog = await openRevoke(tab, '1.2.4+0');
  await tab.type(one(dialog, 'textarea'), REASON);
  await tab.wait(101000);
  const mark = tab.requests.filter((request) => request.method === 'POST').length;
  await tab.submit();

  assert.equal(tab.requests.filter((request) => request.method === 'POST').length, mark, 'nothing was sent');
  assert.deepEqual(tab.navigations, [], 'and the console has not left');
  assert.equal(tab.dialog(), dialog);
  assert.equal(textOf(one(dialog, 'span.notice-said')), 'Not revoked. Your session has ended. Sign in again to continue.');
  assert.equal(one(dialog, 'textarea').value, REASON);
  assert.equal(textOf(one(tab.account, 'span.account-session')), 'Session ended');

  await tab.press(dialog, 'button', 'Sign in again');
  await leaving(tab);
  assert.equal(pendingRoute(tab), '#/firmware');
  assert.equal(tab.dialog(), null);
});

test('a refresh that finds the session over does not take away what is in hand', async (t) => {
  const tab = await openTab(t, { session: 100, hash: `#/deployments/${OFFERED}` });
  await tab.press(tab.main, 'button', 'Cancel deployment');
  await tab.wait(110000);
  assert.deepEqual(tab.navigations, []);
  assert.notEqual(tab.dialog(), null);
});

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

  // The session is over by now; the panel says so and offers the way back in. Sending
  // the file is not on offer any more, and the masthead says the same.
  await tab.wait(45000);
  assert.match(textOf(one(tab.main, 'div.notice.is-warn')), /^Your session has ended\./);
  assert.equal(all(tab.main, 'button').some((item) => textOf(item) === 'Upload for verification'), false);
  assert.equal(textOf(one(tab.account, 'span.account-session')), 'Session ended');
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

test('a token the API refuses counts as over, whatever time it had left', async (t) => {
  const refused = (method, url) => (url.startsWith('/api/firmware/') ? refusal(401, 'unauthorized', 'Nope.') : null);
  const tab = await openTab(t, { hash: '#/firmware', answer: refused });
  assert.equal(textOf(one(tab.account, 'span.account-session')), 'Session ends in 1 h');
  await tab.press(releaseRow(tab, '1.2.4+0'), 'button', 'Revoke');
  await tab.type(one(tab.dialog(), 'textarea'), 'A reason.');
  await tab.submit();
  // The dialog stays, with what was typed, and says so; and so does the masthead.
  assert.match(textOf(tab.dialog()), /Your session has ended/);
  assert.equal(textOf(one(tab.account, 'span.account-session')), 'Session ended');
  assert.equal(tab.storage.has('cranium.session'), false, 'a token that is refused is not kept');
  // Once the work is put down, the console leaves for the sign-in page as it does at the end of a session.
  assert.deepEqual(tab.navigations, []);
  await tab.press(tab.dialog(), 'button', 'Keep the release');
  await tab.wait(5000);
  assert.equal(tab.navigations.length, 1);
  assert.match(tab.navigations[0], /\/oauth2\/authorize\?/);
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
  assert.equal(tab.since(mark).includes('GET /api/devices'), true, 'to name the boards that run it');
  assert.deepEqual(badges(releaseRow(tab, '1.2.4+0')), ['Revoked']);
  assert.deepEqual(writes(releaseRow(tab, '1.2.4+0')), []);
});

test('a revocation is confirmed at once; which boards still run the release follows', async (t) => {
  const runsIt = device(WAITING, { fw: { version: '1.2.4+0', confirmed: true } });
  let answerBoards = null;
  let holding = false;
  const world = { ...WORLD, devices: [runsIt], deployments: [] };
  const replies = repliesFor(world);
  const tab = await openTab(t, {
    world,
    hash: '#/firmware',
    answer(method, url) {
      if (method === 'POST' && url === '/api/firmware/1.2.4+0/revoke') {
        return Response.json({ release: release('1.2.4+0', { status: 'revoked', revoked: revoked({ enforcedAt: ago(0) }) }), cancelled: [] });
      }
      if (url === '/api/devices' && holding) {
        return new Promise((resolve) => { answerBoards = () => resolve(Response.json(replies.get(url))); });
      }
      return null;
    },
  });
  holding = true;
  await tab.press(releaseRow(tab, '1.2.4+0'), 'button', 'Revoke');
  await tab.type(one(tab.dialog(), 'textarea'), 'A reason.');
  await tab.submit();
  assert.equal(tab.dialog(), null);
  assert.deepEqual(tab.toasts(), ['Revoked 1.2.4+0. No deployment of it was still open.']);
  answerBoards();
  await settle();
  assert.deepEqual(tab.toasts(), [
    'Revoked 1.2.4+0. No deployment of it was still open.',
    `${WAITING} still runs it; to replace it there, upload a newer version and deploy that.`,
  ]);
});

const REVOKED_AWAY = { online: false, lastSeen: ago(3600) };
const onRevoked = (thing, changes) => device(thing, { fw: { version: '1.2.4+0', confirmed: true }, ...changes });
for (const [who, devices, said] of [
  ['one board offline', [onRevoked(WAITING, REVOKED_AWAY)],
    `${WAITING} last reported running it; to replace it there, upload a newer version and deploy that.`],
  ['one board online and one offline', [onRevoked(WAITING), onRevoked(INSTALLING, REVOKED_AWAY)],
    '1 board still runs it and 1 board last reported running it; to replace it there, upload a newer version and deploy that.'],
  ['an offline board on something else', [device(WAITING, REVOKED_AWAY)], 'Revoked 1.2.4+0. No deployment of it was still open.'],
]) {
  test(`after a revocation, an offline board is told by what it last reported: ${who}`, async (t) => {
    const tab = await openTab(t, {
      world: { ...WORLD, devices, deployments: [] },
      hash: '#/firmware',
      answer(method, url) {
        if (method === 'POST' && url === '/api/firmware/1.2.4+0/revoke') {
          return Response.json({ release: release('1.2.4+0', { status: 'revoked', revoked: revoked({ enforcedAt: ago(0) }) }), cancelled: [] });
        }
        return null;
      },
    });
    await tab.press(releaseRow(tab, '1.2.4+0'), 'button', 'Revoke');
    await tab.type(one(tab.dialog(), 'textarea'), 'A reason.');
    await tab.submit();
    await settle();
    assert.equal(tab.toasts().at(-1), said);
  });
}

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

test('pressing Deploy on a release that was revoked since says so, and suggests no other', async (t) => {
  const tab = await openTab(t, { hash: '#/firmware' });
  // Somebody else revokes it after this page has read the list.
  const mark = revoked({ enforcedAt: ago(0) });
  tab.becomes({
    ...WORLD,
    releases: WORLD.releases.map((item) =>
      (item.version === '1.2.4+0' ? { ...item, status: 'revoked', revoked: mark } : item)),
  });
  await tab.press(releaseRow(tab, '1.2.4+0'), 'button', 'Deploy');
  const dialog = tab.dialog();
  assert.match(textOf(one(dialog, 'div.notice.is-warn')), /^1\.2\.4\+0 has been revoked/);
  assert.equal(all(dialog, 'input').every((input) => !input.checked), true);
  assert.equal(one(dialog, 'button', 'Next').disabled, true);
  // The page behind the dialog has learned it too.
  assert.deepEqual(badges(releaseRow(tab, '1.2.4+0')), ['Revoked']);

  // Choosing another takes the note away.
  click(all(dialog, 'input')[0]);
  await settle();
  assert.equal(all(tab.dialog(), 'div.notice.is-warn').length, 0);
  assert.equal(one(tab.dialog(), 'button', 'Next').disabled, false);
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
  // What was refused has nothing to add to that, and cannot contradict it.
  assert.equal(all(dialog, 'span.notice-said').length, 0);
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
  await tab.press(tab.main, 'button', 'Stop boards that have started');
  // Withdrawing the offer is done already; stopping the board is what is left, and chosen.
  assert.deepEqual(all(tab.dialog(), 'input').map((input) => [input.checked, input.disabled]),
    [[false, true], [true, false]]);
  const mark = tab.requests.length;
  await tab.submit();

  assert.deepEqual(tab.requests[mark].body, { force: true });
  assert.equal(tab.dialog(), null);
  assert.deepEqual(tab.toasts(), ['Stop requested. Boards that had started have been asked to stop.']);
  assert.deepEqual(writes(tab.main), []);
  assert.equal(all(tab.main, 'span.freshness-live').length, 0, 'nothing is left to wait for');
});

// Uploading.

test('a board that runs what was cancelled: its own list of updates says who installed it', async (t) => {
  const later = 'cranium-1-2-3-b5-20261010T115800Z-0d0d';
  const cancelled = deployment(OFFERED, {
    status: 'CANCELED',
    executions: [execution(WAITING, 'cancelled', { status: 'CANCELED', startedAt: ago(300), reported: '1.2.3+5' })],
  });
  const installer = deployment(later, {
    status: 'COMPLETED',
    executions: [execution(WAITING, 'succeeded', { status: 'SUCCEEDED', startedAt: ago(100), ranAtEnd: '1.2.3+5' })],
  });
  const board = device(WAITING, { fw: { version: '1.2.3+5', confirmed: true } });
  const tab = await openTab(t, {
    world: { ...WORLD, devices: [board], deployments: [installer, cancelled] },
    hash: `#/deployments/${OFFERED}`,
  });
  assert.equal(sentTo(tab, `/api/devices/${WAITING}`).length, 1);
  assert.equal(textOf(one(tab.main, 'p.execution-title')), 'Cancelled');
  assert.equal(one(tab.main, 'a', 'Open the deployment that installed it').getAttribute('href'), `#/deployments/${later}`);
  // It does not offer again what the board runs already.
  assert.equal(all(tab.main, 'button').some((item) => textOf(item).includes('Offer again')), false);
});

test('a deployment page reads no list of updates that it has no use for', async (t) => {
  const tab = await openTab(t, { hash: `#/deployments/${OFFERED}` });
  assert.equal(sentTo(tab, `/api/devices/${WAITING}`).length, 0);
});

test('signing out in one tab ends the others, whatever they hold', async (t) => {
  // Two tabs of the same browser, as far as the line between them goes.
  const lines = new Set();
  class Line {
    constructor(name) {
      this.name = name;
      this.listeners = [];
      lines.add(this);
    }

    addEventListener(type, listener) {
      if (type === 'message') this.listeners.push(listener);
    }

    postMessage(data) {
      for (const line of lines) {
        if (line !== this && line.name === this.name) for (const listener of line.listeners) listener({ data });
      }
    }
  }
  const tab = await openTab(t, { hash: '#/firmware', BroadcastChannel: Line });
  const [here] = lines;
  const other = new Line(here.name);
  const signedOut = () => textOf(one(tab.main, 'h1'));

  // Something else on the line changes nothing.
  for (const listener of here.listeners) listener({ data: 'hello' });
  assert.equal(signedOut(), 'Firmware');

  // A dialog is open, and a file is in hand.
  await chooseFile(tab);
  await tab.press(releaseRow(tab, '1.2.4+0'), 'button', 'Revoke');
  assert.notEqual(tab.dialog(), null);

  other.postMessage('signed-out');
  await settle();
  assert.equal(tab.dialog(), null);
  assert.equal(signedOut(), 'You are signed out');
  assert.deepEqual(controls(tab.main), ['Sign in']);
  assert.deepEqual([...tab.storage.keys()], ['cranium.signedout'], 'no token left here');
  assert.deepEqual(tab.navigations, [], 'not sent anywhere: the other tab has ended the login session');
  assert.equal(all(tab.main, 'div.upload-main').length, 0);

  // And nothing is asked for any more.
  const mark = tab.requests.length;
  await tab.wait(60000);
  assert.equal(tab.since(mark).length, 0);
});

test('signing out says so on the line between tabs, and nothing else', async (t) => {
  const posted = [];
  class Line {
    constructor(name) {
      this.name = name;
    }

    addEventListener() {}

    postMessage(data) {
      posted.push([this.name, data]);
    }
  }
  const tab = await openTab(t, { BroadcastChannel: Line });
  await tab.press(tab.account, 'button', 'Sign out');
  assert.deepEqual(posted, [['cranium.session', 'signed-out']]);
  assert.match(tab.navigations[0], /\/logout\?/);
});

test('a browser that cannot open the line between tabs still signs out', async (t) => {
  class Refusing {
    constructor() {
      throw new Error('Not allowed.');
    }
  }
  const tab = await openTab(t, { BroadcastChannel: Refusing });
  assert.equal(textOf(one(tab.main, 'h1')), 'Overview');
  await tab.press(tab.account, 'button', 'Sign out');
  assert.match(tab.navigations[0], /\/logout\?/);
});

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

// The Developer section.

test('the serial console opens by its address and asks the API for nothing', async (t) => {
  const tab = await openTab(t, { hash: '#/overview' });
  navigatorSerial();
  const mark = tab.requests.length;
  await tab.goto('#/serial');
  assert.equal(textOf(one(tab.main, 'h1')), 'Serial console');
  assert.equal(tab.document.title, 'Serial console · Cranium');
  assert.deepEqual(tab.since(mark), []);
  await tab.wait(120000);
  assert.deepEqual(tab.since(mark), [], 'and it does not poll');
});

test('a viewer who opens the serial console gets an explanation and no controls', async (t) => {
  const tab = await openTab(t, { viewer: true, hash: '#/serial' });
  await tab.wait(0);
  assert.match(textOf(tab.main), /for release managers/);
  assert.deepEqual(all(tab.main, 'input'), []);
  assert.equal(all(tab.main, 'button').length, 0);
});

test('a browser without Web Serial is told so and gets no controls', async (t) => {
  const tab = await openTab(t, { hash: '#/serial' });
  await tab.wait(0);
  assert.match(textOf(tab.main), /Chrome and Edge/);
  assert.match(textOf(tab.main), /115200 baud/);
  assert.deepEqual(all(tab.main, 'input'), []);
  assert.equal(all(tab.main, 'button').length, 0);
});

test('the history page says plainly that a checkout that was never deployed has none', async (t) => {
  const tab = await openTab(t, { hash: '#/history' });
  await tab.wait(0);
  assert.equal(textOf(one(tab.main, 'h1')), 'History');
  assert.match(textOf(tab.main), /no history in this copy/);
  assert.equal(tab.requests.some(({ url }) => url === `${NEIGHBOURS}history.json`), true);
});

test('the history page shows the file beside its script, and fetches it once', async (t) => {
  const file = {
    deployment: { commit: 'a'.repeat(40), tree: 'clean', deployedAt: new Date(NOW - 60000).toISOString() },
    commits: [{ short: 'aaaaaaa', hash: 'a'.repeat(40), date: new Date(NOW - 3600000).toISOString(), subject: 'Add a page', tags: ['website'] }],
  };
  const tab = await openTab(t, {
    hash: '#/history',
    answer: (method, url) => (url === `${NEIGHBOURS}history.json` ? Response.json(file) : null),
  });
  await tab.wait(0);
  assert.match(textOf(tab.main), /Add a page/);
  await tab.goto('#/overview');
  const mark = tab.requests.length;
  await tab.goto('#/history');
  assert.equal(tab.since(mark).some((request) => request.includes('history.json')), false);
  assert.match(textOf(tab.main), /Add a page/);
});
