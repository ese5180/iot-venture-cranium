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
  EMPTY, FINGERPRINT, INSTALLING, LOOKALIKE, MANAGER, NAMELESS, NEVER, NOW, OFFERED, REASON, WAITING, WITHDRAWN,
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
  'Upload firmware first', 'Cancel deployment', 'Stop boards that have started', 'Offer again',
  'Upload for verification', 'Try again', 'Choose another file', 'Deploy this release', 'Upload another',
]);
// The buttons of a release are named with its version, as in "Revoke 1.2.3+5".
const writes = (root) => controls(root).filter((label) => WRITE_CONTROLS.has(label.replace(/ \d\S*$/, '')));

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

  assert.deepEqual(writes(pages.get('firmware')), [
    'Finish revoking', 'Deploy 1.2.4+0', 'Revoke 1.2.4+0', 'Deploy 1.2.3+5', 'Revoke 1.2.3+5',
    'Deploy 1.2.3+4', 'Revoke 1.2.3+4',
  ]);
  assert.equal(all(pages.get('firmware'), 'label.drop').length, 1);
  assert.deepEqual(writes(pages.get('deployments')), ['New deployment']);
  assert.deepEqual(writes(pages.get('deployment')), ['Cancel deployment']);
  // Cancelled, but its board is still installing: stopping it is all that is left.
  assert.deepEqual(writes(pages.get('withdrawn deployment')), ['Stop boards that have started']);
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
  assert.match(textOf(withBoard[1]), /Drop binaries\/latest\.signed\.bin on the Firmware page/);
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
    /No update is in progress\. Last deployment: 1\.2\.4\+0 Cancelled started 20 min ago/);
});

test('the overview does not read as all well right after a rollout went wrong', async () => {
  const ended = (executions, changes = {}) => deployment(OFFERED, {
    status: 'COMPLETED', completedAt: ago(120), executions, ...changes,
  });
  const updates = async (executions, changes) => {
    const state = await consoleState({ ...EMPTY, devices: WORLD.devices, deployments: [ended(executions, changes)] });
    return one(page(views.overviewView, state), 'section.overview-updates');
  };
  const titleOf = (card) => one(card, 'p.calm-title');
  const badgeOf = (card) => one(card, 'span.badge');

  const failed = await updates([execution(WAITING, 'rolled_back', { status: 'FAILED', reason: 'rolled_back' })]);
  assert.equal(textOf(titleOf(failed)), 'The last deployment failed.');
  assert.equal(titleOf(failed).getAttribute('class'), 'calm-title is-bad');
  assert.equal(textOf(badgeOf(failed)), 'Failed');
  assert.equal(badgeOf(failed).getAttribute('class'), 'badge is-bad');
  assert.match(textOf(failed), /2 min ago\. No update is in progress\./);

  const partly = await updates([
    execution(WAITING, 'succeeded', { status: 'SUCCEEDED' }),
    execution(INSTALLING, 'failed', { status: 'FAILED' }),
  ]);
  assert.equal(textOf(titleOf(partly)), 'The last deployment partly succeeded.');
  assert.equal(titleOf(partly).getAttribute('class'), 'calm-title is-warn');

  // Declined on every board: nothing wrong, and nothing to tick off either.
  const declined = await updates([execution(WAITING, 'declined', { status: 'REJECTED', reason: 'declined' })]);
  assert.equal(textOf(titleOf(declined)), 'No update is in progress.');
  assert.equal(titleOf(declined).getAttribute('class'), 'calm-title is-idle');

  const fine = await updates([execution(WAITING, 'succeeded', { status: 'SUCCEEDED' })]);
  // Gone through: said out loud, not only with a tick.
  assert.equal(textOf(titleOf(fine)), '1.2.3+5 is installed and confirmed.');
  assert.equal(titleOf(fine).getAttribute('class'), 'calm-title is-good');
  assert.equal(all(fine, 'div.calm.is-good').length, 1);
  assert.match(textOf(fine), /Succeeded 2 min ago\. No update is in progress\./);
});

test('a last deployment that went wrong opens the panel with its outcome, and a calm one does not', async () => {
  const ended = (executions, changes = {}) => deployment(OFFERED, {
    status: 'COMPLETED', completedAt: ago(120), executions, ...changes,
  });
  const updates = async (executions) => {
    const state = await consoleState({ ...EMPTY, devices: WORLD.devices, deployments: [ended(executions)] });
    return one(page(views.overviewView, state), 'section.overview-updates');
  };
  const failed = await updates([execution(WAITING, 'rolled_back', { status: 'FAILED', reason: 'rolled_back' })]);
  assert.equal(all(failed, 'div.calm.is-bad').length, 1);
  // One board's bar would be one block across: it measures nothing, and the words say it.
  assert.equal(all(failed, 'div.calm-outcome').length, 0);
  assert.equal(all(failed, 'ul.counts').length, 0);
  const allFailed = await updates([
    execution(WAITING, 'failed', { status: 'FAILED' }), execution(INSTALLING, 'failed', { status: 'FAILED' }),
  ]);
  assert.equal(all(one(allFailed, 'div.calm-outcome'), 'div.segments').length, 1);
  assert.equal(one(allFailed, 'div.segments').getAttribute('aria-label'), 'Boards: 2 failed.');

  const partly = await updates([
    execution(WAITING, 'succeeded', { status: 'SUCCEEDED' }),
    execution(INSTALLING, 'failed', { status: 'FAILED' }),
  ]);
  assert.equal(all(partly, 'div.calm.is-warn').length, 1);
  assert.equal(textOf(one(partly, 'ul.counts')), '1 succeeded 1 failed');

  const fine = await updates([execution(WAITING, 'succeeded', { status: 'SUCCEEDED' })]);
  assert.equal(all(fine, 'div.calm-outcome').length, 0, 'one board that made it needs no bar');
  const fineTwo = await updates([
    execution(WAITING, 'succeeded', { status: 'SUCCEEDED' }),
    execution(INSTALLING, 'succeeded', { status: 'SUCCEEDED' }),
  ]);
  assert.equal(all(fineTwo, 'div.calm-outcome').length, 1);
  const called = await updates([execution(WAITING, 'declined', { status: 'REJECTED', reason: 'declined' })]);
  assert.equal(all(called, 'div.calm-outcome').length, 0);
});

test('the overview keeps the log at full width below two columns, and only so many boards', async () => {
  const many = Array.from({ length: 9 }, (_, index) => device(`cranium-${String(index).padStart(16, '0')}`));
  const overview = page(views.overviewView, await consoleState({ ...WORLD, devices: many }));
  // One ink panel holds what matters most: the updates, and under them the fleet.
  const panel = one(overview, 'div.overview-panel');
  assert.equal(panel.getAttribute('class').split(' ').includes('on-ink'), true);
  assert.equal(all(panel, 'section.overview-updates').length, 1);
  assert.deepEqual(all(one(panel, 'div.fleet'), 'section.card').map((card) => textOf(one(card, 'h2'))),
    ['Fleet', 'Firmware in the fleet', 'Newest release']);
  assert.match(textOf(panel), /9 of 9 boards online/);
  const grid = one(overview, 'div.overview');
  assert.deepEqual(grid.children.map((child) => child.getAttribute('class').replace('card ', '')),
    ['overview-boards', 'overview-activity']);
  const boards = one(grid, 'section.overview-boards');
  assert.equal(all(boards, 'li.board-line').length, 6);
  assert.equal(textOf(one(boards, 'p.board-more')), 'and 3 more boards');
  assert.equal(one(one(boards, 'p.board-more'), 'a').getAttribute('href'), '#/devices');
});

test('one problem with four things to read is one notice', async () => {
  const lost = new core.ApiError(0, 'network', 'The server could not be reached. Check the connection.');
  const failing = (resource) => ({ ...resource, error: lost });
  const state = await consoleState(WORLD);
  const { actions } = recorder();
  const drawn = (changes) => page(views.overviewView, { ...state, ...changes }, {}, actions);

  const all4 = drawn({
    devices: failing(state.devices),
    firmware: failing(state.firmware),
    deployments: failing(state.deployments),
    recent: failing(state.recent),
  });
  const notice = one(all4, 'div.notice.is-bad');
  assert.match(textOf(notice), /^Could not refresh this page\. The server could not be reached/);
  assert.equal(all(notice, 'button').length, 1);

  // One that fails is named, and so are two that fail for reasons of their own.
  assert.match(textOf(one(drawn({ devices: failing(state.devices) }), 'div.notice.is-bad')),
    /^Could not refresh the boards\./);
  const other = new core.ApiError(500, 'internal', 'Something else.');
  assert.equal(all(drawn({
    devices: failing(state.devices),
    firmware: { ...state.firmware, error: other },
  }), 'div.notice.is-bad').length, 2);
});

