// Tests for the activity log: one entry for every request that tries to change
// something, whatever becomes of it, and reading the log back a page at a time.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ACTIONS, OUTCOMES, auditDigest, auditItem, decodeCursor, encodeCursor, entryFromItem,
} from '../src/lib/audit.mjs';
import { compareAudit } from '../verify-audit.mjs';
import { createTestConsole, fixture, manualTimers } from './fake-aws.mjs';

const BOARD = 'cranium-00000000000000aa';
const NOW = Date.UTC(2026, 9, 10, 22, 15, 0);
const JOB = 'cranium-1-2-3-b4-20261010T221500Z-0000';

const image = () => fixture('valid-1.2.3+4.signed.bin').toString('base64');
const uploadBody = () => ({ filename: 'zephyr.signed.bin', data: image() });

/** A console with a board, a release manager and a viewer. */
function setup(options) {
  const console_ = createTestConsole(options);
  console_.fake.addThing(BOARD);
  const manager = console_.addUser('manager', ['release-managers']);
  const viewer = console_.addUser('viewer', ['viewers']);
  return { ...console_, manager, viewer };
}

/** The four write routes, each with a request that would succeed after `prepare`. */
function writes(context) {
  const { call, manager } = context;
  return [
    {
      action: 'firmware.upload',
      prepare: async () => {},
      send: (options) => call('POST', '/api/firmware', { body: uploadBody(), ...options }),
      target: '1.2.3+4',
    },
    {
      action: 'firmware.revoke',
      prepare: async () => {
        await call('POST', '/api/firmware', { as: manager, body: uploadBody() });
      },
      send: (options) => call('POST', '/api/firmware/1.2.3+4/revoke', { body: { reason: 'bad build' }, ...options }),
      target: '1.2.3+4',
    },
    {
      action: 'deployment.create',
      prepare: async () => {
        await call('POST', '/api/firmware', { as: manager, body: uploadBody() });
      },
      send: (options) => call('POST', '/api/deployments', { body: { version: '1.2.3+4', things: [BOARD] }, ...options }),
      target: null,   // the id of the new job
    },
    {
      action: 'deployment.cancel',
      prepare: async () => {
        await call('POST', '/api/firmware', { as: manager, body: uploadBody() });
        const created = await call('POST', '/api/deployments', { as: manager, body: { version: '1.2.3+4', things: [BOARD] } });
        context.jobId = created.body.deployment.id;
      },
      send: (options) => call('POST', `/api/deployments/${context.jobId}/cancel`, { body: { force: true }, ...options }),
      target: null,   // the id of the job
    },
  ];
}

test('an audit item carries who, what, when and how it ended', () => {
  const item = auditItem({
    at: NOW, requestId: 'JKJaXmPLvHcESHA=', actor: { sub: 'abc', email: 'someone' }, action: 'firmware.upload',
    target: '1.2.3+4', outcome: 'ok', detail: { filename: 'zephyr.signed.bin', size: 1264, forced: false },
  });
  assert.deepEqual(item, {
    sk: '2026-10-10T22:15:00.000Z#JKJaXmPLvHcESHA=',
    at: '2026-10-10T22:15:00.000Z',
    requestId: 'JKJaXmPLvHcESHA=',
    actor: { sub: 'abc', email: 'someone' },
    action: 'firmware.upload',
    target: '1.2.3+4',
    outcome: 'ok',
    detail: { filename: 'zephyr.signed.bin', size: '1264', forced: 'false' },
  });
  assert.deepEqual(entryFromItem({ ...item, pk: 'AUD' }), {
    at: '2026-10-10T22:15:00.000Z',
    actor: { sub: 'abc', email: 'someone' },
    action: 'firmware.upload',
    target: '1.2.3+4',
    outcome: 'ok',
    detail: { filename: 'zephyr.signed.bin', size: '1264', forced: 'false' },
    requestId: 'JKJaXmPLvHcESHA=',
  });
  assert.deepEqual(ACTIONS, ['firmware.upload', 'firmware.revoke', 'deployment.create', 'deployment.cancel']);
  assert.deepEqual(OUTCOMES, ['ok', 'rejected', 'denied', 'error']);
});

