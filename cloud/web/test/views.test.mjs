/**
 * Tests for what the console draws. views.js is the very file the browser loads. It
 * writes into a stand-in for the document (page.mjs), and the tests look at the tree
 * it built: which controls a viewer gets, what an empty console says, how a board's
 * state reads.
 *
 * The state the views draw from is made the way the page makes it: replies in the
 * shape of the API (world.mjs), read by the console's own client.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CORE, VIEWS, all, click, controls, createDocument, descendants, one, textOf, withText,
} from './page.mjs';
import {
  EMPTY, INSTALLING, LOOKALIKE, MANAGER, NAMELESS, NEVER, NOW, OFFERED, REASON, WAITING, WITHDRAWN,
  WORLD, ago, deployment, device, entry, execution, release, repliesFor, revoked,
} from './world.mjs';

const core = await import(CORE);
const views = await import(VIEWS);
globalThis.document = createDocument();

const loaded = (value) => ({ value, error: null, loadedAt: NOW - 20000, loading: false });

/** The state of the console for a world, read from API replies by the console's own client. */
async function consoleState(world, { viewer = false, ...changes } = {}) {
  const replies = repliesFor(world, { viewer });
  const api = core.createApi({
    auth: { accessToken: () => 'TOKEN' },
    crypto: globalThis.crypto,
    clock: core.createClock(() => NOW),
    onUnauthorized: () => assert.fail('the token was refused'),
    fetch: async (path) => {
      assert.equal(replies.has(path), true, `no reply for ${path}`);
      return Response.json(replies.get(path));
    },
  });

  const audit = await api.audit();
  const state = {
    gate: null,
    me: await api.me(),
    route: { view: 'overview' },
    now: NOW,
    interval: 0,
    sessionLeft: 3000,
    devices: loaded(await api.devices()),
    firmware: loaded(await api.firmware()),
    deployments: loaded(await api.deployments()),
    recent: loaded(audit),
    audit: { ...loaded(audit), loadingMore: false, moreError: null },
    deviceDetails: new Map(),
    deploymentDetails: new Map(),
    upload: { stage: 'idle', over: false },
  };
  for (const { id } of world.deployments) {
    state.deploymentDetails.set(id, loaded(await api.deployment(id)));
  }
  for (const { thing } of world.devices) {
    state.deviceDetails.set(thing, loaded(await api.device(thing)));
  }
  return { ...state, ...changes };
}

/**
 * Actions that only note that they were asked for, and with what. A handler is also
 * handed the event that set it off; that is left out.
 */
function recorder() {
  const calls = [];
  const actions = new Proxy({}, {
    get: (_target, name) => (...args) => {
      calls.push([name, ...args.filter((value) => !(value?.type && value.currentTarget))]);
    },
  });
  return { actions, calls };
}

function draw(node) {
  const box = document.createElement('div');
  views.render(box, node);
  return box;
}

/** One page of the console for a state, drawn. `route` says which board or deployment. */
function page(view, state, route = {}, actions = recorder().actions) {
  return draw(view({ state: { ...state, route: { ...state.route, ...route } }, actions }));
}

/** Every page of the console for a state, drawn: name -> its tree. */
function everyPage(state, actions) {
  return new Map([
    ['overview', page(views.overviewView, state, {}, actions)],
    ['devices', page(views.devicesView, state, {}, actions)],
    ['device', page(views.deviceView, state, { thing: WAITING }, actions)],
    ['firmware', page(views.firmwareView, state, {}, actions)],
    ['deployments', page(views.deploymentsView, state, {}, actions)],
    ['deployment', page(views.deploymentView, state, { id: OFFERED }, actions)],
    ['withdrawn deployment', page(views.deploymentView, state, { id: WITHDRAWN }, actions)],
    ['activity', page(views.activityView, state, {}, actions)],
  ]);
}

const error = (status, code, message) => new core.ApiError(status, code, message, { requestId: 'req-9' });
const escaped = (text) => text.replace(/[.+?()]/g, '\\$&');

// Drawing.

test('a string is written as text, whatever it contains', () => {
  const hostile = '<img src=x onerror=alert(1)><script>alert(2)</script>';
  const box = draw(views.h('p', { title: hostile }, hostile, views.h('span', null, hostile)));
  assert.deepEqual(descendants(box).map((el) => el.localName), ['p', 'span']);
  assert.equal(box.textContent, hostile + hostile);
  assert.equal(one(box, 'p').getAttribute('title'), hostile);
});

test('inline styles, inline handlers and markup in an attribute are refused outright', () => {
  const refused = [{ style: 'color: red' }, { onclick: 'alert(1)' }, { onload: 'x' }, { srcdoc: '<p>' }];
  for (const props of refused) {
    assert.throws(() => draw(views.h('div', props)), /is not allowed/, Object.keys(props)[0]);
  }
  assert.throws(() => draw(views.h('div', { vars: { color: 'red' } })), /Only custom properties/);
  const box = draw(views.h('div', { vars: { '--progress': '40%' } }));
  assert.deepEqual([...box.firstChild.custom], [['--progress', '40%']]);
  assert.equal(box.firstChild.hasAttribute('style'), false);
});

test('a page that is drawn again keeps its elements and changes only what differs', () => {
  const box = document.createElement('div');
  const list = (items) => views.h('ul', null, items.map(([key, text]) => views.h('li', { key }, text)));
  views.render(box, list([['a', 'one'], ['b', 'two'], ['c', 'three']]));
  const [first, second, third] = all(box, 'li');

  views.render(box, list([['c', 'three'], ['a', 'ONE'], ['d', 'four']]));
  const after = all(box, 'li');
  assert.deepEqual(after.map(textOf), ['three', 'ONE', 'four']);
  assert.equal(after[0], third, 'moved, not made again');
  assert.equal(after[1], first, 'changed in place');
  assert.equal(second.parentNode, null, 'taken out');
});

test('a handler is attached once and replaced in place', () => {
  const seen = [];
  const box = document.createElement('div');
  views.render(box, views.h('button', { onClick: () => seen.push('first') }, 'Go'));
  const button = one(box, 'button');
  views.render(box, views.h('button', { onClick: () => seen.push('second') }, 'Go'));
  assert.equal(one(box, 'button'), button);
  click(button);
  assert.deepEqual(seen, ['second']);
  assert.equal(button.listeners.get('click').size, 1);
});