test('a board or a deployment that does not exist is not a failure to try again', async () => {
  const none = (resource) => new Map([[resource, {
    value: null, loading: false, loadedAt: 0, error: new core.ApiError(404, 'unknown', 'There is none.'),
  }]]);
  const state = await consoleState(WORLD);
  const board = page(views.deviceView, { ...state, deviceDetails: none('cranium-0000000000000000') },
    { thing: 'cranium-0000000000000000' });
  assert.deepEqual(controls(board), ['All devices']);
  assert.equal(one(board, 'a.btn').getAttribute('href'), '#/devices');
  assert.equal(all(board, 'div.notice').length, 0);
  assert.match(textOf(one(board, 'p.empty-title')), /No board with this name is registered\./);

  const id = 'cranium-9-9-9-b9-20260101T000000Z-abcd';
  const run = page(views.deploymentView, { ...state, deploymentDetails: none(id) }, { id });
  assert.deepEqual(controls(run), ['All deployments']);
  assert.doesNotMatch(textOf(run), /9\.9\.9\+9/);
  assert.equal(all(run, 'div.notice').length, 0);
});

test('a board that runs a revoked release is flagged wherever it is shown', async () => {
  const world = {
    ...EMPTY,
    releases: [release('2.0.0+0', { status: 'revoked', revoked: revoked({ enforcedAt: ago(100) }) }), release('1.2.3+5')],
    devices: [device(WAITING, { fw: { version: '2.0.0+0', confirmed: true } }), device(INSTALLING)],
  };
  const state = await consoleState(world);
  const lines = all(page(views.overviewView, state), 'li.fleet-line');
  assert.match(textOf(lines[0]), /^2\.0\.0\+0.*1 board Revoked release$/);
  assert.doesNotMatch(textOf(lines[1]), /Revoked release/);

  const boards = all(page(views.devicesView, state), 'article.device');
  assert.match(textOf(boards[0]), /Revoked release/);
  assert.match(textOf(boards[0]), /To replace it, upload a newer version and deploy that\./);
  assert.doesNotMatch(textOf(boards[1]), /Revoked release/);
  assert.match(textOf(page(views.deviceView, state, { thing: WAITING })), /Revoked release/);
});

test('the devices page shows a board that has an update waiting for it', async () => {
  const away = device(WAITING, { online: false, ota: { state: 'idle', job: null, progress: 0, last: 'none', error: '' } });
  const offer = deployment(OFFERED, { executions: [execution(WAITING, 'waiting_for_device', { online: false })] });
  const state = await consoleState({ ...WORLD, devices: [away, WORLD.devices[2]], deployments: [offer] });
  const [offered, never] = all(page(views.devicesView, state), 'article.device');
  assert.match(textOf(offered), /Offered 1\.2\.3\+5\. It will see the offer when it connects\./);
  assert.equal(one(offered, 'a.fact-link').getAttribute('href'), `#/deployments/${OFFERED}`);
  // A resting cue that the whole card is a link, and the hint of a board that never connected, below its rows.
  assert.equal(all(one(offered, 'h2.device-name'), 'svg').length, 1);
  assert.match(textOf(one(never, 'p.device-seen')), /^Has not reported to AWS IoT yet\.$/);
  assert.match(textOf(one(never, 'p.device-help')), /Power it up and check that it was provisioned\./);
  assert.equal(all(offered, 'p.device-help').length, 0);
  // No news is drawn as less than news.
  assert.match(one(never, 'dd', 'Nothing reported').children[0].children[0].getAttribute('class'), /is-quiet/);
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
  assert.equal(all(one(card, 'p.execution-title'), 'span').filter((item) => item.getAttribute('role') === 'status').length, 1);

  // The step it is at does not read as done.
  const steps = all(card, 'li.step');
  assert.deepEqual(steps.map((step) => textOf(one(step, 'span.step-label'))),
    ['Offered', 'Waiting for Button 1', 'Downloading', 'Download checked', 'Restarting', 'On trial', 'Confirmed']);
  assert.equal(steps[1].getAttribute('aria-current'), 'step');
  assert.equal(textOf(steps[1]), 'Waiting for Button 1: your turn');
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
  assert.equal(textOf(verifying[3]), 'Checking the download: in progress');
  const declined = await at(execution(WAITING, 'declined', { status: 'REJECTED', reason: 'declined' }));
  assert.equal(textOf(declined[1]), 'Not approved: stopped here');
  // The mark of a step that failed takes the tone of the headline.
  assert.equal(declined[1].parentNode.getAttribute('class'), 'steps is-warn');
  const cancelled = await at(execution(WAITING, 'cancelled', { status: 'CANCELED' }));
  assert.equal(textOf(cancelled[0]), 'Offered: done');
  assert.equal(textOf(cancelled[1]), 'Approved on the board: not reached');
  // Stopped on its way: where it had got to is marked, in no colour of failure.
  const stopped = await at(execution(WAITING, 'cancelled', { status: 'CANCELED', startedAt: ago(100) }));
  assert.equal(textOf(stopped[2]), 'Downloading: stopped here');
  assert.equal(stopped[2].getAttribute('class'), 'step is-stopped');
  assert.equal(textOf(stopped[3]), 'Download checked: not reached');
});

// What the deployment page draws for each state of a board.

const PHASES = [
  ['waiting_for_device', {}], ['waiting_for_button', {}],
  ['downloading', { status: 'IN_PROGRESS', progress: 40, startedAt: ago(30) }],
  ['verifying', { status: 'IN_PROGRESS', startedAt: ago(30) }],
  ['rebooting', { status: 'IN_PROGRESS', startedAt: ago(30) }],
  ['testing', { status: 'IN_PROGRESS', startedAt: ago(30) }],
  ['succeeded', { status: 'SUCCEEDED', startedAt: ago(30) }],
  ['rolled_back', { status: 'FAILED', reason: 'rolled_back', startedAt: ago(30) }],
  ['failed', { status: 'FAILED', reason: 'digest_mismatch', startedAt: ago(30) }],
  ['declined', { status: 'REJECTED', reason: 'declined' }],
  ['refused', { status: 'REJECTED', reason: 'not_newer' }],
  ['cancelled', { status: 'CANCELED' }],
  ['cancelled', { status: 'CANCELED', startedAt: ago(100) }],
  ['timed_out', { status: 'TIMED_OUT', startedAt: ago(100) }],
  ['removed', { status: 'REMOVED' }],
];

/** The page of a deployment with these executions, drawn, in a world where the boards are known. */
async function deploymentPage(executions, changes = {}, world = {}) {
  const run = deployment(OFFERED, { executions, ...changes });
  const state = await consoleState({ ...WORLD, deployments: [run], ...world });
  return page(views.deploymentView, state, { id: OFFERED });
}

const oneCard = async (phase, extra) =>
  one(await deploymentPage([execution(WAITING, phase, extra)]), 'article.execution');

test('the flash map says what a slot holds; it never draws how full a slot is', async () => {
  for (const [phase, extra] of PHASES) {
    const card = await oneCard(phase, extra);
    for (const row of all(card, 'li.flash-row')) {
      assert.equal(row.hasAttribute('role'), false, phase);
      assert.equal(row.custom.has('--fill'), phase === 'downloading' && textOf(row).includes('Receiving'), phase);
    }
    assert.equal(all(card, 'div.meter').length <= 1, true, `${phase}: at most one bar for a board`);
  }
});

test('the whole line of steps turns green only once the update is confirmed', async () => {
  for (const [phase, extra] of PHASES) {
    const card = await oneCard(phase, extra);
    const look = one(card, 'ol.steps').getAttribute('class').split(' ');
    assert.equal(look.includes('is-good'), phase === 'succeeded', phase);
  }
});

test('a board that said no is amber, and one that failed is red', async () => {
  for (const [phase, reason] of [['declined', 'declined'], ['refused', 'not_newer']]) {
    const card = await oneCard(phase, { status: 'REJECTED', reason });
    assert.equal(one(card, 'ol.steps').getAttribute('class'), 'steps is-warn', phase);
    assert.equal(one(card, 'div.return-path').getAttribute('class').includes('is-warn'), true, phase);
    assert.equal(all(card, 'div.return-path.is-bad').length, 0, phase);
  }
  const rolledBack = await oneCard('rolled_back', { status: 'FAILED', reason: 'rolled_back', startedAt: ago(30) });
  assert.equal(one(rolledBack, 'ol.steps').getAttribute('class'), 'steps is-bad');
  assert.equal(all(rolledBack, 'div.return-path.is-bad').length, 1);
  assert.match(textOf(one(rolledBack, 'p.return-label')), /^Back on the previous firmware/);
});