test('an audit item holds short, single-line text and nothing else', () => {
  const base = { at: NOW, requestId: 'r1', actor: { sub: 'abc', email: '' }, action: 'firmware.revoke', outcome: 'ok' };
  const item = auditItem({
    ...base,
    target: `line\nbreak\u0000${'x'.repeat(300)}`,
    actor: { sub: 'a\u202eb', email: 5 },
    detail: {
      reason: `tab\there ${'y'.repeat(400)}`,
      nested: { a: 1 },
      list: ['a'],
      nothing: null,
      'bad key': 'x',
      __proto__: 'x',
      Code: 'x',
      one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9',
    },
  });
  assert.equal(item.target.length, 128);
  assert.equal(item.target.startsWith('linebreakxxx'), true);
  assert.deepEqual(item.actor, { sub: 'ab', email: '' });
  assert.equal(item.detail.reason.length, 200);
  assert.equal(item.detail.reason.startsWith('tabhere yyy'), true);
  assert.deepEqual(Object.keys(item.detail), ['reason', 'one', 'two', 'three', 'four', 'five', 'six', 'seven']);
  assert.deepEqual(auditItem({ ...base, target: undefined, actor: null, detail: 'text' }).detail, {});

  assert.throws(() => auditItem({ ...base, target: '', action: 'firmware.delete' }), TypeError);
  assert.throws(() => auditItem({ ...base, target: '', outcome: 'fine' }), TypeError);
  for (const requestId of ['', 'has space', 'a#b', 'x'.repeat(129), null, undefined, 5]) {
    assert.throws(() => auditItem({ ...base, target: '', requestId }), TypeError);
  }
});

test('items that are not log entries are not shown', () => {
  const good = auditItem({
    at: NOW, requestId: 'r1', actor: { sub: 'abc', email: '' }, action: 'deployment.cancel', target: JOB,
    outcome: 'rejected', detail: { code: 'already_finished' },
  });
  assert.ok(entryFromItem(good));
  for (const item of [null, undefined, 'x', {}, { ...good, sk: 'yesterday#r1' }, { ...good, sk: 5 },
    { ...good, action: 'user.delete' }, { ...good, outcome: 'maybe' }, { ...good, sk: `${good.sk}#x y` }]) {
    assert.equal(entryFromItem(item), null);
  }
  // Time and request id come from the key, which cannot be rewritten.
  const edited = entryFromItem({ ...good, at: '1999-01-01T00:00:00.000Z', requestId: 'forged' });
  assert.equal(edited.at, '2026-10-10T22:15:00.000Z');
  assert.equal(edited.requestId, 'r1');
});

test('a cursor is opaque outside and checked when it comes back', () => {
  const sortKey = '2026-10-10T22:15:00.000Z#JKJaXmPLvHcESHA=';
  const cursor = encodeCursor(sortKey);
  assert.match(cursor, /^[A-Za-z0-9_-]+$/);
  assert.equal(decodeCursor(cursor), sortKey);

  const encode = (text) => Buffer.from(text, 'utf8').toString('base64url');
  const bad = [
    '', 'x', '!!!!', `${cursor}=`, `${cursor} `, cursor.slice(0, -1), `${cursor}A`, sortKey,
    Buffer.from(sortKey, 'utf8').toString('base64'),     // the other alphabet, with padding
    encode('AUD'), encode('2026-10-10#r1'), encode('2026-10-10T22:15:00.000Z'), encode('2026-10-10T22:15:00.000Z#'),
    encode('2026-10-10T22:15:00.000Z#has space'), encode(`${sortKey}\n`), encode('zzzz-10-10T22:15:00.000Z#r1'),
    encode(`2026-10-10T22:15:00.000Z#${'x'.repeat(129)}`), 'A'.repeat(401),
    null, undefined, 5, [cursor], { cursor },
  ];
  for (const value of bad) {
    assert.equal(decodeCursor(value), null, String(value).slice(0, 40));
  }
});

test('every write route records exactly one entry when it succeeds', async () => {
  for (const index of [0, 1, 2, 3]) {
    const context = setup();
    const { fake, manager, clock } = context;
    const write = writes(context)[index];
    await write.prepare();
    const before = fake.auditLog().length;
    context.advance(5000);

    const response = await write.send({ as: manager, requestId: 'request-under-test' });
    assert.ok(response.status === 200 || response.status === 201, `${write.action}: ${JSON.stringify(response.body)}`);
    const added = fake.auditLog().slice(before);
    assert.equal(added.length, 1, write.action);
    const [entry] = added;
    assert.equal(entry.sk, `${new Date(clock.ms).toISOString()}#request-under-test`);
    assert.equal(entry.pk, 'AUD');
    assert.equal(entry.at, new Date(clock.ms).toISOString());
    assert.equal(entry.requestId, 'request-under-test');
    assert.deepEqual(entry.actor, { sub: manager.sub, email: manager.email });
    assert.equal(entry.action, write.action);
    assert.equal(entry.outcome, 'ok');
    assert.equal(entry.target, write.target ?? context.jobId ?? response.body.deployment.id);
    assert.equal(Object.hasOwn(entry.detail, 'code'), false);
    for (const value of Object.values(entry.detail)) assert.equal(typeof value, 'string');
  }
});

