// Tests for the boards views: the list from the thing group and the shadows, and one
// board with its certificates and update history.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createTestConsole, fixture } from './fake-aws.mjs';

const BOARD_A = 'cranium-00000000000000aa';
const BOARD_B = 'cranium-00000000000000bb';
const BOARD_C = 'cranium-00000000000000cc';
const CERT_1 = `${'1a2b3c4d5e6f7081'}${'9'.repeat(48)}`;
const CERT_2 = `${'0f0e0d0c0b0a0908'}${'7'.repeat(48)}`;

const reported = (version = '1.0.0+3') => ({
  fw: { version, confirmed: true },
  ota: { state: 'idle', job: null, progress: 0, last: 'none', error: '' },
  wifi: { rssi: -61 },
  uptime: 4321,
});

function setup() {
  const console_ = createTestConsole();
  const viewer = console_.addUser('viewer', ['viewers']);
  const manager = console_.addUser('manager', ['release-managers']);
  const list = async () => (await console_.call('GET', '/api/devices', { as: viewer })).body;
  return { ...console_, viewer, manager, list };
}

const count = (fake, method) => fake.calls.filter((call) => call.method === method).length;

test('with no boards registered the list is empty', async () => {
  const { list, clock } = setup();
  assert.deepEqual(await list(), { devices: [], generatedAt: new Date(clock.ms).toISOString() });
});

test('boards are listed by name with what their shadows say', async () => {
  const context = setup();
  const { fake, clock } = context;
  fake.addThing(BOARD_C);
  fake.addThing(BOARD_A);
  fake.addThing(BOARD_B);
  fake.device(BOARD_A).report(reported());
  fake.device(BOARD_C).report({ ...reported('1.2.3+4'), wifi: { rssi: -80 }, uptime: 12 });
  const reportedAt = new Date(clock.ms).toISOString();
  context.advance(20_000);

  const body = await context.list();
  assert.equal(body.generatedAt, new Date(clock.ms).toISOString());
  assert.deepEqual(body.devices, [
    {
      thing: BOARD_A, online: true, lastSeen: reportedAt,
      fw: { version: '1.0.0+3', confirmed: true },
      ota: { state: 'idle', job: null, progress: 0, last: 'none', error: '' },
      rssi: -61, uptime: 4321,
    },
    // Registered, but it has never connected: there is no shadow.
    { thing: BOARD_B, online: false, lastSeen: null, fw: null, ota: null, rssi: null, uptime: null },
    {
      thing: BOARD_C, online: true, lastSeen: reportedAt,
      fw: { version: '1.2.3+4', confirmed: true },
      ota: { state: 'idle', job: null, progress: 0, last: 'none', error: '' },
      rssi: -80, uptime: 12,
    },
  ]);
});

test('a board goes offline 150 seconds after its last report', async () => {
  const context = setup();
  const { fake } = context;
  fake.addThing(BOARD_A);
  fake.device(BOARD_A).report(reported());
  const seen = (await context.list()).devices[0].lastSeen;

  context.advance(149_000);
  assert.equal((await context.list()).devices[0].online, true);
  context.advance(1000);
  let device = (await context.list()).devices[0];
  assert.equal(device.online, false);
  assert.equal(device.lastSeen, seen);
  assert.deepEqual(device.fw, { version: '1.0.0+3', confirmed: true });

  // It reports again: online, with the new time.
  context.advance(600_000);
  fake.device(BOARD_A).report({ uptime: 5 });
  device = (await context.list()).devices[0];
  assert.equal(device.online, true);
  assert.notEqual(device.lastSeen, seen);
  assert.equal(device.uptime, 5);
});

test('one shadow that cannot be read never fails the list', async () => {
  const context = setup();
  const { fake } = context;
  for (const thing of [BOARD_A, BOARD_B, BOARD_C]) {
    fake.addThing(thing);
    fake.device(thing).report(reported());
  }
  fake.failNext('getShadow');
  const response = await context.call('GET', '/api/devices', { as: context.viewer });
  assert.equal(response.status, 200);
  assert.equal(response.body.devices.length, 3);
  assert.equal(response.body.devices.filter((device) => device.online).length, 2);
  assert.equal(response.body.devices.filter((device) => device.fw === null).length, 1);
  assert.equal(context.logs.filter((line) => line.event === 'shadow_unreadable').length, 1);

  // A failed read is not remembered: the next request asks again.
  const again = await context.list();
  assert.equal(again.devices.filter((device) => device.online).length, 3);

  // The list itself failing is an error.
  context.advance(10_000);
  fake.failNext('listGroupThings');
  const failed = await context.call('GET', '/api/devices', { as: context.viewer });
  assert.equal(failed.status, 500);
});