test('the way back is drawn from where an update failed, and not from where it was stopped', async () => {
  const stopped = await oneCard('cancelled', { status: 'CANCELED', startedAt: ago(100) });
  assert.equal(all(stopped, 'div.return-path').length, 0);
  const [mark] = all(one(stopped, 'li.step.is-stopped'), 'svg');
  assert.equal(mark.children.length, views.icon('minus').children.length);
  assert.equal(textOf(one(stopped, 'li.step.is-stopped')), 'Downloading: stopped here');
  // A step that is the first to go wrong has nothing to go back over.
  const never = await oneCard('removed', { status: 'REMOVED' });
  assert.equal(all(never, 'div.return-path').length, 0);
});

test('the two buttons of the board are drawn only while it waits for a person, on both pages', async () => {
  for (const [phase, extra] of PHASES) {
    const card = await oneCard(phase, extra);
    assert.equal(all(card, 'div.keys').length, phase === 'waiting_for_button' ? 1 : 0, phase);
  }
  const state = await consoleState(WORLD);
  const keys = all(page(views.overviewView, state), 'div.keys');
  assert.equal(keys.length, 1, 'the board at its button, and not the one downloading');
  // A drawing of what the words say already.
  assert.equal(keys[0].getAttribute('aria-hidden'), 'true');
});

test('with several boards only what needs the eye keeps the whole panel, and nothing changes place', async () => {
  const boards = ['aa', 'bb', 'cc', 'dd'].map((end) => `cranium-00000000000000${end}`);
  const started = { status: 'IN_PROGRESS', startedAt: ago(30) };
  const cards = async (executions) => {
    const devices = boards.map((thing) => device(thing));
    return all(await deploymentPage(executions, {}, { devices }), 'article.execution');
  };
  const looks = (list) => list.map((card) => card.getAttribute('class').split(' ').includes('is-compact'));

  // One board has the page to itself, however little it has to say.
  const alone = await cards([execution(boards[0], 'succeeded', { status: 'SUCCEEDED', startedAt: ago(30) })]);
  assert.deepEqual(looks(alone), [false]);
  assert.equal(all(alone[0], 'section.flash').length, 1);

  // Two or three: at work, waiting for a person or failed keep it.
  const three = await cards([
    execution(boards[0], 'succeeded', { status: 'SUCCEEDED', startedAt: ago(30) }),
    execution(boards[1], 'downloading', { ...started, progress: 40 }),
    execution(boards[2], 'waiting_for_device'),
  ]);
  assert.deepEqual(looks(three), [true, false, true]);
  assert.deepEqual(three.map((card) => textOf(one(card, 'h2.execution-name'))), boards.slice(0, 3));
  assert.deepEqual(three.map((card) => all(card, 'section.flash').length), [0, 1, 0]);
  assert.equal(all(three[0], 'ol.steps.is-compact').length, 1);

  // More than that, and all of them take a line.
  const four = await cards(boards.map((thing) => execution(thing, 'downloading', { ...started, progress: 40 })));
  assert.deepEqual(looks(four), [true, true, true, true]);
});

test('the map of a cancelled update says the same as the words above it', async () => {
  const id = OFFERED;
  const started = { status: 'CANCELED', startedAt: ago(100) };
  const slot = (card, name) => {
    const row = one(card, 'li.flash-row', name);
    return `${textOf(one(row, 'span.flash-version'))} ${textOf(one(row, 'span.flash-state'))}`;
  };
  const primary = (card) => slot(card, 'Primary slot');
  const secondary = (card) => slot(card, 'Secondary slot');
  const withBoard = async (executionChanges, board, history = []) => {
    const run = deployment(id, { status: 'CANCELED', executions: [execution(WAITING, 'cancelled', { ...started, ...executionChanges })] });
    const others = history.map((item) => deployment(item.id, {
      executions: [execution(WAITING, 'succeeded', { status: item.status, startedAt: ago(50) })],
    }));
    const state = await consoleState({ ...WORLD, devices: [board], deployments: [run, ...others] });
    return one(page(views.deploymentView, state, { id }), 'article.execution');
  };

  // Stopped on its way: the board stays on what it had.
  const stopped = await withBoard({}, device(WAITING));
  assert.match(primary(stopped), /1\.2\.3\+4/);
  assert.match(secondary(stopped), /1\.2\.3\+5 Not installed/);

  // Too far along to be stopped.
  const restart = await withBoard({}, device(WAITING, { ota: { state: 'rebooting', job: id, progress: 0, last: 'none', error: '' } }));
  assert.equal(textOf(one(restart, 'p.execution-title')), 'Finishing despite the cancellation');
  assert.match(primary(restart), /Being replaced/);
  assert.doesNotMatch(secondary(restart), /Not installed/);

  // And there it is.
  const installed = await withBoard({ running: '1.2.3+5' }, device(WAITING, { fw: { version: '1.2.3+5', confirmed: true } }));
  assert.equal(textOf(one(installed, 'p.execution-title')), 'Installed despite the cancellation');
  assert.match(primary(installed), /1\.2\.3\+5 Runs from here, confirmed/);
  assert.doesNotMatch(secondary(installed), /Not installed/);
  const trial = await withBoard({ running: '1.2.3+5' }, device(WAITING, { fw: { version: '1.2.3+5', confirmed: false } }));
  assert.match(primary(trial), /1\.2\.3\+5 Runs on trial/);

  // Since then it has moved on to something newer. How this one ended is not on record, so
  // there is no map of that, only what the board reports today, and no way to offer it again.
  const movedOnPage = async () => {
    const run = deployment(id, { status: 'CANCELED', executions: [execution(WAITING, 'cancelled', { ...started, running: '1.3.0+0' })] });
    const state = await consoleState({ ...WORLD, devices: [device(WAITING, { fw: { version: '1.3.0+0', confirmed: true } })], deployments: [run] });
    return page(views.deploymentView, state, { id });
  };
  const movedOnDrawn = await movedOnPage();
  const movedOn = one(movedOnDrawn, 'article.execution');
  assert.match(textOf(one(movedOn, 'section.flash')), /^Flash memory now/);
  assert.match(primary(movedOn), /1\.3\.0\+0 What the board reports/);
  assert.match(secondary(movedOn), /Not reported by the board How this update ended is not known/);
  assert.doesNotMatch(textOf(movedOn), /Stayed in place|Not installed|stopped here|keeps the firmware/);
  assert.equal(controls(movedOnDrawn).includes('Offer again'), false);

  // Cancelled at the button, and a later deployment installed it: not what ran when this ended.
  const atButton = await withBoard({ startedAt: null, running: '1.2.3+5' }, device(WAITING, { fw: { version: '1.2.3+5', confirmed: true } }));
  assert.match(primary(atButton), /Previous firmware Stayed in place/);
  assert.match(secondary(atButton), /Nothing written/);
  assert.doesNotMatch(textOf(atButton), /To try again/);

  // The board runs that version because of another deployment: this one stopped.
  const later = 'cranium-1-2-3-b5-20261010T115800Z-0d0d';
  const replaced = await withBoard({ running: '1.2.3+5' },
    device(WAITING, { fw: { version: '1.2.3+5', confirmed: true } }), [{ id: later, status: 'SUCCEEDED' }]);
  assert.equal(textOf(one(replaced, 'p.execution-title')), 'Cancelled');
  assert.match(textOf(replaced), /Another deployment installed 1\.2\.3\+5\./);
  assert.equal(one(replaced, 'a', 'Open the deployment that installed it').getAttribute('href'), `#/deployments/${later}`);
  assert.equal(all(replaced, 'p.execution-next').length, 1, 'and nothing about trying again');
  assert.match(secondary(replaced), /1\.2\.3\+5 Not installed/);
  assert.doesNotMatch(primary(replaced), /1\.2\.3\+5/);
});

test('a board that a cancellation found restarting is not shown as online', async () => {
  const restarting = await (async () => {
    const run = deployment(OFFERED, {
      status: 'CANCELED',
      executions: [execution(WAITING, 'cancelled', { status: 'CANCELED', startedAt: ago(100) })],
    });
    const board = device(WAITING, { ota: { state: 'rebooting', job: OFFERED, progress: 0, last: 'none', error: '' } });
    return one(page(views.deploymentView, await consoleState({ ...WORLD, devices: [board], deployments: [run] }),
      { id: OFFERED }), 'article.execution');
  })();
  assert.equal(textOf(one(one(restarting, 'header.execution-head'), 'span.badge')), 'Restarting');
});