test('every write route records exactly one entry when the caller is refused', async () => {
  const refusals = [
    // [who sends it, status, code, what the entry says about the actor]
    ['viewer', 403, 'release_manager_required'],
    ['outsider', 403, 'forbidden'],
    ['demoted', 403, 'release_manager_required'],
    ['disabled', 403, 'account_inactive'],
    ['anonymous', 401, 'unauthorized'],
    ['idtoken', 401, 'unauthorized'],
  ];
  for (const index of [0, 1, 2, 3]) {
    for (const [who, status, code] of refusals) {
      const context = setup();
      const { fake } = context;
      const write = writes(context)[index];
      await write.prepare();
      const stateBefore = JSON.stringify([[...fake.releases], [...fake.jobs.keys()], [...fake.objects.keys()],
        [...fake.jobs.values()].map((job) => job.status)]);
      const before = fake.auditLog().length;

      const users = {
        viewer: context.viewer,
        outsider: context.addUser('outsider', []),
        demoted: context.addUser('demoted', ['viewers'], { tokenGroups: ['release-managers'] }),
        disabled: context.addUser('disabled', ['release-managers'], { enabled: false }),
      };
      const options = who === 'anonymous' ? {}
        : who === 'idtoken' ? { claims: { sub: context.viewer.sub, token_use: 'id', aud: 'localclient' } }
          : { as: users[who] };
      const response = await write.send(options);
      assert.equal(response.status, status, `${write.action} as ${who}`);
      assert.equal(response.body.error.code, code);

      const added = fake.auditLog().slice(before);
      assert.equal(added.length, 1, `${write.action} as ${who}`);
      const [entry] = added;
      assert.equal(entry.action, write.action);
      assert.equal(entry.outcome, 'denied');
      assert.equal(entry.detail.code, code);
      if (who === 'anonymous') assert.deepEqual(entry.actor, { sub: '', email: '' });
      else if (who === 'idtoken') assert.deepEqual(entry.actor, { sub: context.viewer.sub, email: '' });
      else assert.deepEqual(entry.actor, { sub: users[who].sub, email: users[who].email });
      // A refused caller learns nothing and changes nothing.
      assert.equal(entry.target, '');
      assert.equal(JSON.stringify([[...fake.releases], [...fake.jobs.keys()], [...fake.objects.keys()],
        [...fake.jobs.values()].map((job) => job.status)]), stateBefore);
    }
  }
});