test('every icon that a description names is drawn', () => {
  const shapes = (name) =>
    JSON.stringify(views.icon(name).children.map((shape) => [shape.tag, shape.props]));
  const fallback = shapes('no such icon');
  const named = new Set();

  const phases = [
    'waiting_for_device', 'waiting_for_button', 'downloading', 'verifying', 'rebooting', 'testing',
    'succeeded', 'failed', 'rolled_back', 'declined', 'refused', 'cancelled', 'timed_out', 'removed',
    'a_new_phase',
  ];
  for (const phase of phases) {
    for (const online of [true, false]) {
      named.add(core.describeExecution(execution(WAITING, phase, { online })).icon);
    }
  }
  const statuses = [
    'QUEUED', 'IN_PROGRESS', 'SUCCEEDED', 'FAILED', 'TIMED_OUT', 'REJECTED', 'REMOVED', 'CANCELED', 'NEW',
  ];
  for (const status of statuses) named.add(core.describeStatus(status).icon);
  const states = ['idle', 'awaiting_user', 'downloading', 'verifying', 'rebooting', 'testing', 'new'];
  const endings = ['none', 'succeeded', 'failed', 'rolled_back', 'declined', 'refused', 'cancelled'];
  for (const state of states) {
    for (const last of endings) {
      const ota = { state, job: null, progress: 0, last, error: '' };
      named.add(core.describeUpdate(device(WAITING, { ota })).icon);
    }
  }
  const counts = {
    queued: 1, inProgress: 1, succeeded: 1, failed: 1, rejected: 1, canceled: 1, timedOut: 1, removed: 1,
  };
  for (const status of ['IN_PROGRESS', 'COMPLETED', 'CANCELED', 'SCHEDULED', 'DELETION_IN_PROGRESS', 'NEW']) {
    for (const some of [counts, { ...counts, inProgress: 0 }, { ...counts, succeeded: 0 }]) {
      named.add(core.describeDeployment({ status, things: [WAITING], counts: some }).icon);
    }
  }
  for (const counted of core.describeCounts(counts)) named.add(counted.icon);
  const actions = ['firmware.upload', 'firmware.revoke', 'deployment.create', 'deployment.cancel', 'new'];
  for (const action of actions) {
    for (const outcome of ['ok', 'rejected', 'denied', 'error', 'new']) {
      const line = core.describeAudit({ action, target: 'x', outcome, detail: [] });
      named.add(line.icon);
      if (line.outcome) named.add(line.outcome.icon);
    }
  }

  assert.equal(named.size > 15, true);
  for (const name of named) {
    assert.equal(name === 'minus' || shapes(name) !== fallback, true, `the icon "${name}" is not drawn`);
  }
});

// Who may do what.

const WRITE_CONTROLS = new Set([
  'Deploy', 'Revoke', 'Finish revoking', 'Apply the revocation again', 'New deployment',
  'Upload firmware first', 'Cancel deployment', 'Upload for verification', 'Try again',
  'Choose another file', 'Deploy this release', 'Upload another',
]);
const writes = (root) => controls(root).filter((label) => WRITE_CONTROLS.has(label));

test('a viewer sees every page and no control that changes anything', async () => {
  const pages = everyPage(await consoleState(WORLD, { viewer: true }));
  for (const [name, drawn] of pages) {
    assert.deepEqual(writes(drawn), [], name);
    assert.equal(all(drawn, 'input').length, 0, `${name}: nothing to fill in`);
    assert.equal(all(drawn, 'label.drop').length, 0, `${name}: nowhere to drop a file`);
  }
  // Reading is not held back: the release list, the boards and the log are all there.
  assert.equal(all(pages.get('firmware'), 'li.release').length, 4);
  assert.equal(all(pages.get('devices'), 'article.device').length, 3);
  assert.equal(all(pages.get('activity'), 'li.log-line').length, 4);
  assert.match(textOf(pages.get('firmware')), /The server verifies every upload/);
});

test('a release manager gets the controls, each on the page it belongs to', async () => {
  const { actions, calls } = recorder();
  const pages = everyPage(await consoleState(WORLD), actions);

  assert.deepEqual(writes(pages.get('firmware')),
    ['Finish revoking', 'Deploy', 'Revoke', 'Deploy', 'Revoke', 'Deploy', 'Revoke']);
  assert.equal(all(pages.get('firmware'), 'label.drop').length, 1);
  assert.deepEqual(writes(pages.get('deployments')), ['New deployment']);
  assert.deepEqual(writes(pages.get('deployment')), ['Cancel deployment']);
  // Cancelled, but its board is still installing.
  assert.deepEqual(writes(pages.get('withdrawn deployment')), ['Cancel deployment']);
  for (const name of ['overview', 'devices', 'device', 'activity']) {
    assert.deepEqual(writes(pages.get(name)), [], name);
  }

  click(one(pages.get('deployments'), 'button', 'New deployment'));
  click(withText(pages.get('firmware'), 'button', 'Revoke')[0]);
  click(withText(pages.get('firmware'), 'button', 'Deploy')[0]);
  assert.deepEqual(calls.map(([name, argument]) => [name, argument?.version ?? argument]),
    [['openDeploy', null], ['openRevoke', '1.2.4+0'], ['openDeploy', '1.2.4+0']]);
});

// Nothing there yet.

const titles = (root) => all(root, 'section.card').map((card) => textOf(one(card, 'h2')));