test('a copy of a board\'s history from before it ran this version does not settle how it got there', async () => {
  const running = { fw: { version: '1.2.3+5', confirmed: true } };
  const run = deployment(OFFERED, { status: 'CANCELED', executions: [execution(WAITING, 'cancelled', { status: 'CANCELED', startedAt: ago(100), running: '1.2.3+5' })] });
  const world = { ...WORLD, devices: [device(WAITING, running)], deployments: [run] };
  const state = await consoleState(world);
  const drawn = (changes) => page(views.deploymentView, { ...state, ...changes }, { id: OFFERED });
  // Read after it got there, with no other deployment on the list: it went through.
  assert.match(textOf(drawn({})), /Installed despite the cancellation/);

  // The copy says the board ran the old version. Whatever list it holds, it says nothing yet.
  const stale = new Map(state.deviceDetails);
  const fresh = stale.get(WAITING);
  stale.set(WAITING, { ...fresh, value: { ...fresh.value, device: device(WAITING) } });
  const pending = drawn({ deviceDetails: stale });
  assert.doesNotMatch(textOf(pending), /Installed despite/);
  assert.match(textOf(pending), /The board now runs 1\.2\.3\+5\./);
  assert.equal(all(pending, 'div.notice.is-bad').length, 0);
  assert.equal(controls(pending).includes('Offer again'), false);

  // And the read of it failing is said.
  const failing = new Map(stale);
  failing.set(WAITING, { ...stale.get(WAITING), error: new core.ApiError(500, 'internal', 'The server failed.') });
  const failed = drawn({ deviceDetails: failing });
  assert.doesNotMatch(textOf(failed), /Installed despite/);
  assert.match(textOf(one(failed, 'div.notice.is-bad')), /^Could not refresh the board’s list of updates\./);
});

test('before the board list has been read, a cancelled update that had started claims nothing', async () => {
  const run = deployment(OFFERED, { status: 'CANCELED', executions: [execution(WAITING, 'cancelled', { status: 'CANCELED', startedAt: ago(100) })] });
  const state = await consoleState({ ...WORLD, deployments: [run] }, { devices: { value: null, error: null, loading: true, loadedAt: 0 } });
  const drawn = page(views.deploymentView, state, { id: OFFERED });
  const card = one(drawn, 'article.execution');
  assert.equal(textOf(one(one(card, 'header.execution-head'), 'span.badge')), 'Not known yet');
  assert.match(textOf(one(card, 'p.execution-text')), /What the board did next is still being read\./);
  assert.doesNotMatch(textOf(card), /keeps the firmware it had|Not installed|stopped here/);
  assert.equal(all(card, 'li.step.is-unknown').length, 5);
  assert.equal(controls(drawn).includes('Offer again'), false);
});

test('the overview does not say that nothing is going on while a board restarts after a forced cancel', async () => {
  const run = deployment(OFFERED, { status: 'CANCELED', executions: [execution(WAITING, 'cancelled', { status: 'CANCELED', startedAt: ago(100) })] });
  const board = device(WAITING, { ota: { state: 'rebooting', job: OFFERED, progress: 0, last: 'none', error: '' } });
  const overview = page(views.overviewView, await consoleState({ ...WORLD, devices: [board], deployments: [run] }));
  assert.doesNotMatch(textOf(overview), /No update is in progress/);
  const line = one(overview, 'li.run');
  assert.match(textOf(line), /Finishing despite the cancellation/);
  assert.match(textOf(line), /already restarting into the new firmware\. That cannot be stopped\./);
  assert.doesNotMatch(textOf(line), /unless it is stopped/);
});

test('with the deployments out of date the overview does not say that nothing is going on', async () => {
  const state = await consoleState({ ...EMPTY, devices: WORLD.devices, releases: WORLD.releases, deployments: [] });
  const failed = { ...state.deployments, error: new core.ApiError(503, 'gateway', 'Service Unavailable') };
  const overview = page(views.overviewView, { ...state, deployments: failed });
  assert.doesNotMatch(textOf(overview), /No update is in progress/);
  assert.match(textOf(overview), /Whether an update is in progress cannot be told right now\./);
  assert.equal(all(overview, 'li.guide-step').length, 0, 'nor what to do first');

  // The age at the top of the page and the age in the notice under it are one age.
  const older = { ...failed, loadedAt: NOW - 90000 };
  const aged = page(views.overviewView, { ...state, deployments: older });
  assert.match(textOf(one(aged, 'span.freshness-age')), /Updated 1 min ago/);
});

test('the same download has one percentage on the overview', async () => {
  const run = deployment(OFFERED, { executions: [execution(WAITING, 'downloading', { status: 'IN_PROGRESS', progress: 70, startedAt: ago(30) })] });
  const board = device(WAITING, { ota: { state: 'downloading', job: OFFERED, progress: 50, last: 'none', error: '' } });
  const overview = page(views.overviewView, await consoleState({ ...WORLD, devices: [board], deployments: [run] }));
  assert.match(textOf(one(overview, 'span.board-line-update')), /70%/);
  assert.equal(one(overview, 'p.board-run-figure').getAttribute('aria-hidden'), 'true');
  assert.match(textOf(one(overview, 'p.board-run-figure')), /70/);
});

test('a board\'s panel holds what the board is doing, and claims no report that never came', async () => {
  const state = await consoleState(WORLD);
  const panelOf = (thing, details = state.deviceDetails) =>
    one(page(views.deviceView, { ...state, deviceDetails: details }, { thing }), 'section.board-panel');

  // Waiting for a person: the words for across a room, and the keys.
  const waiting = panelOf(WAITING);
  assert.match(textOf(one(waiting, 'div.board-now')), /^Press Button 1 on the board/);
  assert.equal(all(waiting, 'div.keys').length, 1);
  assert.equal(all(waiting, 'div.board-now.is-act').length, 1);

  // Downloading: the figure, and no second progress bar for one board.
  const busy = panelOf(INSTALLING);
  assert.match(textOf(one(busy, 'p.board-run-figure')), /^40%$/);
  assert.equal(all(busy, 'div.meter').length, 0);
  assert.equal(all(page(views.deviceView, state, { thing: INSTALLING }), 'div.meter').length, 1);
  assert.equal(all(busy, 'div.keys').length, 0);

  // Never heard from: nothing about flash, or about a step that was never reported.
  const never = panelOf(NEVER);
  assert.equal(all(never, 'section.flash').length, 0);
  assert.match(textOf(never), /Nothing reported yet/);
  assert.doesNotMatch(textOf(never), /As last reported|Worked out/);

  // Offline in the middle of an update: the map and the rows below it say the same.
  const quiet = device(WAITING, { online: false, ota: { state: 'rebooting', job: OFFERED, progress: 0, last: 'none', error: '' } });
  const details = new Map(state.deviceDetails);
  details.set(WAITING, { ...details.get(WAITING), value: { ...details.get(WAITING).value, device: quiet } });
  const gone = panelOf(WAITING, details);
  assert.match(textOf(one(gone, 'section.flash')), /^Flash memory when last seen/);
  assert.equal(all(gone, 'h2').length, 1, 'one heading');
  assert.match(textOf(one(gone, 'li.flash-row', 'Secondary slot')), /1\.2\.3\+5.*Was restarting into 1\.2\.3\+5 when last seen/);
  assert.doesNotMatch(textOf(gone), /No update under way|As last reported/);
  assert.equal(all(gone, 'div.flash-swap').length, 0);

  // Online and idle: the flash map alone.
  const idle = device(WAITING);
  const calm = new Map(state.deviceDetails);
  calm.set(WAITING, { ...calm.get(WAITING), value: { ...calm.get(WAITING).value, device: idle } });
  const resting = panelOf(WAITING, calm);
  assert.equal(all(resting, 'div.board-now').length, 0);
  assert.match(textOf(one(resting, 'section.flash')), /^Flash memory now/);
});

test('the list of deployments does not show one board as a full bar, and says how far it is', async () => {
  const run = deployment(OFFERED, { executions: [execution(WAITING, 'downloading', { status: 'IN_PROGRESS', progress: 40, startedAt: ago(30) })] });
  const board = device(WAITING, { ota: { state: 'downloading', job: OFFERED, progress: 40, last: 'none', error: '' } });
  const list = page(views.deploymentsView, await consoleState({ ...WORLD, devices: [board], deployments: [run] }));
  assert.equal(all(list, 'div.segments').length, 0);
  assert.match(textOf(one(list, 'ul.counts')), /^1 updating · 40%$/);
  assert.match(textOf(one(list, 'ul.legend')), /^1 updating · 40%$/);

  // Waiting for a person: said alike in the panel and on the row.
  const waiting = page(views.deploymentsView, await consoleState({ ...WORLD, deployments: [deployment(OFFERED, { executions: [execution(WAITING, 'waiting_for_button')] })] }));
  assert.match(textOf(one(waiting, 'ul.legend')), /1 waiting for Button/);
  assert.match(textOf(one(waiting, 'ul.counts')), /1 waiting for Button/);

  // Several boards are a share of something.
  const two = page(views.deploymentsView, await consoleState({ ...WORLD, deployments: [deployment(OFFERED, {
    executions: [execution(WAITING, 'waiting_for_button'), execution(INSTALLING, 'downloading', { status: 'IN_PROGRESS', progress: 40, startedAt: ago(30) })],
  })] }));
  assert.equal(all(two, 'div.segments').length, 2);
});