test('every write route records exactly one entry when the request is rejected', async () => {
  const context = setup();
  const { fake, manager, call } = context;
  await call('POST', '/api/firmware', { as: manager, body: uploadBody() });
  const created = await call('POST', '/api/deployments', { as: manager, body: { version: '1.2.3+4', things: [BOARD] } });
  const jobId = created.body.deployment.id;
  fake.execution(jobId, BOARD).update('REJECTED', { reason: 'declined' });

  const cases = [
    // [path, body, status, code, action, target]
    ['/api/firmware', '{', 400, 'invalid_json', 'firmware.upload', ''],
    ['/api/firmware', { filename: '../x', data: image() }, 400, 'invalid_filename', 'firmware.upload', ''],
    ['/api/firmware', { filename: 'a.bin', data: 'not base64' }, 400, 'invalid_data', 'firmware.upload', 'a.bin'],
    ['/api/firmware', 'x'.repeat(1_400_001), 413, 'payload_too_large', 'firmware.upload', ''],
    ['/api/firmware', { filename: 'a.bin', data: Buffer.from('not an image at all, just text......').toString('base64') },
      422, 'bad_magic', 'firmware.upload', 'a.bin'],
    ['/api/firmware', uploadBody(), 409, 'version_exists', 'firmware.upload', '1.2.3+4'],
    ['/api/firmware/1.2.3/revoke', { reason: 'x' }, 400, 'invalid_version', 'firmware.revoke', ''],
    ['/api/firmware/1.2.3+4/revoke', {}, 400, 'invalid_reason', 'firmware.revoke', '1.2.3+4'],
    ['/api/firmware/7.7.7+7/revoke', { reason: 'x' }, 404, 'unknown_version', 'firmware.revoke', '7.7.7+7'],
    ['/api/deployments', { version: 'latest', things: [BOARD] }, 400, 'invalid_version', 'deployment.create', ''],
    ['/api/deployments', { version: '1.2.3+4', things: [] }, 400, 'invalid_things', 'deployment.create', '1.2.3+4'],
    ['/api/deployments', { version: '7.7.7+7', things: [BOARD] }, 404, 'unknown_version', 'deployment.create', '7.7.7+7'],
    ['/api/deployments', { version: '1.2.3+4', things: ['cranium-00000000000000ff'] }, 422, 'unknown_device',
      'deployment.create', '1.2.3+4'],
    ['/api/deployments/not-a-job/cancel', { force: true }, 400, 'invalid_deployment', 'deployment.cancel', ''],
    [`/api/deployments/${jobId}/cancel`, { force: 'yes' }, 400, 'invalid_force', 'deployment.cancel', jobId],
    [`/api/deployments/${jobId}/cancel`, { force: true }, 409, 'already_finished', 'deployment.cancel', jobId],
    [`/api/deployments/${JOB}/cancel`, { force: true }, 404, 'unknown_deployment', 'deployment.cancel', JOB],
  ];
  for (const [path, body, status, code, action, target] of cases) {
    const before = fake.auditLog().length;
    context.advance(1000);
    const response = await call('POST', path, { as: manager, body });
    assert.equal(response.status, status, `${path} ${code}`);
    assert.equal(response.body.error.code, code);
    const added = fake.auditLog().slice(before);
    assert.equal(added.length, 1, `${path} ${code}`);
    assert.deepEqual([added[0].action, added[0].outcome, added[0].detail.code, added[0].target],
      [action, 'rejected', code, target]);
    assert.deepEqual(added[0].actor, { sub: manager.sub, email: manager.email });
  }
});

test('every write route records exactly one entry when the server fails', async () => {
  const failing = { 'firmware.upload': 'putFirmwareObject', 'firmware.revoke': 'markReleaseRevoked',
    'deployment.create': 'createJob', 'deployment.cancel': 'cancelJob' };
  for (const index of [0, 1, 2, 3]) {
    for (const [fault, status, code] of [[{}, 500, 'internal_error'], [{ code: 'throttled' }, 429, 'throttled']]) {
      const context = setup();
      const { fake, manager } = context;
      const write = writes(context)[index];
      await write.prepare();
      const before = fake.auditLog().length;
      fake.failNext(failing[write.action], fault);

      const response = await write.send({ as: manager });
      assert.equal(response.status, status, write.action);
      assert.equal(response.body.error.code, code);
      const added = fake.auditLog().slice(before);
      assert.equal(added.length, 1, write.action);
      assert.deepEqual([added[0].action, added[0].outcome, added[0].detail.code], [write.action, 'error', code]);
      assert.deepEqual(added[0].actor, { sub: manager.sub, email: manager.email });
    }
  }
});