test('an empty console says what to do next and shows no rows', async () => {
  for (const viewer of [false, true]) {
    const pages = everyPage(await consoleState(EMPTY, { viewer }));

    // The overview is the way in, not five cards that each say "nothing yet".
    const overview = pages.get('overview');
    assert.deepEqual(titles(overview), ['Getting started']);
    assert.deepEqual(all(overview, 'li.guide-step').map((step) => textOf(one(step, 'p.guide-title'))),
      ['Register a board', 'Upload a signed image', 'Deploy it']);
    assert.equal(textOf(overview).split('python3 tools/provision_device.py').length - 1, 1);

    const devices = pages.get('devices');
    assert.match(textOf(devices), /No boards are registered yet\. Provision one with python3 tools\//);
    assert.equal(textOf(one(devices, 'code.code')), 'python3 tools/provision_device.py');

    assert.match(textOf(pages.get('firmware')), /No firmware has been uploaded yet\./);
    assert.match(textOf(pages.get('deployments')), /No deployments yet\./);
    assert.match(textOf(pages.get('activity')), /Nothing has been recorded yet\./);
    for (const [name, drawn] of pages) {
      assert.equal(all(drawn, 'li.row').length + all(drawn, 'li.log-line').length, 0, name);
    }
  }
});

test('the first steps are ticked off as they are done, and the next one stands out', async () => {
  const guide = async (world) =>
    all(page(views.overviewView, await consoleState({ ...EMPTY, ...world })), 'li.guide-step');
  const marks = (steps) => steps.map((step) => step.getAttribute('class').replace('guide-step', '').trim());

  assert.deepEqual(marks(await guide({})), ['is-next', '', '']);
  const withBoard = await guide({ devices: [device(WAITING)] });
  assert.deepEqual(marks(withBoard), ['is-done', 'is-next', '']);
  // A step that is done keeps its title; its instructions are gone.
  assert.equal(all(withBoard[0], 'p.guide-text').length, 0);
  assert.equal(textOf(withBoard[0]), 'Register a board (done)');
  assert.equal(withBoard[1].getAttribute('aria-current'), 'step');
  assert.match(textOf(withBoard[1]), /Drop the build’s zephyr\.signed\.bin on the Firmware page/);
  // Out of order, a release without a board: the first open step is the next one, and only that.
  assert.deepEqual(marks(await guide({ releases: [release('1.2.3+4')] })), ['is-next', 'is-done', '']);
  // With everything in place the guide is gone.
  assert.deepEqual(await guide(WORLD), []);
});

test('activity that was recorded in an otherwise empty console is not hidden', async () => {
  const refusedUpload = WORLD.entries[3];
  const overview = page(views.overviewView, await consoleState({ ...EMPTY, entries: [refusedUpload] }));
  assert.deepEqual(titles(overview), ['Getting started', 'Recent activity']);
  assert.match(textOf(overview), /tried to upload zephyr\.signed\.bin/);
});

test('"no update is in progress" is ticked only once there has been an update', async () => {
  const calm = async (world) => {
    const title = one(page(views.overviewView, await consoleState(world)), 'p.calm-title');
    return [title.getAttribute('class'), one(title, 'svg').children.length];
  };
  const tick = views.icon('check-circle').children.length;
  const dash = views.icon('minus-circle').children.length;
  const oneBoard = { ...EMPTY, devices: [device(WAITING)] };
  assert.deepEqual(await calm(oneBoard), ['calm-title is-idle', dash]);
  const finished = WORLD.deployments[2];
  assert.deepEqual(await calm({ ...oneBoard, deployments: [finished] }), ['calm-title is-good', tick]);
});

// The overview.

test('a cancelled deployment whose board is still installing counts as in progress', async () => {
  const overview = page(views.overviewView, await consoleState(WORLD));
  const runs = all(overview, 'li.run');
  assert.deepEqual(runs.map((run) => textOf(one(run, 'a.run-version'))), ['1.2.3+5', '1.2.4+0']);
  assert.match(textOf(runs[1]), /This deployment was cancelled\. A board that had already started/);
  assert.match(textOf(runs[1]), /Downloading 40%/);
  assert.doesNotMatch(textOf(runs[0]), /was cancelled/);
  assert.doesNotMatch(textOf(overview), /No update is in progress/);

  // Once that board has stopped, the deployment is the last one that ended.
  const stopped = deployment(WITHDRAWN, {
    status: 'CANCELED',
    createdAt: ago(1200),
    executions: [execution(INSTALLING, 'cancelled', { status: 'CANCELED' })],
  });
  const later = await consoleState({ ...WORLD, deployments: [stopped, WORLD.deployments[2]] });
  assert.match(textOf(page(views.overviewView, later)),
    /No update is in progress\. Last deployment: 1\.2\.4\+0, cancelled, started 20 min ago/);
});

test('the newest release is the newest one that can be deployed, on both cards that say so', async () => {
  const overview = page(views.overviewView, await consoleState(WORLD));
  const card = all(overview, 'section.card').find((item) => textOf(one(item, 'h2')) === 'Newest release');
  assert.equal(textOf(one(card, 'p.release-figure')), '1.2.4+0 Active');
  assert.match(textOf(card), /A newer upload, 2\.0\.0\+0, was revoked 33 min ago\./);

  // The fleet card tags the same release, were a board to run it.
  const runsIt = device(WAITING, { fw: { version: '1.2.4+0', confirmed: true } });
  const fleet = page(views.overviewView, await consoleState({ ...WORLD, devices: [runsIt] }));
  assert.match(textOf(one(fleet, 'span.tag', 'Newest release').parentNode), /^1\.2\.4\+0/);

  // With nothing left to deploy, the newest upload is shown for what it is.
  const lone = page(views.overviewView, await consoleState({ ...WORLD, releases: [WORLD.releases[0]] }));
  assert.match(textOf(one(lone, 'p.release-figure')), /^2\.0\.0\+0 Revoked/);
  assert.match(textOf(lone), /No release can be deployed\./);
});

test('a board that waits for its button is the one thing on the page that asks for somebody', async () => {
  const state = await consoleState(WORLD);
  const card = one(page(views.deploymentView, state, { id: OFFERED }), 'article.execution');
  assert.equal(card.getAttribute('class'), 'card execution is-act');
  assert.equal(textOf(one(card, 'p.execution-title')), 'Press Button 1 on the board');
  assert.equal(one(card, 'p.execution-title').getAttribute('role'), 'status');

  // The step it is at does not read as done.
  const steps = all(card, 'li.step');
  assert.deepEqual(steps.map((step) => textOf(one(step, 'span.step-label'))),
    ['Offered', 'Waiting for Button 1', 'Downloading', 'Verified', 'Restarting', 'Testing', 'Confirmed']);
  assert.equal(steps[1].getAttribute('aria-current'), 'step');
  assert.equal(textOf(steps[1]), 'Waiting for Button 1: in progress');
  assert.equal(textOf(steps[0]), 'Offered: done');

  // The same on the overview and on the board's own card, and nowhere else.
  assert.equal(textOf(one(page(views.overviewView, state), 'span.status.is-act')),
    'Press Button 1 on the board');
  assert.equal(all(page(views.devicesView, state), 'span.status.is-act').length, 1);
  assert.equal(all(page(views.deploymentView, state, { id: WITHDRAWN }), 'article.is-act').length, 0);
});

test('the steps of a board are kept in place while what they are called changes', async () => {
  const box = document.createElement('div');
  const at = async (item) => {
    const world = { ...WORLD, deployments: [deployment(OFFERED, { executions: [item] })] };
    const state = { ...await consoleState(world), route: { view: 'deployment', id: OFFERED } };
    views.render(box, views.deploymentView({ state, actions: recorder().actions }));
    return all(box, 'li.step');
  };
  const started = { status: 'IN_PROGRESS', startedAt: ago(30) };

  const waiting = await at(execution(WAITING, 'waiting_for_button'));
  const downloading = await at(execution(WAITING, 'downloading', { ...started, progress: 40 }));
  assert.deepEqual(downloading, waiting, 'the same seven elements');
  assert.equal(textOf(downloading[1]), 'Approved on the board: done');
  assert.equal(textOf(downloading[2]), 'Downloading 40%: in progress');
  // The rail to the next step carries the progress of the download.
  assert.equal(downloading[2].getAttribute('class'), 'step is-current has-progress');
  assert.equal(downloading[2].custom.get('--progress'), '40%');

  const verifying = await at(execution(WAITING, 'verifying', started));
  assert.equal(verifying[2].custom.has('--progress'), false);
  assert.equal(textOf(verifying[3]), 'Verifying: in progress');
  const declined = await at(execution(WAITING, 'declined', { status: 'REJECTED', reason: 'declined' }));
  assert.equal(textOf(declined[1]), 'Not approved: stopped here');
  const cancelled = await at(execution(WAITING, 'cancelled', { status: 'CANCELED' }));
  assert.equal(textOf(cancelled[0]), 'Offered: done');
  assert.equal(textOf(cancelled[1]), 'Approved on the board: not reached');
});

// People.

test('wherever a person is named, the account id is within reach', async () => {
  const state = await consoleState(WORLD);
  const pages = everyPage(state);
  const account = (person) => `Account ${person.sub}`;

  // The log: two accounts that show the same address are told apart on the line itself.
  const lines = all(pages.get('activity'), 'li.log-line');
  const refs = lines.map((line) => one(line, 'span.log-ref', 'Account'));
  assert.deepEqual(refs.map(textOf),
    ['Account 0b1c2d3e…', 'Account f9e8d7c6…', 'Account 0b1c2d3e…', 'Account 7a7a7a7a…']);
  assert.deepEqual(refs.map((ref) => ref.getAttribute('title')),
    [account(MANAGER), account(LOOKALIKE), account(MANAGER), account(NAMELESS)]);
  assert.equal(textOf(one(lines[1], 'span.log-actor')), textOf(one(lines[2], 'span.log-actor')));
  // An entry without an address is named by its account, not as "someone".
  assert.equal(textOf(one(lines[3], 'span.log-actor')), 'account 7a7a7a7a…');
  for (const drawn of pages.values()) {
    for (const name of [...all(drawn, 'span.who'), ...all(drawn, 'span.log-actor')]) {
      assert.notEqual(textOf(name), 'someone');
    }
  }

  // The short log on the overview keeps both in the tooltip.
  const [short] = all(pages.get('overview'), 'span.log-actor');
  assert.equal(textOf(short), 'manager');
  assert.equal(short.getAttribute('title'), `${MANAGER.email} · ${account(MANAGER)}`);

  // Every other "by ..." carries the account as its tooltip.
  const named = (drawn) => all(drawn, 'span.who').map((who) => [textOf(who), who.getAttribute('title')]);
  assert.deepEqual(named(pages.get('deployment')), [[MANAGER.email, account(MANAGER)]]);
  const firmware = named(pages.get('firmware'));
  assert.equal(firmware.length, 5, 'four uploads and a revocation');
  assert.equal(firmware.every(([, title]) => /^Account [0-9a-f-]{36}$/.test(title)), true);
  assert.deepEqual(firmware.at(-1), ['account 7a7a7a7a…', account(NAMELESS)]);
  // And written out where a tooltip cannot be read: in the details of a release.
  assert.match(textOf(one(pages.get('firmware'), 'li.release', '2.0.0+0')),
    new RegExp(`by ${escaped(MANAGER.email)} · account ${MANAGER.sub}`));
  // The masthead says which account is signed in.
  const signedIn = one(page(views.accountView, state), 'span.account-email');
  assert.equal(signedIn.getAttribute('title'), `${MANAGER.email} · ${account(MANAGER)}`);
});

// The activity log.

test('the log says what happened in the words of the console', async () => {
  const lines = all(page(views.activityView, await consoleState(WORLD)), 'li.log-line');
  assert.deepEqual(lines.map((line) => textOf(one(line, 'p.log-what'))), [
    `${MANAGER.email} revoked firmware 2.0.0+0`,
    `${MANAGER.email} cancelled the deployment of 1.2.4+0`,
    `${MANAGER.email} started a deployment of 1.2.3+5`,
    'account 7a7a7a7a… tried to upload zephyr.signed.bin Refused',
  ]);
  const detail = (line) => one(line, 'p.log-detail').children.map(textOf);
  assert.deepEqual(detail(lines[0]),
    [`Reason: ${REASON}`, 'Deployments cancelled: 1', 'Account 0b1c2d3e…', 'Request req-1']);
  assert.deepEqual(detail(lines[1]),
    ['Forced: no', `Deployment: ${WITHDRAWN}`, 'Account f9e8d7c6…', 'Request req-1']);
  assert.deepEqual(detail(lines[2]),
    ['Boards: 1', `Deployment: ${OFFERED}`, 'Account 0b1c2d3e…', 'Request req-1']);
  assert.deepEqual(detail(lines[3]), [
    'Refused with wrong_key', 'File: zephyr.signed.bin', 'Size: 1,264 bytes', `SHA-256: ${'c'.repeat(64)}`,
    'Account 7a7a7a7a…', 'Request req-1',
  ]);
  // A reason is prose; an identifier is set as one.
  assert.equal(all(one(lines[0], 'span', 'Reason:'), 'span.mono').length, 0);
  assert.equal(textOf(one(one(lines[3], 'span', 'Refused with'), 'span.mono')), 'wrong_key');
  // The deployment links to its page under the name of its version.
  assert.equal(one(lines[2], 'a.log-target').getAttribute('href'), `#/deployments/${OFFERED}`);
});

test('a reason as long as the dialog accepts is shown whole', async () => {
  const long = `${'A reason that goes on. '.repeat(8)}${'x'.repeat(16)}`;
  assert.equal(long.length, 200);
  const state = await consoleState({
    ...WORLD,
    entries: [entry('firmware.revoke', '2.0.0+0', { detail: { reason: long } })],
    releases: [release('2.0.0+0', { status: 'revoked', revoked: { ...revoked(), reason: long } })],
  });
  assert.equal(textOf(page(views.activityView, state)).includes(long), true);
  assert.equal(textOf(page(views.firmwareView, state)).includes(long), true);
});

// Problems.

test('a failed refresh is announced once: the time that changes is outside the announcement', async () => {
  const state = await consoleState(WORLD);
  state.devices.error = error(503, 'gateway', 'Service Unavailable (HTTP 503).');
  const { actions, calls } = recorder();
  const notice = one(page(views.devicesView, state, {}, actions), 'div.notice.is-bad');
  assert.equal(notice.hasAttribute('role'), false);
  const said = one(notice, 'span.notice-said');
  assert.equal(said.getAttribute('role'), 'alert');
  assert.equal(textOf(said), 'Could not refresh the boards. Service Unavailable (HTTP 503).');
  assert.equal(all(said, 'time').length, 0);
  assert.match(textOf(notice), /Showing what was loaded 20 s ago\./);
  assert.match(textOf(notice), /Request req-9/);
  assert.equal(all(said, 'span.notice-ref').length, 0, 'the request id changes with every retry');
  click(one(notice, 'button', 'Try again'));
  assert.deepEqual(calls, [['refresh']]);
});

test('a detail page names what it is about in its heading', async () => {
  const pages = everyPage(await consoleState(WORLD));
  assert.equal(textOf(one(pages.get('deployment'), 'h1')), 'Deployment of 1.2.3+5 Waiting for boards');
  assert.equal(textOf(one(pages.get('device'), 'h1')), `Board ${WAITING}`);
  assert.equal(textOf(one(pages.get('overview'), 'h1')), 'Overview');
  for (const drawn of pages.values()) assert.equal(all(drawn, 'h1').length, 1);
});

test('how fresh a page is: the rate is a part of its own, so that a narrow row can do without', async () => {
  const state = await consoleState(WORLD, { interval: 10000 });
  const live = one(page(views.devicesView, state), 'span.freshness-live');
  assert.equal(textOf(live), 'Live · every 10 s');
  assert.equal(textOf(one(live, 'span.freshness-rate')), '· every 10 s');
  assert.match(live.getAttribute('title'), /every 10 s/);
});

// Firmware.

const HEADER = { ok: true, headerSize: 512, payloadSize: 600, version: '2.0.1+0' };
const chosen = (changes = {}) => ({
  stage: 'ready', name: 'zephyr.signed.bin', recordedAs: 'zephyr.signed.bin', size: 1264,
  digest: 'd'.repeat(64), header: HEADER, notes: '', ...changes,
});

/** The upload panel of the Firmware page for a chosen file, and what pressing in it asked for. */
async function uploadPanel(upload, changes = {}) {
  const { actions, calls } = recorder();
  const drawn = page(views.firmwareView, await consoleState(WORLD, { upload, ...changes }), {}, actions);
  return { panel: one(drawn, 'div.upload-main'), calls };
}

const refusedWith = (failure) => uploadPanel(chosen({ stage: 'refused', error: failure }));

test('a chosen file is not shown as checked before the server has checked it', async () => {
  const { panel } = await uploadPanel(chosen());
  const checks = all(panel, 'li.check');
  assert.deepEqual(checks.map((check) => check.getAttribute('class')),
    ['check is-good', 'check is-good', 'check is-wait']);
  assert.equal(textOf(checks[2]),
    'Signature: not checked yet. The server checks it against the project key when you upload.');
  assert.deepEqual(controls(panel), ['Choose another file', 'Upload for verification']);

  // A file that cannot be sent says nothing about a check that will not happen.
  const notAnImage = { ok: false, message: 'This is not an MCUboot image.' };
  const blocked = await uploadPanel(chosen({ header: notAnImage }));
  assert.deepEqual(all(blocked.panel, 'li.check').map(textOf), ['This is not an MCUboot image.']);
  assert.deepEqual(controls(blocked.panel), ['Choose another file']);
});

test('a refused image leads to another file; only a request that failed is offered again', async () => {
  const wrongKey = error(422, 'wrong_key', 'The image is signed with a different key than this project\'s');
  const refused = await refusedWith(wrongKey);
  // The server's sentence is finished.
  assert.equal(textOf(one(refused.panel, 'span.notice-said')),
    'The server refused this image. The image is signed with a different key than this project\'s.');
  // One way on, and it is not the same bytes again.
  assert.deepEqual(controls(refused.panel), ['Choose another file']);
  assert.equal(one(refused.panel, 'button', 'Choose another file').getAttribute('class'), 'btn is-primary');
  assert.equal(all(refused.panel, 'textarea').length, 0);
  assert.equal(withText(refused.panel, 'li.check', 'Signature').length, 0);
  click(one(refused.panel, 'button', 'Choose another file'));
  assert.deepEqual(refused.calls, [['resetUpload']]);

  const final = [
    error(409, 'version_exists', 'Release 2.0.1+0 already exists.'),
    error(413, 'gateway', 'Request Entity Too Large (HTTP 413).'),
  ];
  for (const failure of final) {
    assert.deepEqual(controls((await refusedWith(failure)).panel), ['Choose another file'], failure.code);
  }

  // A refusal of the account is not put down to the image, and is not offered again either.
  const noRole = await refusedWith(
    error(403, 'release_manager_required', 'You are no longer a release manager.'));
  assert.equal(textOf(one(noRole.panel, 'span.notice-said')),
    'The image was not stored. You are no longer a release manager.');
  assert.deepEqual(controls(noRole.panel), ['Choose another file']);

  const uncertain = /^It is not certain whether this went through\./;
  const notStored = /^The image was not stored\./;
  const passing = [
    [error(503, 'gateway', 'Service Unavailable (HTTP 503).'), uncertain],
    [error(0, 'network', 'The server could not be reached. Check the connection.'), uncertain],
    [error(429, 'gateway', 'Too Many Requests (HTTP 429).'), notStored],
    [error(409, 'upload_conflict', 'Another upload was being registered at the same moment.'), notStored],
  ];
  for (const [failure, lead] of passing) {
    const again = await refusedWith(failure);
    assert.match(textOf(one(again.panel, 'span.notice-said')), lead, failure.code);
    assert.deepEqual(controls(again.panel), ['Choose another file', 'Try again'], failure.code);
    assert.equal(all(again.panel, 'textarea').length, 1);
    click(one(again.panel, 'button', 'Try again'));
    assert.deepEqual(again.calls, [['startUpload']]);
  }
});

test('an upload on its way is announced once, not at every percent', async () => {
  const { panel } = await uploadPanel(chosen({ stage: 'sending', sent: 0.42 }));
  const status = one(panel, 'div.upload-progress');
  assert.equal(status.getAttribute('role'), 'status');
  assert.equal(textOf(status), 'Uploading… 42%');
  assert.equal(one(status, 'span', '42%').getAttribute('aria-hidden'), 'true');
  assert.equal(one(status, 'div.meter').getAttribute('aria-valuenow'), '42');
  assert.deepEqual(controls(panel), [], 'nothing to press while it is on its way');
});

test('with a file in hand the end of the session is said in time', async () => {
  const quiet = await uploadPanel(chosen(), { sessionLeft: 300 });
  assert.equal(all(quiet.panel, 'div.notice').length, 0);

  const soon = await uploadPanel(chosen(), { sessionLeft: 240 });
  const notice = one(soon.panel, 'div.notice.is-warn');
  // The part that is announced does not change with the clock.
  assert.equal(textOf(one(notice, 'span.notice-said')), 'Your session is about to end.');
  assert.equal(one(notice, 'span.notice-said').getAttribute('role'), 'status');
  assert.match(textOf(notice), /It ends in 4 min\. Upload now, or sign in again first; the file has to be/);
  click(one(notice, 'button', 'Sign in again'));
  assert.deepEqual(soon.calls, [['signInAgain']]);

  const lastMinute = await uploadPanel(chosen(), { sessionLeft: 45 });
  assert.match(textOf(lastMinute.panel), /It ends in less than a minute\./);
  const over = await uploadPanel(chosen(), { sessionLeft: -5 });
  assert.match(textOf(over.panel), /Your session has ended\. Sign in again to upload/);
  // Nothing to warn about while nothing is waiting to be sent.
  const sending = await uploadPanel(chosen({ stage: 'sending', sent: 0.5 }), { sessionLeft: 100 });
  assert.equal(all(sending.panel, 'div.notice').length, 0);
});

test('a revocation that is not finished says so, and can be finished from the release', async () => {
  const row = async (mark, viewer = false) => {
    const releases = [release('2.0.0+0', { status: 'revoked', revoked: mark })];
    const state = await consoleState({ ...WORLD, releases }, { viewer });
    const { actions, calls } = recorder();
    return { row: one(page(views.firmwareView, state, {}, actions), 'li.release'), calls, state };
  };
  const badges = (item) => all(one(item, 'div.release-title'), 'span.badge').map(textOf);

  const complete = await row(revoked({ enforcedAt: ago(1975) }));
  assert.deepEqual(badges(complete.row), ['Revoked']);
  assert.deepEqual(writes(complete.row), []);
  assert.match(textOf(complete.row), /Enforced .* The image is refused and every open deployment of it/);

  const open = await row(revoked({ enforcedAt: null }));
  assert.deepEqual(badges(open.row), ['Revoked', 'Revocation incomplete']);
  assert.match(textOf(open.row), /The server has not recorded that the image is refused/);
  assert.match(textOf(open.row), /Finish revoking to make sure\./);
  assert.deepEqual(writes(open.row), ['Finish revoking']);
  click(one(open.row, 'button', 'Finish revoking'));
  assert.deepEqual(open.calls.map(([name, item]) => [name, item.version]), [['openRevoke', '2.0.0+0']]);

  // A viewer is told as well, and told who can act.
  const seen = await row(revoked({ enforcedAt: null }), true);
  assert.deepEqual(badges(seen.row), ['Revoked', 'Revocation incomplete']);
  assert.match(textOf(seen.row), /A release manager can finish revoking\./);
  assert.deepEqual(writes(seen.row), []);

  // A server that keeps no record: nothing is claimed, and the way to make sure stays open.
  const unknown = await row(revoked());
  assert.deepEqual(badges(unknown.row), ['Revoked']);
  assert.doesNotMatch(textOf(unknown.row), /has not recorded/);
  assert.deepEqual(writes(unknown.row), ['Apply the revocation again']);
  assert.deepEqual(writes((await row(revoked(), true)).row), []);

  // The overview says it on top, to everyone, and only for a revocation known to be open.
  const warning = (state) => all(page(views.overviewView, state), 'div.notice.is-warn');
  assert.equal(warning(complete.state).length, 0);
  assert.equal(warning(unknown.state).length, 0);
  const [notice] = warning(open.state);
  assert.match(textOf(notice), /^Revocation incomplete\. 2\.0\.0\+0 is marked revoked, but the server has/);
  assert.match(textOf(notice), /Finish revoking on the Firmware page\. Firmware$/);
  assert.equal(one(notice, 'a.btn').getAttribute('href'), '#/firmware');
  assert.match(textOf(warning(seen.state)[0]), /A release manager can finish revoking on the Firmware/);
});

// Deployments.

test('with nothing to deploy, the way on is the Firmware page and not an empty dialog', async () => {
  const onlyRevoked = [release('2.0.0+0', { status: 'revoked', revoked: revoked({ enforcedAt: ago(5) }) })];
  for (const releases of [[], onlyRevoked]) {
    const drawn = page(views.deploymentsView, await consoleState({ ...EMPTY, releases }));
    assert.deepEqual(controls(drawn), ['Refresh now', 'Upload firmware first']);
    const link = one(drawn, 'a.btn', 'Upload firmware first');
    assert.equal(link.getAttribute('href'), '#/firmware');
    assert.equal(link.getAttribute('class'), 'btn is-primary');
    // The words that name the page lead to it.
    assert.equal(one(one(drawn, 'p.empty-text'), 'a', 'Firmware page').getAttribute('href'), '#/firmware');
  }
  // Until the releases have arrived the button is not taken away.
  const notLoaded = { value: null, error: null, loadedAt: 0, loading: true };
  const waiting = await consoleState(EMPTY, { firmware: notLoaded });
  assert.deepEqual(controls(page(views.deploymentsView, waiting)), ['Refresh now', 'New deployment']);
  const ready = await consoleState({ ...EMPTY, releases: [release('1.2.3+4')] });
  assert.deepEqual(controls(page(views.deploymentsView, ready)), ['Refresh now', 'New deployment']);
});

test('the list of deployments separates its facts so that no dot is left at the end of a line', async () => {
  const drawn = page(views.deploymentsView, await consoleState(WORLD));
  const note = one(one(drawn, 'li.deployment-row', '1.2.3+5'), 'p.row-note');
  assert.equal(note.getAttribute('class'), 'row-note dotted');
  assert.deepEqual(note.children.map(textOf), [`Started 6 min ago by ${MANAGER.email}`, '1 board']);
  assert.doesNotMatch(note.textContent, /·/);
});

// Dialogs. A dialog draws from a model that app.js keeps; here the model is the test's.

const DIALOG = { state: { now: NOW } };

/** A release and a board as the console's client hands them to a dialog. */
const clientRelease = (version) => ({ ...release(version), uploadedBy: { ...MANAGER } });
const board = (thing, changes = {}) => ({ ...device(thing), ...changes });

function wizard(changes = {}) {
  const calls = [];
  const note = (name) => () => {
    calls.push(name);
  };
  const model = {
    step: 1,
    version: '1.2.3+5',
    things: new Set(),
    note: '',
    busy: new Map(),
    releases: [clientRelease('1.2.3+5'), clientRelease('1.2.3+4')],
    devices: [],
    loading: false,
    loadError: null,
    sending: false,
    error: null,
    close: note('close'),
    choose: note('choose'),
    next: note('next'),
    back: note('back'),
    setNote: note('setNote'),
    toggle: note('toggle'),
    toggleAll: note('toggleAll'),
    reload: note('reload'),
    submit: note('submit'),
    ...changes,
  };
  return { model, calls, dialog: draw(views.deployDialog(model, DIALOG)) };
}

test('choosing boards: what speaks for or against a board is said before it is ticked', () => {
  const older = board(WAITING);
  const same = board(INSTALLING, { fw: { version: '1.2.3+5', confirmed: true } });
  const away = board(NEVER, { online: false, lastSeen: ago(1800) });
  const { dialog } = wizard({ devices: [older, same, away] });
  const choices = all(dialog, 'label.choice');
  assert.equal(choices.length, 3);
  assert.equal(all(choices[0], 'span.choice-warning').length + all(choices[0], 'span.choice-hint').length, 0);
  assert.match(textOf(choices[1]), /already runs this version or a newer one, so it will refuse the offer\./);
  assert.match(textOf(choices[2]), /Offline: it will see the offer when it reconnects\./);
  assert.equal(all(dialog, 'input').every((input) => input.checked === false), true);

  // Why "Next" cannot be used yet is said next to it.
  const next = one(dialog, 'button', 'Next');
  assert.equal(next.disabled, true);
  assert.equal(textOf(one(dialog, 'span.dialog-hint')), 'Choose at least one board.');
  assert.equal(next.getAttribute('aria-describedby'), one(dialog, 'span.dialog-hint').getAttribute('id'));

  const ticked = wizard({ devices: [older, same, away], things: new Set([WAITING]) }).dialog;
  assert.equal(one(ticked, 'button', 'Next').disabled, false);
  assert.equal(all(ticked, 'span.dialog-hint').length, 0);
  assert.equal(one(ticked, 'button', 'Next').hasAttribute('aria-describedby'), false);

  const busy = new Map([[WAITING, { deployment: OFFERED, version: '1.2.3+5' }]]);
  const none = wizard({ devices: [older], busy }).dialog;
  assert.equal(textOf(one(none, 'span.dialog-hint')), 'Every board has an unfinished update.');
  assert.equal(one(none, 'input').disabled, true);
});

test('a refused deployment names the board once and leads to what holds it', () => {
  const busy = new core.ApiError(409, 'device_busy',
    `${WAITING} still has an update that is not finished. Wait for it or cancel it first.`,
    { details: [{ thing: WAITING, deployment: OFFERED }] });
  const notice = one(wizard({ devices: [board(WAITING)], error: busy }).dialog, 'div.notice.is-bad');
  assert.equal(textOf(notice).split(WAITING).length - 1, 1, 'named by the server, and only there');
  const link = one(notice, 'a');
  assert.equal(link.getAttribute('href'), `#/deployments/${OFFERED}`);
  assert.equal(textOf(link), 'the deployment of 1.2.3+5');
  assert.match(textOf(notice), /^The deployment was not started\. cranium-/);
  assert.match(textOf(notice), /cancel it first\. That update is the deployment of 1\.2\.3\+5\./);

  // With several boards the server gives a number; then each board is named with what holds it.
  const several = new core.ApiError(409, 'device_busy', '2 boards still have an update that is not finished.',
    { details: [{ thing: WAITING, deployment: OFFERED }, { thing: INSTALLING, deployment: 'not-an-id' }] });
  const list = one(wizard({ devices: [board(WAITING)], error: several }).dialog, 'ul.plain-list');
  assert.deepEqual(all(list, 'li').map(textOf),
    [`${WAITING}: the deployment of 1.2.3+5`, `${INSTALLING}: another deployment`]);
  assert.equal(all(list, 'a').length, 1, 'no link to an id that is not one');
});

test('a dialog with no release to deploy shows the way out', () => {
  const { dialog, calls } = wizard({ step: 0, version: null, releases: [] });
  assert.match(textOf(dialog), /There is no release to deploy\./);
  const out = one(dialog, 'a.btn', 'Go to Firmware');
  assert.equal(out.getAttribute('href'), '#/firmware');
  // It closes the dialog itself: on the Firmware page the address would not change.
  click(out);
  assert.deepEqual(calls, ['close']);
  assert.equal(one(dialog, 'button', 'Next').disabled, true);
});

function cancelling(item, changes = {}) {
  const calls = [];
  const model = {
    deployment: item,
    force: false,
    sending: false,
    error: null,
    close: () => calls.push(['close']),
    setForce: (force) => calls.push(['setForce', force]),
    submit: (force) => calls.push(['submit', force]),
    ...changes,
  };
  return { dialog: draw(views.cancelDialog(model)), calls };
}

const submit = (dialog) => one(dialog, 'form').dispatchEvent({ type: 'submit' });
const choicesOf = (dialog) => all(dialog, 'input').map((input) => [input.checked, input.disabled]);

test('cancelling: the dialog counts from the newest record and offers only what can be done', () => {
  const open = deployment(OFFERED, {
    executions: [
      execution(WAITING, 'waiting_for_button'),
      execution(INSTALLING, 'downloading', { status: 'IN_PROGRESS' }),
    ],
  });
  const first = cancelling(open);
  assert.match(textOf(first.dialog), /Right now 1 board is waiting and 1 board has started\./);
  assert.deepEqual(choicesOf(first.dialog), [[true, false], [false, false]]);
  assert.equal(textOf(one(first.dialog, 'button.is-danger')), 'Cancel the deployment');
  submit(first.dialog);
  assert.deepEqual(first.calls, [['submit', false]]);
  const forced = cancelling(open, { force: true });
  assert.equal(textOf(one(forced.dialog, 'button.is-danger')), 'Cancel and stop boards');

  // Somebody else was faster, or the last board finished: nothing is left, and nothing can be sent.
  const over = deployment(OFFERED, {
    status: 'CANCELED', executions: [execution(WAITING, 'cancelled', { status: 'CANCELED' })],
  });
  const finished = error(409, 'already_finished',
    'This deployment has already finished; there is nothing left to cancel.');
  const late = cancelling(over, { error: finished });
  assert.match(textOf(late.dialog), /Nothing is left to cancel\. No board is waiting for this update/);
  assert.doesNotMatch(textOf(late.dialog), /Right now/);
  assert.equal(one(late.dialog, 'button.is-danger').disabled, true);
  assert.equal(all(late.dialog, 'input').length, 0);
  assert.deepEqual(controls(late.dialog), ['Close', 'Close', 'Cancel the deployment']);
  submit(late.dialog);
  assert.deepEqual(late.calls, []);

  // Cancelled before, without force, and a board is still at it: the offer is
  // withdrawn already, and stopping that board is all that is left.
  const withdrawn = cancelling(WORLD.deployments[1]);
  assert.match(textOf(withdrawn.dialog), /Right now 0 boards are waiting and 1 board has started\./);
  assert.deepEqual(choicesOf(withdrawn.dialog), [[false, true], [true, false]]);
  const [plain] = all(withdrawn.dialog, 'label.choice');
  assert.match(textOf(plain), /Done already: this deployment was cancelled before/);
  assert.equal(textOf(one(withdrawn.dialog, 'button.is-danger')), 'Cancel and stop boards');
  submit(withdrawn.dialog);
  assert.deepEqual(withdrawn.calls, [['submit', true]]);
});

function revoking(item, changes = {}) {
  const calls = [];
  const model = {
    release: item,
    again: item.status !== 'active',
    reason: '',
    focusReason: true,
    sending: false,
    error: null,
    close: () => calls.push(['close']),
    setReason: (text) => calls.push(['setReason', text]),
    submit: () => calls.push(['submit']),
    ...changes,
  };
  return { dialog: draw(views.revokeDialog(model, DIALOG)), calls };
}

const focused = (dialog) => descendants(dialog).filter((el) => el.hasAttribute('autofocus'));

test('revoking: the reason is asked for as what it is, required and limited', () => {
  const active = clientRelease('1.2.3+5');
  const empty = revoking(active);
  assert.equal(textOf(one(empty.dialog, 'span.field-label')), 'Reason (required)');
  assert.match(textOf(one(empty.dialog, 'span.field-hint')), /Up to 200 characters\.$/);
  assert.equal(all(empty.dialog, 'span.field-count').length, 0);
  assert.equal(one(empty.dialog, 'button.is-danger').disabled, true);
  submit(empty.dialog);
  assert.deepEqual(empty.calls, [], 'nothing is sent without a reason');

  const typed = revoking(active, { reason: 'x'.repeat(159) });
  assert.equal(all(typed.dialog, 'span.field-count').length, 0);
  assert.equal(one(typed.dialog, 'button.is-danger').disabled, false);
  submit(typed.dialog);
  assert.deepEqual(typed.calls, [['submit']]);
  // From 160 characters on the field says how much room is left.
  const near = revoking(active, { reason: 'x'.repeat(160) });
  assert.equal(textOf(one(near.dialog, 'span.field-count')), '160 / 200');
  const full = one(revoking(active, { reason: 'x'.repeat(200) }).dialog, 'span.field-count');
  assert.equal(textOf(full), '200 / 200');
  assert.equal(full.getAttribute('class'), 'field-count is-full');

  // The keyboard starts in the reason, except on a touch screen, where it starts on
  // the safe choice.
  assert.deepEqual(focused(empty.dialog).map((el) => el.localName), ['textarea']);
  const touch = revoking(active, { focusReason: false });
  assert.deepEqual(focused(touch.dialog).map(textOf), ['Keep the release']);
});

test('revoking again: a release that is revoked already is finished, not asked for a reason', () => {
  const mark = { by: MANAGER, at: ago(1980), reason: REASON };
  const open = { ...clientRelease('2.0.0+0'), status: 'revoked', revoked: { ...mark, enforcedAt: null } };
  const finish = revoking(open);
  assert.equal(textOf(one(finish.dialog, 'h2')), 'Finish revoking 2.0.0+0?');
  assert.equal(all(finish.dialog, 'textarea').length, 0);
  assert.match(textOf(finish.dialog), /has not recorded that the two steps after the mark were completed/);
  assert.match(textOf(finish.dialog),
    new RegExp(`Revoked 33 min ago by ${escaped(MANAGER.email)}: ${escaped(REASON)}`));
  assert.deepEqual(controls(finish.dialog), ['Close', 'Close', 'Finish revoking']);
  const go = one(finish.dialog, 'button', 'Finish revoking');
  assert.equal(go.getAttribute('class'), 'btn is-primary');
  assert.equal(go.disabled, false);
  submit(finish.dialog);
  assert.deepEqual(finish.calls, [['submit']]);

  // A server that keeps no record of completion: the same steps, offered without a claim.
  const again = revoking({ ...open, revoked: mark });
  assert.equal(textOf(one(again.dialog, 'h2')), 'Apply the revocation of 2.0.0+0 again?');
  assert.deepEqual(controls(again.dialog), ['Close', 'Close', 'Apply again']);

  // A failure is said in the server's words, and that nothing is certain.
  const failed = error(500, 'revoke_incomplete',
    'Release 2.0.0+0 is marked revoked, but its image could not be blocked. Revoke it again to finish.');
  const notice = one(revoking(open, { error: failed }).dialog, 'span.notice-said');
  assert.equal(textOf(notice), `It is not certain whether this went through. ${failed.message}`);
  assert.equal(one(revoking(open, { sending: true }).dialog, 'button', 'Finishing…').disabled, true);
});