test('a line of the activity log from a script says that nobody signed in', async () => {
  const state = await consoleState({ ...WORLD, entries: [entry('firmware.revoke', '2.0.0+0', { at: ago(10), requestId: 'bench-0123456789abcdef', detail: { reason: 'x', cancelled: '0' } })] });
  const line = one(page(views.activityView, state), 'li.log-line');
  assert.match(textOf(line), /Script, no sign-in/);
  const normal = await consoleState(WORLD);
  assert.doesNotMatch(textOf(page(views.activityView, normal)), /Script, no sign-in/);
});

test('a viewer is not told it is their turn, or to upload', async () => {
  const held = deployment(OFFERED, { status: 'COMPLETED', completedAt: ago(10), executions: [execution(WAITING, 'rolled_back', { status: 'FAILED', reason: 'rolled_back', startedAt: ago(100) })] });
  const viewer = await consoleState({ ...WORLD, deployments: [held] }, { viewer: true });
  const ended = page(views.deploymentView, viewer, { id: OFFERED });
  assert.equal(all(ended, 'p.execution-next').length, 0);
  const manager = await consoleState({ ...WORLD, deployments: [held] });
  assert.equal(all(page(views.deploymentView, manager, { id: OFFERED }), 'p.execution-next').length, 1);

  const asked = await consoleState(WORLD, { viewer: true });
  const steps = all(page(views.deploymentView, asked, { id: OFFERED }), 'li.step');
  assert.match(textOf(steps[1]), /: waiting for someone$/);
  const yours = all(page(views.deploymentView, await consoleState(WORLD), { id: OFFERED }), 'li.step');
  assert.match(textOf(yours[1]), /: your turn$/);
});

test('a compact step list gives a screen reader the state of each step, and a preview has no states to give', async () => {
  const overview = page(views.overviewView, await consoleState(WORLD));
  const steps = all(all(overview, 'li.run')[0], 'li.step');
  assert.match(textOf(steps[0]), /^Offered: done$/);
  assert.match(textOf(steps[2]), /^Downloading: not started$/);
  const blank = page(views.overviewView, await consoleState(EMPTY));
  for (const step of all(blank, 'li.step')) assert.doesNotMatch(textOf(step), /:/);
});

test('a size that says the same twice is said once', async () => {
  const small = await uploadPanel(chosen({ size: 800 }));
  assert.equal(textOf(one(small.panel, 'dd', '800 bytes')), '800 bytes');
});

test('a deployment cancelled by hand before its release was revoked is not put down to the revocation', async () => {
  const run = deployment(WITHDRAWN, { version: '2.0.0+0', status: 'CANCELED', createdAt: ago(9000), executions: [execution(WAITING, 'cancelled', { status: 'CANCELED' })] });
  const cancelledBy = (at) => [entry('deployment.cancel', WITHDRAWN, { at: ago(at), detail: { force: 'false' } })];
  const after = page(views.deploymentView, await consoleState({ ...WORLD, deployments: [run], entries: cancelledBy(5000) }), { id: WITHDRAWN });
  assert.doesNotMatch(textOf(one(after, 'div.notice.is-idle', 'was revoked')), /Revoking cancels/);
  const none = page(views.deploymentView, await consoleState({ ...WORLD, deployments: [run], entries: [] }), { id: WITHDRAWN });
  assert.match(textOf(one(none, 'div.notice.is-idle', 'was revoked')), /Revoking cancels every open deployment/);
});

test('a board page shows the offer a board has not picked up, from its own history', async () => {
  const away = device(WAITING, { online: false, ota: null });
  const run = deployment(OFFERED, { executions: [execution(WAITING, 'waiting_for_device', { online: false })] });
  // As after a reload: the list of deployments has not been read on this page.
  const state = await consoleState({ ...WORLD, devices: [away], deployments: [run] }, {
    deployments: { value: null, error: null, loading: false, loadedAt: 0 },
    deploymentDetails: new Map(),
  });
  const update = one(page(views.deviceView, state, { thing: WAITING }), 'dd', 'Offered');
  assert.match(textOf(update), /Offered 1\.2\.3\+5\. It will see the offer when it connects\./);
  assert.equal(one(update, 'a.fact-link').getAttribute('href'), `#/deployments/${OFFERED}`);
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

  // The short log on the overview names the whole address: the part before the @ alone
  // could be anybody's. The tooltip has the account as well.
  const [short] = all(pages.get('overview'), 'span.log-actor');
  assert.equal(textOf(short), MANAGER.email);
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
    [`Reason: ${REASON}`, 'Deployments cancelled 1', 'Account 0b1c2d3e…', 'Request req-1']);
  assert.deepEqual(detail(lines[1]),
    ['Forced no', `Deployment ${WITHDRAWN}`, 'Account f9e8d7c6…', 'Request req-1']);
  assert.deepEqual(detail(lines[2]),
    ['Boards 1', `Deployment ${OFFERED}`, 'Account 0b1c2d3e…', 'Request req-1']);
  // A refusal in words, with its code after them; the file is what the sentence names already,
  // and a digest is shortened beside a button that copies all of it.
  assert.deepEqual(detail(lines[3]), [
    'Signed with a different key than this project’s (wrong_key)', 'Size 1,264 bytes',
    `SHA-256 ${'c'.repeat(12)}…`, 'Account 7a7a7a7a…', 'Request req-1',
  ]);
  assert.equal(one(lines[3], 'button').getAttribute('aria-label'), `Copy the SHA-256 of ${'c'.repeat(12)}…`);
  // A reason is prose; an identifier is set as one.
  assert.equal(all(one(lines[0], 'span', 'Reason:'), 'span.mono').length, 0);
  assert.equal(textOf(one(one(lines[3], 'span', 'Signed with'), 'span.mono')), 'wrong_key');
  // The deployment links to its page under the name of its version.
  assert.equal(one(lines[2], 'a.log-target').getAttribute('href'), `#/deployments/${OFFERED}`);
});