test('every write route records exactly one entry when the request runs out of time', async () => {
  // The call each route makes to change something, and what is known when it is made.
  const hanging = {
    'firmware.upload': ['putFirmwareObject', '1.2.3+4'],
    'firmware.revoke': ['markReleaseRevoked', '1.2.3+4'],
    'deployment.create': ['createJob', '1.2.3+4'],
    'deployment.cancel': ['cancelJob', null],
  };
  for (const index of [0, 1, 2, 3]) {
    const timers = manualTimers();
    const context = setup({ timers });
    const { fake, manager } = context;
    const write = writes(context)[index];
    await write.prepare();
    const [method, target] = hanging[write.action];
    const before = fake.auditLog().length;
    const jobsBefore = [...fake.jobs.values()].map((job) => job.status).join();
    const original = fake[method];
    fake[method] = () => new Promise(() => {});

    const pending = write.send({ as: manager, requestId: 'request-out-of-time' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(timers.waiting(), [16000], write.action);
    timers.expire();
    const response = await pending;
    fake[method] = original;

    assert.equal(response.status, 500, write.action);
    assert.equal(response.body.error.code, 'timeout');
    assert.match(response.body.error.message, /check the result before you repeat it/);
    const added = fake.auditLog().slice(before);
    assert.equal(added.length, 1, write.action);
    const [entry] = added;
    assert.deepEqual([entry.action, entry.outcome, entry.detail.code, entry.requestId],
      [write.action, 'error', 'timeout', 'request-out-of-time']);
    assert.equal(entry.target, target ?? context.jobId);
    assert.deepEqual(entry.actor, { sub: manager.sub, email: manager.email });
    assert.equal([...fake.jobs.values()].map((job) => job.status).join(), jobsBefore);
    const line = context.logs.at(-1);
    assert.deepEqual([line.requestId, line.route.startsWith('POST /api/'), line.status], ['request-out-of-time', true, 500]);
  }
});

test('reading never writes to the log, and neither does an address that is no write route', async () => {
  const context = setup();
  const { fake, manager, viewer, call } = context;
  await call('POST', '/api/firmware', { as: manager, body: uploadBody() });
  const before = fake.auditLog().length;
  for (const path of ['/api/me', '/api/devices', `/api/devices/${BOARD}`, '/api/firmware', '/api/firmware/1.2.3+4',
    '/api/deployments', `/api/deployments/${JOB}`, '/api/audit', '/api/unknown']) {
    await call('GET', path, { as: viewer });
    await call('GET', path, {});
  }
  for (const [method, path] of [['POST', '/api/me'], ['POST', '/api/audit'], ['POST', '/api/devices'],
    ['DELETE', '/api/firmware'], ['PUT', '/api/firmware'], ['POST', '/api/firmware/1.2.3+4'],
    ['POST', '/api/firmware/1.2.3+4/revoke/now'], ['DELETE', `/api/deployments/${JOB}`], ['POST', '/api']]) {
    const response = await call(method, path, { as: manager, body: {} });
    assert.equal(response.status, 404, `${method} ${path}`);
  }
  assert.equal(fake.auditLog().length, before);
});

test('a change that could not be logged is reported as a failure', async () => {
  const context = setup();
  const { fake, manager, call } = context;

  fake.failNext('putAudit');
  const response = await call('POST', '/api/firmware', { as: manager, body: uploadBody() });
  assert.equal(response.status, 500);
  assert.equal(response.body.error.code, 'audit_failed');
  // The upload itself happened, and the message says so.
  assert.equal(fake.releases.size, 1);
  assert.match(response.body.error.message, /could not be written to the activity log/);
  assert.ok(context.logs.some((line) => line.event === 'audit_write_failed' && line.requestId === response.body.error.requestId));

  // For a request that failed anyway, the caller still gets its own error.
  fake.failNext('putAudit');
  const rejected = await call('POST', '/api/firmware', { as: manager, body: uploadBody() });
  assert.equal(rejected.status, 409);
  assert.equal(rejected.body.error.code, 'version_exists');
  assert.equal(fake.auditLog().length, 0);

  // An entry is never written over another one.
  context.advance(1000);
  const first = await call('POST', '/api/firmware/1.2.3+4/revoke', { as: manager, body: {}, requestId: 'same-id' });
  assert.equal(first.status, 400);
  const second = await call('POST', '/api/firmware/1.2.3+4/revoke', { as: manager, body: { reason: 'x' }, requestId: 'same-id' });
  assert.equal(second.status, 500);
  assert.equal(second.body.error.code, 'audit_failed');
  const kept = fake.auditLog();
  assert.equal(kept.length, 1);
  assert.equal(kept[0].outcome, 'rejected');
});

test('the log is read newest first, a page at a time', async () => {
  const context = setup();
  const { fake, viewer, manager, call } = context;
  const empty = await call('GET', '/api/audit', { as: viewer });
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body, { entries: [], next: null });

  // 120 refused cancellations, one second apart.
  for (let n = 0; n < 120; n += 1) {
    context.advance(1000);
    await call('POST', `/api/deployments/${JOB}/cancel`, { as: manager, body: { force: false }, requestId: `request-${n}` });
  }
  assert.equal(fake.auditLog().length, 120);

  const first = await call('GET', '/api/audit', { as: viewer });
  assert.equal(first.body.entries.length, 50);
  assert.equal(first.body.entries[0].requestId, 'request-119');
  assert.equal(first.body.entries[49].requestId, 'request-70');
  assert.equal(typeof first.body.next, 'string');
  assert.match(first.body.next, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(Object.keys(first.body.entries[0]).sort(),
    ['action', 'actor', 'at', 'detail', 'outcome', 'requestId', 'target']);

  // Follow the cursor to the end: every entry once, in order.
  const seen = [...first.body.entries];
  let next = first.body.next;
  let pages = 1;
  while (next !== null) {
    const page = await call('GET', '/api/audit', { as: viewer, query: { before: next } });
    assert.equal(page.status, 200);
    seen.push(...page.body.entries);
    next = page.body.next;
    pages += 1;
  }
  assert.equal(pages, 3);
  assert.deepEqual(seen.map((entry) => entry.requestId), Array.from({ length: 120 }, (_, n) => `request-${119 - n}`));
  const times = seen.map((entry) => entry.at);
  assert.deepEqual(times, [...times].sort().reverse());

  // Other page sizes; a full last page has no successor.
  const small = await call('GET', '/api/audit', { as: viewer, query: { limit: '7' } });
  assert.equal(small.body.entries.length, 7);
  const rest = await call('GET', '/api/audit', { as: viewer, query: { limit: '100', before: small.body.next } });
  assert.equal(rest.body.entries.length, 100);
  assert.equal(rest.body.entries[0].requestId, 'request-112');
  const last = await call('GET', '/api/audit', { as: viewer, query: { limit: '20', before: rest.body.next } });
  assert.equal(last.body.entries.length, 13);
  assert.equal(last.body.next, null);
  const exact = await call('GET', '/api/audit', { as: viewer, query: { limit: '13', before: rest.body.next } });
  assert.equal(exact.body.entries.length, 13);
  assert.equal(exact.body.next, null);

  // Never more than was asked for is read from the table.
  const asked = fake.calls.filter((entry) => entry.method === 'queryAudit').map((entry) => entry.args[0].limit);
  assert.ok(asked.every((limit) => limit <= 101));
});

test('the page size and the cursor are validated', async () => {
  const context = setup();
  const { fake, viewer, call } = context;
  for (const limit of ['0', '101', '-5', 'all', '1.5', '10,20', '']) {
    const response = await call('GET', '/api/audit', { as: viewer, query: { limit } });
    assert.equal(response.status, 400, limit);
    assert.equal(response.body.error.code, 'invalid_limit');
  }
  const cursor = encodeCursor('2026-10-10T22:15:00.000Z#r1');
  // Standard base64 of a key whose encoding needs padding: not the cursor alphabet.
  const padded = Buffer.from('2026-10-10T22:15:00.000Z#r').toString('base64');
  assert.ok(padded.endsWith('='));
  for (const before of ['', 'garbage!', `${cursor},${cursor}`, Buffer.from('AUD').toString('base64url'),
    padded, `${cursor}=`, '../../etc']) {
    const response = await call('GET', '/api/audit', { as: viewer, query: { before } });
    assert.equal(response.status, 400, before);
    assert.equal(response.body.error.code, 'invalid_cursor');
  }
  assert.equal(fake.calls.filter((entry) => entry.method === 'queryAudit').length, 0);

  // A well-formed cursor that points nowhere simply has nothing before it.
  const response = await call('GET', '/api/audit', { as: viewer, query: { before: cursor, limit: '5', other: 'ignored' } });
  assert.deepEqual(response.body, { entries: [], next: null });
  assert.deepEqual(fake.calls.at(-1).args[0], { before: '2026-10-10T22:15:00.000Z#r1', limit: 6 });
});

test('items in the table that are not entries are skipped, not shown', async () => {
  const context = setup();
  const { fake, viewer, call } = context;
  await fake.putAudit({ sk: '2026-10-10T22:15:01.000Z#r1', action: 'user.delete', outcome: 'ok', actor: {}, target: '', detail: {} });
  await fake.putAudit({ sk: 'not a key', action: 'firmware.upload', outcome: 'ok' });
  await fake.putAudit(auditItem({
    at: NOW, requestId: 'r2', actor: { sub: 'abc', email: '' }, action: 'firmware.upload', target: '1.2.3+4',
    outcome: 'ok', detail: {},
  }));
  const response = await call('GET', '/api/audit', { as: viewer });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.entries.map((entry) => entry.requestId), ['r2']);
});

test('the digest of an entry follows what is stored, in any order of its keys', () => {
  const item = auditItem({
    at: NOW,
    requestId: 'req-1',
    actor: { sub: 'sub-1', email: 'manager@example.org' },
    action: 'firmware.revoke',
    target: '1.2.3+4',
    outcome: 'ok',
    detail: { version: '1.2.3+4', reason: 'bad' },
  });
  const digest = auditDigest(item);
  assert.match(digest, /^[0-9a-f]{64}$/);

  // As the table gives it back: with the partition key, the keys in another order.
  const reordered = Object.fromEntries(Object.entries({ ...item, pk: 'AUD' }).reverse());
  reordered.actor = { email: item.actor.email, sub: item.actor.sub };
  reordered.detail = { reason: 'bad', version: '1.2.3+4' };
  assert.equal(auditDigest(reordered), digest);

  // Every field counts.
  for (const changed of [
    { outcome: 'denied' }, { target: '1.2.3+5' }, { action: 'firmware.upload' }, { at: 'x' }, { sk: 'x' }, { requestId: 'x' },
    { actor: { ...item.actor, sub: 'sub-2' } }, { actor: { ...item.actor, email: 'other@example.org' } },
    { detail: { ...item.detail, reason: 'fine' } }, { detail: { version: '1.2.3+4' } },
  ]) {
    assert.notEqual(auditDigest({ ...item, ...changed }), digest, JSON.stringify(changed));
  }
});

test('a digest is logged for a stored entry only, and says nothing about the request', async () => {
  const context = setup();
  const { fake, manager, logs, call } = context;
  const digests = () => logs.filter((line) => line.event === 'audit_entry');

  await call('POST', '/api/firmware', { as: manager, body: uploadBody(), requestId: 'req-ok' });
  assert.equal(digests().length, 1);
  const [stored] = fake.auditLog();
  assert.equal(digests()[0].digest, auditDigest(stored));
  const text = JSON.stringify(digests());
  for (const hidden of [manager.email, 'zephyr.signed.bin', '1.2.3+4', BOARD]) {
    assert.equal(text.includes(hidden), false, hidden);
  }

  // An entry that could not be stored has no digest, and the failure is logged instead.
  logs.length = 0;
  fake.failNext('putAudit');
  await call('POST', '/api/deployments', { as: manager, body: { version: '1.2.3+4', things: [BOARD] } });
  assert.deepEqual(digests(), []);
  assert.ok(logs.some((line) => line.event === 'audit_write_failed'));
});

test('the verifier finds a rewritten entry and a deleted one', async () => {
  const context = setup();
  const { fake, manager, viewer, logs, call } = context;
  await call('POST', '/api/firmware', { as: manager, body: uploadBody(), requestId: 'req-a' });
  await call('POST', '/api/firmware', { as: viewer, body: uploadBody(), requestId: 'req-b' });
  await call('POST', '/api/firmware/1.2.3+4/revoke', { as: manager, body: { reason: 'bad' }, requestId: 'req-c' });

  // As the two AWS CLI commands print them. Lambda puts a prefix before each line.
  const attribute = (value) => (typeof value === 'string'
    ? { S: value }
    : { M: Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, attribute(inner)])) });
  const asTable = (item) => attribute({ ...item, pk: 'AUD' }).M;
  const messages = logs.map((line) => `2026-10-31T17:00:00.000Z\tid\tINFO\t${JSON.stringify(line)}\n`);
  const items = fake.auditLog();
  const ids = (entries) => entries.map((entry) => entry.requestId);
  assert.deepEqual(ids(items).sort(), ['req-a', 'req-b', 'req-c']);

  const clean = compareAudit(items.map(asTable), messages);
  assert.deepEqual([clean.verified.sort(), clean.changed, clean.missing, clean.noLine],
    [['req-a', 'req-b', 'req-c'], [], [], []]);

  // Somebody makes the refused request look like it never was one, and removes the
  // revocation from the record.
  const tampered = items.filter((item) => item.requestId !== 'req-c').map((item) => (
    item.requestId === 'req-b' ? { ...item, outcome: 'ok' } : item));
  const found = compareAudit(tampered.map(asTable), messages);
  assert.deepEqual([found.verified, found.changed, found.missing, found.noLine],
    [['req-a'], ['req-b'], ['req-c'], []]);

  // An entry older than the log is no alarm.
  const aged = compareAudit(items.map(asTable), []);
  assert.deepEqual([aged.verified, aged.changed, aged.missing, aged.noLine.sort()],
    [[], [], [], ['req-a', 'req-b', 'req-c']]);

  // Lines that are something else are passed over.
  const noise = compareAudit([], ['START RequestId: x', '{not json', '{"event":"other"}', 'a { b']);
  assert.deepEqual(noise, { verified: [], changed: [], missing: [], noLine: [], unlogged: [] });

  // A request logs one digest. A rewritten entry with a second line for the new digest is
  // still a rewritten entry, in whichever order the lines come.
  const rewritten = { ...items[0], outcome: 'denied' };
  const second = JSON.stringify({ event: 'audit_entry', requestId: items[0].requestId, digest: auditDigest(rewritten) });
  for (const log of [[...messages, second], [second, ...messages]]) {
    const twice = compareAudit([rewritten, ...items.slice(1)].map(asTable), log);
    assert.deepEqual(twice.changed, [items[0].requestId]);
    assert.equal(twice.verified.includes(items[0].requestId), false);
  }
  // The same line twice is one digest, and no alarm.
  const own = messages.find((message) => message.includes(items[0].requestId));
  assert.deepEqual(compareAudit([items[0]].map(asTable), [own, own]).verified, [items[0].requestId]);

  // With no line: older than the first line in the log it cannot be compared, and younger
  // it should have one. A forged entry carries today's date and no line.
  const at = (item) => Date.parse(item.sk.split('#')[0]);
  const before = compareAudit([items[0]].map(asTable), [], { logStart: at(items[0]) + 1 });
  assert.deepEqual([before.noLine, before.unlogged], [[items[0].requestId], []]);
  const after = compareAudit([items[0]].map(asTable), [], { logStart: at(items[0]) - 1 });
  assert.deepEqual([after.noLine, after.unlogged], [[], [items[0].requestId]]);
});