test('a hostile shadow shows as little as it deserves', async () => {
  const context = setup();
  const { fake } = context;
  fake.addThing(BOARD_A);
  fake.addThing(BOARD_B);
  fake.device(BOARD_A).setRaw({
    state: { reported: {
      fw: { version: '<script>alert(1)</script>', confirmed: 'yes' },
      ota: { state: 'idle', job: '../../admin', progress: 9999, last: 'pwned', error: 'x'.repeat(5000) },
      wifi: { rssi: 'strong' },
      uptime: -1,
    } },
    metadata: { reported: { uptime: { timestamp: 'now' } } },
  });
  fake.device(BOARD_B).setRaw('not even an object');
  const body = await context.list();
  assert.deepEqual(body.devices, [
    {
      thing: BOARD_A, online: false, lastSeen: null, fw: null,
      ota: { state: 'idle', job: null, progress: 0, last: 'none', error: '' }, rssi: null, uptime: null,
    },
    { thing: BOARD_B, online: false, lastSeen: null, fw: null, ota: null, rssi: null, uptime: null },
  ]);
});

test('shadows are cached for five seconds', async () => {
  const context = setup();
  const { fake } = context;
  fake.addThing(BOARD_A);
  fake.addThing(BOARD_B);
  fake.device(BOARD_A).report(reported());

  await context.list();
  assert.equal(count(fake, 'getShadow'), 2);
  fake.device(BOARD_A).report({ uptime: 9999 });
  context.advance(4900);
  assert.equal((await context.list()).devices[0].uptime, 4321);
  assert.equal(count(fake, 'getShadow'), 2);
  // The group itself is read every time.
  assert.equal(count(fake, 'listGroupThings'), 2);

  context.advance(200);
  assert.equal((await context.list()).devices[0].uptime, 9999);
  assert.equal(count(fake, 'getShadow'), 4);
});

test('only things of the group with a board\'s name are listed', async () => {
  const context = setup();
  const { fake } = context;
  fake.addThing(BOARD_A);
  fake.addThing('cranium-00000000000000dd', { inGroup: false });
  fake.addThing('test-bench-rig');
  fake.addThing('cranium-UPPERCASE0000000');
  const body = await context.list();
  assert.deepEqual(body.devices.map((device) => device.thing), [BOARD_A]);
  // Nothing is asked about things that are not boards.
  assert.deepEqual(fake.calls.filter((call) => call.method === 'getShadow').map((call) => call.args[0]), [BOARD_A]);

  // A name that a listing repeats is one board.
  const original = fake.listGroupThings;
  fake.listGroupThings = async () => [BOARD_B, BOARD_A, BOARD_B, BOARD_A];
  context.advance(6000);
  const repeated = await context.list();
  fake.listGroupThings = original;
  assert.deepEqual(repeated.devices.map((device) => device.thing), [BOARD_A, BOARD_B]);
});