test('the log says how a deployment that is over ended, and leaves the others alone', async () => {
  const over = deployment(OFFERED, {
    status: 'COMPLETED', completedAt: ago(100),
    executions: [execution(WAITING, 'rolled_back', { status: 'FAILED', reason: 'rolled_back' })],
  });
  const line = async (deployments) => textOf(one(one(page(views.activityView,
    await consoleState({ ...WORLD, deployments })), 'li.log-line', 'started a deployment'), 'p.log-what'));
  assert.equal(await line([over]), `${MANAGER.email} started a deployment of 1.2.3+5 Failed`);
  assert.equal(await line([deployment(OFFERED, { executions: [execution(WAITING, 'waiting_for_button')] })]),
    `${MANAGER.email} started a deployment of 1.2.3+5`);
  assert.equal(await line([]), `${MANAGER.email} started a deployment of 1.2.3+5`);
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

test('a deployment that was cancelled says so next to what its board is still doing', async () => {
  const state = await consoleState(WORLD);
  const { actions, calls } = recorder();
  const drawn = page(views.deploymentView, state, { id: WITHDRAWN }, actions);
  assert.match(textOf(one(drawn, 'h1')), /Cancelled, 1 board still working$/);
  assert.match(textOf(one(drawn, 'div.page-notice')),
    /This deployment was cancelled\. A board that had already started carries on unless it is stopped\./);
  click(one(drawn, 'button', 'Stop boards that have started'));
  assert.deepEqual(calls.map(([name]) => name), ['openCancel']);
  // Who cancelled it is in the log.
  assert.match(textOf(one(drawn, 'div.page-meta')), /Cancelled 15 min ago \(.+\) by /);
});

test('a board on the deployment page: what it is and what it has done are not contradicted', async () => {
  const card = async (execution_, devices = WORLD.devices) => {
    const run = deployment(OFFERED, { executions: [execution_] });
    return one(page(views.deploymentView, await consoleState({ ...WORLD, devices, deployments: [run] }),
      { id: OFFERED }), 'article.execution');
  };
  const never = await card(execution(NEVER, 'waiting_for_device', { online: false }));
  assert.match(textOf(never), /Never connected/);
  assert.doesNotMatch(textOf(never), /Board offline|Offline|reconnect/);

  const restarting = await card(execution(WAITING, 'rebooting', { status: 'IN_PROGRESS', startedAt: ago(100) }));
  assert.equal(textOf(one(one(restarting, 'header.execution-head'), 'span.badge')), 'Restarting');

  // While the board is at it, the record of AWS does not move with the download.
  const busy = await card(execution(WAITING, 'downloading', {
    status: 'IN_PROGRESS', progress: 40, startedAt: ago(100), lastUpdatedAt: ago(100),
  }));
  assert.doesNotMatch(textOf(one(busy, 'p.execution-foot')), /Last report|Ended/);
  // The figure is not read out at every change. The bar has it.
  const title = one(busy, 'p.execution-title');
  assert.equal(textOf(title), 'Downloading 40%');
  assert.equal(withText(title, 'span', '40%').at(-1).getAttribute('aria-hidden'), 'true');
  assert.equal(one(busy, 'div.meter').getAttribute('aria-valuenow'), '40');

  const ended = await card(execution(WAITING, 'declined', { status: 'REJECTED', reason: 'declined', lastUpdatedAt: ago(30) }));
  assert.match(textOf(one(ended, 'p.execution-foot')), /Ended 30 s ago \(.+\)/);
  assert.match(textOf(one(ended, 'p.execution-next')), /start a new deployment/);
});

test('an update that ended short can be offered again, if the release is still there', async () => {
  const short = (id, version) => deployment(id, {
    status: 'COMPLETED', completedAt: ago(100), version,
    executions: [execution(WAITING, 'declined', { status: 'REJECTED', reason: 'declined' })],
  });
  const active = 'cranium-1-2-3-b5-20261010T115400Z-0a0a';
  const gone = 'cranium-2-0-0-b0-20261010T115400Z-0a0a';
  const world = { ...WORLD, deployments: [short(active, '1.2.3+5'), short(gone, '2.0.0+0')] };
  const { actions, calls } = recorder();
  const state = await consoleState(world);
  const open = page(views.deploymentView, state, { id: active }, actions);
  click(one(open, 'button', 'Offer again'));
  assert.deepEqual(calls.map(([name, version]) => [name, version]), [['openDeploy', '1.2.3+5']]);

  const revokedOne = page(views.deploymentView, state, { id: gone });
  assert.equal(all(revokedOne, 'button').some((item) => textOf(item).includes('Offer again')), false);
  assert.equal(all(revokedOne, 'p.execution-next').length, 0);

  const viewer = page(views.deploymentView, await consoleState(world, { viewer: true }), { id: active });
  assert.equal(all(viewer, 'button').some((item) => textOf(item).includes('Offer again')), false);
});

test('a detail page names what it is about in its heading', async () => {
  const pages = everyPage(await consoleState(WORLD));
  assert.equal(textOf(one(pages.get('deployment'), 'h1')), 'Deployment of 1.2.3+5 Waiting for boards');
  assert.equal(textOf(one(pages.get('device'), 'h1')), `Board ${WAITING}`);
  assert.equal(textOf(one(pages.get('overview'), 'h1')), 'Overview');
  for (const drawn of pages.values()) assert.equal(all(drawn, 'h1').length, 1);
});

test('the sections keep their place: each link holds the room its name takes in bold', async () => {
  const nav = draw(views.navView({ state: { route: { view: 'overview' } } }));
  assert.deepEqual(all(nav, 'a').map((link) => link.getAttribute('data-label')),
    ['Overview', 'Devices', 'Firmware', 'Deployments', 'Activity', 'Developer']);
});

test('the Developer section leads to what the account can use, and is current on both of its pages', () => {
  const links = (route, canWrite) => {
    const nav = draw(views.navView({ state: { route: { view: route }, me: { canWrite } } }));
    const developer = one(nav, 'a', 'Developer');
    return [developer.getAttribute('href'), developer.getAttribute('aria-current')];
  };
  assert.deepEqual(links('serial', true), ['#/serial', 'page']);
  assert.deepEqual(links('history', false), ['#/history', 'page']);
  assert.deepEqual(links('overview', true), ['#/serial', null]);
});

test('the masthead says when the session is over, not that it ends in no time', () => {
  const state = (sessionLeft) => ({
    state: { me: { email: 'x', sub: 'y', canWrite: true }, sessionLeft }, actions: recorder().actions,
  });
  assert.equal(textOf(one(draw(views.accountView(state(3600))), 'span.account-session')), 'Session ends in 1 h');
  assert.equal(textOf(one(draw(views.accountView(state(0))), 'span.account-session')), 'Session ended');
  assert.equal(textOf(one(draw(views.accountView(state(-20))), 'span.account-session')), 'Session ended');
});

test('a message at the foot of the page can be closed', () => {
  const closed = [];
  const toast = draw(views.toastView('Done.', () => closed.push(true)));
  assert.equal(textOf(toast), 'Done.');
  click(one(toast, 'button'));
  assert.deepEqual(closed, [true]);
  assert.equal(one(toast, 'button').getAttribute('aria-label'), 'Close');
});

test('versions and file names in a sentence are set like everywhere else', async () => {
  const run = deployment(OFFERED, {
    executions: [execution(WAITING, 'succeeded', { status: 'SUCCEEDED', running: '1.2.3+5' })],
    status: 'COMPLETED',
  });
  const drawn = page(views.deploymentView, await consoleState({ ...WORLD, deployments: [run] }), { id: OFFERED });
  assert.equal(textOf(one(drawn, 'p.execution-text')), 'The board runs 1.2.3+5 and has confirmed it.');
  assert.equal(textOf(one(one(drawn, 'p.execution-text'), 'span.mono')), '1.2.3+5');
});

test('a release row reads from top to bottom, and its buttons say which release they act on', async () => {
  const row = one(page(views.firmwareView, await consoleState(WORLD)), 'li.release', '1.2.3+5');
  assert.deepEqual(row.children.map((child) => child.getAttribute('class')),
    ['release-main', 'release-actions', 'more']);
  assert.equal(textOf(one(row, 'summary')), 'Details of 1.2.3+5');
  assert.equal(one(row, 'button', 'Revoke').getAttribute('aria-label'), 'Revoke 1.2.3+5');
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
  // Said once, by the line that is there at every stage.
  assert.equal(textOf(one(panel, 'p.sr-only')), 'Uploading.');
  assert.equal(one(panel, 'p.sr-only').getAttribute('role'), 'status');
  const status = one(panel, 'div.upload-progress');
  assert.equal(status.hasAttribute('role'), false);
  assert.equal(textOf(status), 'Uploading… 42%');
  assert.equal(one(status, 'span', '42%').getAttribute('aria-hidden'), 'true');
  assert.equal(one(status, 'div.meter').getAttribute('aria-valuenow'), '42');
  assert.deepEqual(controls(panel), [], 'nothing to press while it is on its way');
});

test('the upload panel says each stage through a line that is always there', async () => {
  const said = async (upload) => textOf(one((await uploadPanel(upload)).panel, 'p.sr-only'));
  assert.equal(await said({ stage: 'idle', over: false }), '');
  assert.equal(await said({ stage: 'reading', name: 'a.bin' }), 'Reading a.bin.');
  assert.match(await said(chosen()), /^zephyr\.signed\.bin\. Version 2\.0\.1\+0\. Fits the board’s/);
  assert.match(await said({ stage: 'done', release: release('2.0.1+0') }), /^Registered as 2\.0\.1\+0\./);
  // The panel takes the keyboard when the control that had it goes away with a stage.
  const { panel } = await uploadPanel(chosen());
  assert.equal(panel.getAttribute('tabindex'), '-1');
  assert.equal(panel.hasAttribute('data-focus-home'), true);
});

test('a file the server is certain to refuse is not offered for upload', async () => {
  // Older than the highest version registered; no point in a check that will not happen.
  const older = await uploadPanel(chosen({ header: { ...HEADER, version: '1.0.0+0' } }));
  assert.deepEqual(controls(older.panel), ['Choose another file']);
  assert.equal(one(older.panel, 'button', 'Choose another file').getAttribute('class').includes('is-primary'), true);
  assert.equal(all(older.panel, 'textarea').length, 0);
  assert.doesNotMatch(textOf(older.panel), /Signature: not checked yet/);
  assert.match(textOf(older.panel), /Not newer than 2\.0\.0\+0/);
});

test('once refused, a file is not told what was expected of it', async () => {
  const empty = { ...EMPTY };
  const state = await consoleState(empty);
  const refused = page(views.firmwareView, {
    ...state,
    upload: chosen({
      stage: 'refused', error: error(422, 'wrong_key', 'The image is signed with a different key.'),
    }),
  });
  assert.doesNotMatch(textOf(refused), /This will be the first release/);
  assert.equal(all(one(refused, 'div.upload-main'), 'ul.checks').length, 0);
  // And the way on does not depend on where the panel happens to be.
  assert.doesNotMatch(textOf(one(refused, 'p.empty-text')), /above/);
  assert.equal(textOf(one(one(refused, 'p.empty-text'), 'span.mono')), 'binaries/latest.signed.bin');
});

test('what the server says about a badly signed image is put in plain words', async () => {
  const { panel } = await refusedWith(error(422, 'unexpected_tlv', 'Unexpected or repeated TLV entry of type 0x20'));
  assert.match(textOf(one(panel, 'span.notice-said')), /not signed the way this project requires/);
  assert.doesNotMatch(textOf(one(panel, 'span.notice-said')), /TLV/);
});

test('an upload that was revoked since does not stand there as something to deploy', async () => {
  const fresh = await uploadPanel({ stage: 'done', release: release('2.0.1+0') });
  assert.deepEqual(controls(fresh.panel), ['Deploy this release', 'Upload another']);
  const revokedSince = await uploadPanel({ stage: 'done', release: release('2.0.0+0') });
  assert.equal(all(revokedSince.panel, 'label.drop').length, 1);
  assert.doesNotMatch(textOf(revokedSince.panel), /It can now be offered/);
  assert.equal(textOf(one(revokedSince.panel, 'p.sr-only')), '');
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

test('from a file to the boards: the panel says where a file stands, in words', async () => {
  const stages = async (upload) => all((await uploadPanel(upload)).panel, 'span.upload-stage-words').map(textOf);
  assert.deepEqual(await stages({ stage: 'idle', over: false }), [
    'Choose a signed image: your turn', 'The server verifies it: not started', 'Deploy it to boards: not started',
  ]);
  assert.equal((await stages(chosen({ stage: 'checking', sent: 1 })))[1], 'The server verifies it: the server is verifying');
  assert.deepEqual((await stages({ stage: 'done', release: release('2.0.1+0') })).slice(1), [
    'The server verifies it: signature valid', 'Deploy it to boards: your turn',
  ]);
  // Deployed since: the next move is not still the reader's, and the panel leads to it.
  const deployed = await uploadPanel({ stage: 'done', release: release('1.2.3+5') });
  assert.equal(textOf(all(deployed.panel, 'span.upload-stage-words')[2]), 'Deploy it to boards: started');
  assert.equal(one(deployed.panel, 'a', 'Open its deployment').getAttribute('href'), `#/deployments/${OFFERED}`);
  assert.equal(all(deployed.panel, 'button').some((item) => textOf(item) === 'Deploy this release'), false);
  // Finished is ink, and green is for what was proved.
  assert.deepEqual(all(deployed.panel, 'li.upload-stage').map((stage) => stage.getAttribute('class')),
    ['upload-stage is-done', 'upload-stage is-good', 'upload-stage is-done']);
  const refused = await stages(chosen({ stage: 'refused', error: error(422, 'wrong_key', 'Signed differently.') }));
  assert.equal(refused[1], 'The server verifies it: refused, nothing stored');
  assert.equal(refused[2], 'Deploy it to boards: not started');
  // What the server cannot be asked about is stopped at the first stage.
  assert.equal((await stages(chosen({ header: { ...HEADER, version: '1.0.0+0' } })))[0],
    'Choose a signed image: cannot be used');
  // A request that fell through was not refused for what the file is.
  assert.equal((await stages(chosen({ stage: 'refused', error: error(503, 'gateway', 'Unavailable.') })))[1],
    'The server verifies it: not finished');
});

test('the way in says where the newest build is', async () => {
  const { panel } = await uploadPanel({ stage: 'idle', over: false });
  assert.match(textOf(one(panel, 'label.drop')),
    /Each build leaves its signed image in binaries\/latest\.signed\.bin in your checkout\. Git does not track that folder\./);
});

test('while the server checks, the panel says that the server is checking', async () => {
  const { panel } = await uploadPanel(chosen({ stage: 'checking', sent: 1 }));
  assert.equal(textOf(one(panel, 'p.upload-verifying')), 'Uploaded. The server is verifying the signature…');
  assert.equal(textOf(one(panel, 'p.sr-only')), 'Uploaded. The server is verifying the signature.');
  assert.deepEqual(controls(panel), []);
});

test('a verified upload shows what the server answered, and leads straight to the boards', async () => {
  const answered = release('2.0.1+0', {
    size: 769211, sha256: 'd'.repeat(64), keyHash: FINGERPRINT, headerSize: 512, payloadSize: 768000, loadAddress: 196608,
  });
  const { panel, calls } = await uploadPanel({ stage: 'done', release: answered });
  assert.equal(textOf(one(panel, 'p.verified-title')), 'Verified by the server');
  const facts = Object.fromEntries(all(panel, 'div.fact')
    .map((fact) => [textOf(one(fact, 'dt')), textOf(one(fact, 'dd'))]));
  assert.equal(facts.Signature, 'ECDSA P-256, valid');
  assert.equal(facts['Signing key'], `${FINGERPRINT} The fingerprint of this project’s signing key.`);
  assert.match(facts.Version, /^2\.0\.1\+0 /);
  assert.equal(facts.Size, '769,211 bytes (751 KiB) 512 bytes of header, 768,000 bytes of firmware, then the signature.');
  assert.equal(facts['SHA-256'], 'd'.repeat(64));
  assert.equal(facts['Load address'], '0x30000');
  // What was checked, each with its tick: next to the verdict, in the column beside it.
  const proof = one(page(views.firmwareView, await consoleState(WORLD, { upload: { stage: 'done', release: answered } })), 'div.verified-checks');
  assert.deepEqual(all(proof, 'li.check').map((check) => check.getAttribute('class')),
    core.IMAGE_CHECKS.map(() => 'check is-good'));
  assert.deepEqual(all(proof, 'li.check').map(textOf), core.IMAGE_CHECKS.map((check) => check.passed));
  assert.equal(all(panel, 'li.check').length, 0, 'and not a second time');
  assert.doesNotMatch(textOf(proof), new RegExp(FINGERPRINT), 'nor the fingerprint that is on the left already');
  // The first release has nothing before it to be newer than.
  const onlyOne = await consoleState({ ...EMPTY, releases: [release('2.0.1+0')] }, { upload: { stage: 'done', release: answered } });
  assert.match(textOf(one(page(views.firmwareView, onlyOne), 'div.verified-checks')), /no release came before it/);

  // The main action is what comes next, and it knows which release.
  const primary = one(panel, 'button', 'Deploy this release');
  assert.equal(primary.getAttribute('class').split(' ').includes('is-primary'), true);
  click(primary);
  assert.deepEqual(calls, [['openDeploy', '2.0.1+0']]);
});

test('only what the server answered is shown as its answer', async () => {
  // A reply without these fields, as the console's client reads one: no line for them, and nothing made up.
  const { panel } = await uploadPanel({ stage: 'done', release: release('2.0.1+0', { loadAddress: null, keyHash: '' }) });
  const terms = all(panel, 'dt').map(textOf);
  assert.equal(terms.includes('Load address'), false);
  assert.equal(terms.includes('Signing key'), false);
  // A key the server names that is not the one on record is not called this project's.
  const other = await uploadPanel({ stage: 'done', release: release('2.0.1+0', { keyHash: '0'.repeat(64) }) });
  assert.match(textOf(one(other.panel, 'dd', '0'.repeat(64))), /The fingerprint of the key that signed it\./);
});

test('a refused image names the check that failed and says that nothing was stored', async () => {
  const facts = async (failure) => {
    const { panel } = await refusedWith(failure);
    return textOf(one(panel, 'p.upload-refusal'));
  };
  assert.equal(await facts(error(422, 'wrong_key', 'Signed differently.')), 'Check that failed: Signing key. Nothing was stored.');
  assert.equal(await facts(error(422, 'bad_signature', 'Not valid.')), 'Check that failed: Signature. Nothing was stored.');
  assert.equal(await facts(error(422, 'hash_mismatch', 'Damaged.')), 'Check that failed: Image hash. Nothing was stored.');
  assert.equal(await facts(error(422, 'version_not_newer', 'Older.')), 'Check that failed: Version. Nothing was stored.');
  assert.equal(await facts(error(409, 'version_exists', 'Exists.')), 'Check that failed: Version. Nothing was stored.');
  // Refused by the gateway: the file did not get as far as a check.
  assert.equal(await facts(error(413, 'gateway', 'Too large.')), 'Nothing was stored.');

  // It is said to a screen reader as well.
  const { panel } = await refusedWith(error(422, 'wrong_key', 'Signed differently.'));
  assert.equal(textOf(one(panel, 'p.sr-only')), 'Nothing was stored.');

  // What is not known is not claimed.
  for (const failure of [
    error(503, 'gateway', 'Unavailable.'), error(0, 'network', 'Lost.'), error(403, 'release_manager_required', 'No.'),
  ]) {
    const { panel: open } = await refusedWith(failure);
    assert.equal(all(open, 'p.upload-refusal').length, 0, failure.code);
  }
});

test('a release manager has the upload on the ink, and a viewer the releases', async () => {
  const onInk = (drawn) => all(drawn, 'section.on-ink').map((section) => section.getAttribute('class').split(' ')[0]);
  assert.deepEqual(onInk(page(views.firmwareView, await consoleState(WORLD))), ['upload']);
  assert.deepEqual(onInk(page(views.firmwareView, await consoleState(WORLD, { viewer: true }))), ['timeline-panel']);
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

test('choosing boards: never connected, busy and refusing boards are told apart', () => {
  const older = board(WAITING);
  const same = board(INSTALLING, { fw: { version: '1.2.3+5', confirmed: true } });
  const never = board(NEVER, { online: false, lastSeen: null, fw: null });
  const { dialog } = wizard({ devices: [older, same, never] });
  const choices = all(dialog, 'label.choice');
  assert.match(textOf(choices[2]), /It will see the offer when it first connects\. Power it up and check/);
  assert.doesNotMatch(textOf(choices[2]), /reconnect/);

  // "All" leaves out the board that would only refuse.
  assert.equal(textOf(one(dialog, 'button', 'Select all')), 'Select all 2 available boards');
  const allTicked = wizard({ devices: [older, same, never], things: new Set([WAITING, NEVER]) }).dialog;
  assert.equal(all(allTicked, 'button').some((item) => textOf(item) === 'Clear the selection'), true);

  // A board that is held up leads to what holds it.
  const busy = new Map([[WAITING, { deployment: OFFERED, version: '1.2.4+0' }]]);
  const held = all(wizard({ devices: [older], busy }).dialog, 'label.choice')[0];
  assert.equal(one(held, 'a', 'that deployment').getAttribute('href'), `#/deployments/${OFFERED}`);
});

test('the last step repeats what was said about a board at the moment of commitment', () => {
  const same = board(INSTALLING, { fw: { version: '1.2.3+5', confirmed: true } });
  const never = board(NEVER, { online: false, lastSeen: null, fw: null });
  const { dialog } = wizard({ step: 2, devices: [same, never], things: new Set([INSTALLING, NEVER]) });
  const [refusing, unseen] = all(dialog, 'dd')[1].children[0].children;
  assert.match(textOf(refusing), /so it will refuse the offer\./);
  assert.doesNotMatch(textOf(unseen), /refuse/);
  assert.match(textOf(one(dialog, 'div.callout')), /1 board has never connected and will see the offer when first connected\./);
});

test('moving between the steps of a dialog is said to a screen reader', () => {
  const { dialog } = wizard({ devices: [board(WAITING)] });
  const body = one(dialog, 'div.wizard-body');
  assert.equal(body.getAttribute('role'), 'group');
  assert.equal(body.getAttribute('aria-label'), 'Step 2 of 3: Boards');
  assert.equal(textOf(all(one(dialog, 'ol.wizard-steps'), 'li')[0]), 'Release (done)');
});

test('a release that was revoked since the dialog was asked for is not silently replaced', () => {
  const { dialog } = wizard({ step: 0, version: null, gone: '2.0.0+0', devices: [board(WAITING)] });
  assert.match(textOf(one(dialog, 'div.notice.is-warn')), /^2\.0\.0\+0 has been revoked, so it cannot be deployed any more\./);
  assert.equal(all(dialog, 'input').every((input) => !input.checked), true);
  assert.equal(one(dialog, 'button', 'Next').disabled, true);
  assert.equal(textOf(one(dialog, 'span.dialog-hint')), 'Choose a release.');
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
  // It is called what it is, and the safe button does not offer to keep what is gone.
  assert.equal(textOf(one(withdrawn.dialog, 'h2')), 'Stop the boards that are installing 1.2.4+0?');
  assert.equal(textOf(one(withdrawn.dialog, 'button.is-danger')), 'Stop boards');
  assert.deepEqual(controls(withdrawn.dialog), ['Close', 'Close', 'Stop boards']);
  submit(withdrawn.dialog);
  assert.deepEqual(withdrawn.calls, [['submit', true]]);
  const refused = cancelling(WORLD.deployments[1], { error: error(409, 'cancel_refused', 'AWS did not accept.') });
  assert.match(textOf(one(refused.dialog, 'span.notice-said')), /^The boards were not stopped\. AWS did not accept\.$/);
});

test('a request on its way keeps the button and the keyboard, and is not sent twice', () => {
  const sending = cancelling(deployment(OFFERED, { executions: [execution(WAITING, 'waiting_for_button')] }),
    { sending: true });
  const go = one(sending.dialog, 'button.is-danger');
  assert.equal(go.disabled, false, 'a disabled button would lose the focus');
  assert.equal(go.getAttribute('aria-disabled'), 'true');
  submit(sending.dialog);
  assert.deepEqual(sending.calls, []);
  assert.equal(one(sending.dialog, 'form').hasAttribute('data-focus-home'), true);
});

test('a dialog whose session has ended says so, with the way on, and keeps what was typed', () => {
  const ended = new core.ApiError(401, 'unauthorized', 'Your session has ended. Sign in again to continue.');
  const signIn = [];
  const { dialog } = revoking(clientRelease('1.2.3+5'), {
    reason: 'Pads stop responding.', error: ended, signIn: () => signIn.push('sign in'),
  });
  assert.equal(textOf(one(dialog, 'span.notice-said')), 'Not revoked. Your session has ended. Sign in again to continue.');
  assert.doesNotMatch(textOf(one(dialog, 'div.dialog-error')), /unauthorized/);
  assert.equal(one(dialog, 'textarea').value, 'Pads stop responding.');
  click(one(dialog, 'button', 'Sign in again'));
  assert.deepEqual(signIn, ['sign in']);
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
  // The field can lie below what a small window shows; the button says what it waits for.
  assert.equal(textOf(one(empty.dialog, 'span.dialog-hint')), 'Give a reason first.');
  assert.equal(one(empty.dialog, 'button.is-danger').getAttribute('aria-describedby'),
    one(empty.dialog, 'span.dialog-hint').getAttribute('id'));
  submit(empty.dialog);
  assert.deepEqual(empty.calls, [], 'nothing is sent without a reason');

  const typed = revoking(active, { reason: 'x'.repeat(159) });
  assert.equal(all(typed.dialog, 'span.field-count').length, 0);
  assert.equal(one(typed.dialog, 'button.is-danger').disabled, false);
  assert.equal(all(typed.dialog, 'span.dialog-hint').length, 0);
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
  assert.equal(one(revoking(open, { sending: true }).dialog, 'button', 'Finishing…').getAttribute('aria-disabled'), 'true');
});

test('a dialog says that a request failed next to its buttons, outside the part that scrolls', () => {
  const failed = error(500, 'timeout', 'The server ran out of time. Try again in a moment.');
  const mark = { by: MANAGER, at: ago(1980), reason: REASON, enforcedAt: null };
  const dialogs = {
    deploying: (changes) => wizard({ devices: [board(WAITING)], ...changes }).dialog,
    cancelling: (changes) => cancelling(WORLD.deployments[1], changes).dialog,
    revoking: (changes) => revoking(clientRelease('1.2.3+5'), { reason: REASON, ...changes }).dialog,
    'revoking again': (changes) =>
      revoking({ ...clientRelease('2.0.0+0'), status: 'revoked', revoked: mark }, changes).dialog,
  };
  const parts = (dialog) => one(dialog, 'form').children.map((part) => part.getAttribute('class'));
  for (const [name, open] of Object.entries(dialogs)) {
    assert.deepEqual(parts(open()), ['dialog-head', 'dialog-body', 'dialog-foot'], name);
    // The body of a dialog scrolls. A message at its end would lie below what a small
    // window shows, and the button that was used would seem to have done nothing.
    const dialog = open({ error: failed });
    assert.deepEqual(parts(dialog), ['dialog-head', 'dialog-body', 'dialog-error', 'dialog-foot'], name);
    assert.equal(all(one(dialog, 'div.dialog-body'), 'div.notice').length, 0, name);
    assert.equal(textOf(one(one(dialog, 'div.dialog-error'), 'span.notice-said')),
      `It is not certain whether this went through. ${failed.message}`, name);
  }
});