test('verify-audit.mjs says what it found, and its exit status says whether to look', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'cranium-verify-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const entry = (requestId, at) => auditItem({
    at, requestId, actor: { sub: 'a', email: 'a@example.invalid' }, action: 'firmware.revoke', target: '1.0.0+1', outcome: 'ok', detail: {},
  });
  const dynamo = (item) => ({
    pk: { S: 'AUD' },
    ...Object.fromEntries(Object.entries(item).map(([key, value]) => [key, typeof value === 'string'
      ? { S: value }
      : { M: Object.fromEntries(Object.entries(value).map(([name, text]) => [name, { S: text }])) }])),
  });
  const lineOf = (item, timestamp, digest = auditDigest(item)) => ({
    timestamp, message: JSON.stringify({ event: 'audit_entry', requestId: item.requestId, digest }),
  });
  const run = (items, events) => {
    const [audit, log] = [join(directory, 'audit.json'), join(directory, 'digests.json')];
    writeFileSync(audit, JSON.stringify({ Items: items.map(dynamo) }));
    writeFileSync(log, JSON.stringify({ events }));
    return spawnSync(process.execPath, [fileURLToPath(new URL('../verify-audit.mjs', import.meta.url)), audit, log], { encoding: 'utf8' });
  };

  const first = entry('req-first', 1000);
  const good = run([first], [lineOf(first, 1000)]);
  assert.equal(good.status, 0, good.stderr);
  assert.match(good.stdout, /^1 entries match their digest, 0 do not, 0 are missing, 0 should have a line and have none\. 0 are older/);

  const forged = entry('req-forged', 5000);
  const flagged = run([first, forged], [lineOf(first, 1000)]);
  assert.equal(flagged.status, 1);
  assert.match(flagged.stdout, /^UNLOGGED req-forged: /m);

  const old = entry('req-old', 500);
  assert.equal(run([old, first], [lineOf(first, 1000)]).status, 0, 'older than the log');
  assert.equal(run([first], [lineOf(first, 1000), lineOf(first, 1001, 'f'.repeat(64))]).status, 1, 'two digests for one request');
  // Nothing in it says who: a request id is all that is printed.
  assert.doesNotMatch(flagged.stdout, /example\.invalid/);
  // Files that hold nothing compared nothing, which is not a clean result.
  for (const [items, events] of [[[], []], [[first], []], [[], [lineOf(first, 1000)]]]) {
    const nothing = run(items, events);
    assert.equal(nothing.status, 2);
    assert.match(nothing.stderr, /nothing to compare/);
  }
});