test('one board is shown with its certificates and update history', async () => {
  const context = setup();
  const { fake, viewer, manager } = context;
  fake.addThing(BOARD_A, { certificates: [CERT_1, CERT_2] });
  fake.device(BOARD_A).report(reported());

  const fresh = await context.call('GET', `/api/devices/${BOARD_A}`, { as: viewer });
  assert.equal(fresh.status, 200);
  assert.deepEqual(Object.keys(fresh.body).sort(), ['certificates', 'device', 'executions']);
  assert.equal(fresh.body.device.thing, BOARD_A);
  assert.equal(fresh.body.device.online, true);
  // The first 16 hex digits of each certificate id, and nothing else of the ARN.
  assert.deepEqual(fresh.body.certificates, ['0f0e0d0c0b0a0908', '1a2b3c4d5e6f7081']);
  assert.equal(JSON.stringify(fresh.body).includes('arn:'), false);
  assert.deepEqual(fresh.body.executions, []);

  // Two deployments and a job of another tool.
  await context.call('POST', '/api/firmware', { as: manager,
    body: { filename: 'zephyr.signed.bin', data: fixture('valid-1.2.3+4.signed.bin').toString('base64') } });
  const first = (await context.call('POST', '/api/deployments',
    { as: manager, body: { version: '1.2.3+4', things: [BOARD_A] } })).body.deployment.id;
  const queuedAt = new Date(context.clock.ms).toISOString();
  context.advance(60_000);
  fake.execution(first, BOARD_A).update('IN_PROGRESS', { step: 'downloading' });
  const startedAt = new Date(context.clock.ms).toISOString();
  context.advance(60_000);
  fake.execution(first, BOARD_A).update('FAILED', { reason: 'download_failed' });
  const failedAt = new Date(context.clock.ms).toISOString();
  context.advance(60_000);
  await fake.createJob({
    jobId: 'factory-test-7', things: [BOARD_A], document: '{}', description: 'not ours',
    urlExpiresInSec: 600, inProgressTimeoutMinutes: 30,
  });
  fake.execution('factory-test-7', BOARD_A).update('REJECTED', { reason: 'unsupported' });
  context.advance(60_000);
  const second = (await context.call('POST', '/api/deployments',
    { as: manager, body: { version: '1.2.3+4', things: [BOARD_A] } })).body.deployment.id;

  const shown = await context.call('GET', `/api/devices/${BOARD_A}`, { as: viewer });
  assert.deepEqual(shown.body.executions.map((entry) => [entry.deployment, entry.version, entry.status]), [
    [second, '1.2.3+4', 'QUEUED'],
    ['factory-test-7', null, 'REJECTED'],
    [first, '1.2.3+4', 'FAILED'],
  ]);
  assert.deepEqual(shown.body.executions[2], {
    deployment: first, version: '1.2.3+4', status: 'FAILED', queuedAt, startedAt, lastUpdatedAt: failedAt,
  });
  assert.equal(shown.body.executions[0].startedAt, null);
});

test('the history shows the 20 newest executions', async () => {
  const context = setup();
  const { fake, viewer } = context;
  fake.addThing(BOARD_A);
  for (let n = 0; n < 23; n += 1) {
    context.advance(60_000);
    const jobId = `cranium-1-0-${n}-b0-20261011T0000${String(n).padStart(2, '0')}Z-0000`;
    await fake.createJob({
      jobId, things: [BOARD_A], document: '{}', description: '{}', urlExpiresInSec: 600, inProgressTimeoutMinutes: 30,
    });
    fake.execution(jobId, BOARD_A).update('SUCCEEDED', { running: `1.0.${n}+0` });
  }
  const shown = await context.call('GET', `/api/devices/${BOARD_A}`, { as: viewer });
  assert.equal(shown.body.executions.length, 20);
  assert.deepEqual(shown.body.executions.map((entry) => entry.version),
    Array.from({ length: 20 }, (_, n) => `1.0.${22 - n}+0`));
});

test('a board that is not in the group does not exist for the console', async () => {
  const context = setup();
  const { fake, viewer } = context;
  fake.addThing(BOARD_A);
  fake.addThing(BOARD_B, { inGroup: false, certificates: [CERT_1] });
  fake.device(BOARD_B).report(reported());
  fake.calls.length = 0;

  for (const thing of [BOARD_B, BOARD_C]) {
    const response = await context.call('GET', `/api/devices/${thing}`, { as: viewer });
    assert.equal(response.status, 404, thing);
    assert.equal(response.body.error.code, 'unknown_device');
  }
  // Membership is checked before anything about the thing is read.
  const asked = fake.methodsCalled().filter((method) => !['getUser', 'listUserGroups'].includes(method));
  assert.deepEqual([...new Set(asked)], ['listGroupThings']);

  for (const text of ['cranium-00', 'CRANIUM-00000000000000AA', 'cranium-00000000000000aa%20', '*', '%2e%2e',
    'cranium-00000000000000aa%2Fshadow', `${BOARD_A}x`]) {
    const response = await context.call('GET', `/api/devices/${text}`, { as: viewer });
    assert.equal(response.status, 400, text);
    assert.equal(response.body.error.code, 'invalid_thing');
  }
  assert.equal((await context.call('GET', `/api/devices/${BOARD_A}/shadow`, { as: viewer })).status, 404);
  assert.equal((await context.call('POST', `/api/devices/${BOARD_A}`, { as: viewer, body: {} })).status, 404);
});
