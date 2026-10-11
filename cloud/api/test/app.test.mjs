// Tests for the request pipeline as a whole: routing, the shape of every response,
// what is logged, and the configuration the function starts with.

import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';

import { createApp } from '../src/app.mjs';
import { loadConfig } from '../src/config.mjs';
import { HttpError, describeError, errorCode, errorResponse, json } from '../src/http.mjs';
import {
  accessClaims, apiEvent, awsError, createFakeAws, createTestConsole, fakeEnv, fixture, manualTimers,
} from './fake-aws.mjs';

const BOARD = 'cranium-00000000000000aa';
const HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

function setup(options) {
  const console_ = createTestConsole(options);
  console_.fake.addThing(BOARD);
  const manager = console_.addUser('manager', ['release-managers']);
  const viewer = console_.addUser('viewer', ['viewers']);
  return { ...console_, manager, viewer };
}

/** Let everything that can go on without a timer or an answer from outside go on. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

/** A promise and the function that fulfils it. */
function deferred() {
  let resolve;
  const promise = new Promise((fulfil) => {
    resolve = fulfil;
  });
  return { promise, resolve };
}

const uploadBody = () => ({
  filename: 'zephyr.signed.bin',
  notes: 'a note that must never be logged',
  data: fixture('valid-1.2.3+4.signed.bin').toString('base64'),
});

test('every response is JSON that is never cached or sniffed', async () => {
  const context = setup();
  const { app, manager, viewer } = context;
  const events = [
    apiEvent('GET', '/api/devices', { claims: viewer.claims }),                      // 200
    apiEvent('POST', '/api/firmware', { claims: manager.claims, body: uploadBody() }), // 201
    apiEvent('POST', '/api/firmware', { claims: manager.claims, body: '{' }),          // 400
    apiEvent('GET', '/api/devices'),                                                   // 401
    apiEvent('POST', '/api/firmware', { claims: viewer.claims, body: uploadBody() }),  // 403
    apiEvent('GET', '/api/nowhere', { claims: viewer.claims }),                        // 404
    apiEvent('POST', '/api/firmware', { claims: manager.claims, body: uploadBody() }), // 409
    apiEvent('POST', '/api/firmware', { claims: manager.claims, body: 'x'.repeat(1_400_001) }), // 413
    apiEvent('POST', '/api/firmware', { claims: manager.claims, body: { filename: 'a', data: 'AAAA' } }), // 422
  ];
  const statuses = [];
  for (const event of events) {
    const response = await app(event);
    statuses.push(response.statusCode);
    assert.deepEqual(response.headers, HEADERS);
    assert.equal(response.isBase64Encoded, false);
    assert.equal(typeof response.body, 'string');
    assert.deepEqual(Object.keys(response).sort(), ['body', 'headers', 'isBase64Encoded', 'statusCode']);
    const body = JSON.parse(response.body);
    if (response.statusCode >= 400) {
      assert.deepEqual(Object.keys(body), ['error']);
      assert.deepEqual(Object.keys(body.error), ['code', 'message', 'requestId']);
      assert.match(body.error.code, /^[a-z][a-z0-9_]*$/);
      assert.ok(body.error.message.length > 5);
      assert.equal(body.error.requestId, event.requestContext.requestId);
    }
  }
  assert.deepEqual(statuses, [200, 201, 400, 401, 403, 404, 409, 413, 422]);

  context.fake.failNext('listGroupThings');
  const failed = await app(apiEvent('GET', '/api/devices', { claims: viewer.claims }));
  assert.equal(failed.statusCode, 500);
  assert.deepEqual(failed.headers, HEADERS);
  context.fake.failNext('listGroupThings', { code: 'throttled' });
  const throttled = await app(apiEvent('GET', '/api/devices', { claims: viewer.claims }));
  assert.equal(throttled.statusCode, 429);
  assert.deepEqual(throttled.headers, HEADERS);
  assert.equal(JSON.parse(throttled.body).error.code, 'throttled');
});

test('a server error says nothing about what went wrong inside', async () => {
  const context = setup();
  const { fake, viewer, logs } = context;
  const secretive = awsError('ListThingsInThingGroup', 'AccessDeniedException', { status: 403 });
  secretive.message = 'User: arn:aws:sts::999999999999:assumed-role/ApiFnRole/fn is not authorized on thinggroup/cranium-devices';
  const original = fake.listGroupThings;
  fake.listGroupThings = async () => {
    throw secretive;
  };
  const response = await context.call('GET', '/api/devices', { as: viewer, requestId: 'req-500' });
  fake.listGroupThings = original;

  assert.equal(response.status, 500);
  assert.deepEqual(response.body, {
    error: {
      code: 'internal_error',
      message: 'Something went wrong on the server. Quote the request id when you report this.',
      requestId: 'req-500',
    },
  });
  for (const hidden of ['arn:', '999999999999', 'AccessDenied', 'ApiFnRole', 'ListThings', 'stack', 'at ']) {
    assert.equal(JSON.stringify(response.body).includes(hidden), false, hidden);
  }
  // The details are in the log, under the same request id.
  const line = logs.find((entry) => entry.event === 'request_failed');
  assert.equal(line.requestId, 'req-500');
  assert.equal(line.level, 'error');
  assert.match(line.error.message, /not authorized/);
  assert.equal(line.error.operation, 'ListThingsInThingGroup');

  // The same for a plain bug.
  fake.listGroupThings = async () => {
    throw new TypeError("Cannot read properties of undefined (reading 'secretField')");
  };
  const bug = await context.call('GET', '/api/devices', { as: viewer });
  fake.listGroupThings = original;
  assert.equal(bug.status, 500);
  assert.equal(JSON.stringify(bug.body).includes('secretField'), false);
});

test('each request is logged once, without bodies, tokens or addresses', async () => {
  const context = setup();
  const { logs, manager, viewer, clock, fake } = context;
  fake.device(BOARD).report({ uptime: 1 });

  await context.call('GET', '/api/devices', { as: viewer, requestId: 'req-1' });
  assert.deepEqual(logs, [{
    requestId: 'req-1', sub: viewer.sub, method: 'GET', route: 'GET /api/devices', status: 200, duration: 0,
  }]);

  logs.length = 0;
  const secretQuery = { before: 'c2VjcmV0LWN1cnNvcg', limit: '5', token: 'query-string-secret' };
  await context.call('POST', '/api/firmware', { as: manager, body: uploadBody(), requestId: 'req-2' });
  await context.call('GET', `/api/devices/${BOARD}`, { as: viewer, requestId: 'req-3' });
  await context.call('GET', '/api/firmware/1.2.3+4', { as: viewer, requestId: 'req-4' });
  await context.call('GET', '/api/audit', { as: viewer, query: secretQuery, requestId: 'req-5' });
  await context.call('GET', '/api/secret-path-segment', { as: viewer, requestId: 'req-6' });
  await context.call('GET', '/api/devices', { requestId: 'req-7' });
  await context.call('POST', '/api/deployments', { as: viewer, body: { version: '1.2.3+4', things: [BOARD] }, requestId: 'req-8' });
  await context.call('TRACE', '/api/devices', { as: viewer, requestId: 'req-9' });

  assert.deepEqual(logs.map((line) => [line.requestId, line.sub, line.method, line.route, line.status]), [
    ['req-2', manager.sub, 'POST', 'POST /api/firmware', 201],
    ['req-3', viewer.sub, 'GET', 'GET /api/devices/{thing}', 200],
    ['req-4', viewer.sub, 'GET', 'GET /api/firmware/{version}', 200],
    ['req-5', viewer.sub, 'GET', 'GET /api/audit', 400],
    ['req-6', viewer.sub, 'GET', 'unmatched', 404],
    ['req-7', null, 'GET', 'GET /api/devices', 401],
    ['req-8', viewer.sub, 'POST', 'POST /api/deployments', 403],
    ['req-9', viewer.sub, 'OTHER', 'unmatched', 404],
  ]);
  for (const line of logs) {
    assert.deepEqual(Object.keys(line), ['requestId', 'sub', 'method', 'route', 'status', 'duration']);
    assert.equal(typeof line.duration, 'number');
  }
  const text = JSON.stringify(logs);
  for (const hidden of ['never be logged', uploadBody().data.slice(0, 40), 'query-string-secret', 'c2VjcmV0',
    'secret-path-segment', 'cognito:groups', 'token_use', manager.email, viewer.email, 'zephyr.signed.bin', BOARD]) {
    assert.equal(text.includes(hidden), false, hidden);
  }

  // The duration is measured with the injected clock.
  logs.length = 0;
  const original = fake.listGroupThings;
  fake.listGroupThings = async () => {
    clock.ms += 137;
    return original();
  };
  await context.call('GET', '/api/devices', { as: viewer });
  fake.listGroupThings = original;
  assert.equal(logs[0].duration, 137);
});

test('a write that runs out of time is answered and recorded, and goes no further', async () => {
  const timers = manualTimers();
  const context = setup({ timers });
  const { fake, manager, logs, clock } = context;
  assert.equal((await context.call('POST', '/api/firmware', { as: manager, body: uploadBody() })).status, 201);
  // A request that finishes in time leaves no timer behind.
  assert.deepEqual(timers.waiting(), []);

  // AWS does not answer the call that creates the job.
  const answer = deferred();
  const createJob = fake.createJob;
  fake.createJob = () => answer.promise;
  fake.calls.length = 0;
  logs.length = 0;
  const pending = context.call('POST', '/api/deployments',
    { as: manager, body: { version: '1.2.3+4', things: [BOARD] }, requestId: 'req-slow' });
  await settle();
  // The request has 16 of the function's 20 seconds.
  assert.deepEqual(timers.waiting(), [16000]);
  assert.equal(fake.auditLog().length, 1);

  clock.ms += 16000;
  timers.expire();
  const response = await pending;
  assert.equal(response.status, 500);
  assert.deepEqual(response.body, {
    error: {
      code: 'timeout',
      message: 'The server ran out of time. The change may have been made in part or in full: ' +
        'check the result before you repeat it.',
      requestId: 'req-slow',
    },
  });

  // One entry, with what was known when the time ran out.
  const entries = fake.auditLog();
  assert.equal(entries.length, 2);
  const entry = entries.at(-1);
  assert.deepEqual([entry.action, entry.outcome, entry.target, entry.requestId],
    ['deployment.create', 'error', '1.2.3+4', 'req-slow']);
  assert.deepEqual(entry.detail, { version: '1.2.3+4', things: '1', code: 'timeout' });
  assert.deepEqual(entry.actor, { sub: manager.sub, email: manager.email });
  // And the two log lines: what happened, and the line every request gets.
  assert.deepEqual(logs, [
    { level: 'error', event: 'request_timed_out', requestId: 'req-slow', budget: 16000 },
    { requestId: 'req-slow', sub: manager.sub, method: 'POST', route: 'POST /api/deployments', status: 500, duration: 16000 },
  ]);

  // AWS answers after all: the job exists. The request was given up, so nothing it
  // would have done next reaches AWS, and nothing more is written to the log.
  const sent = fake.calls.length;
  fake.createJob = createJob;
  answer.resolve({ ok: true });
  await settle();
  await settle();
  assert.equal(fake.calls.length, sent);
  assert.equal(fake.auditLog().length, 2);
  assert.ok(logs.slice(2).every((line) => line.level === 'warn'));
  assert.ok(logs.slice(2).every((line) => line.error.includes('the request had run out of time')));

  // The next request is served as usual.
  logs.length = 0;
  const next = await context.call('GET', '/api/deployments', { as: manager });
  assert.equal(next.status, 200);
  assert.deepEqual(timers.waiting(), []);
});

test('a read that runs out of time is answered and logged', async () => {
  const timers = manualTimers();
  const context = setup({ timers });
  const { fake, viewer, logs } = context;
  const listGroupThings = fake.listGroupThings;
  fake.listGroupThings = () => new Promise(() => {});
  const pending = context.call('GET', '/api/devices', { as: viewer, requestId: 'req-read' });
  await settle();
  timers.expire();
  const response = await pending;
  fake.listGroupThings = listGroupThings;

  assert.equal(response.status, 500);
  assert.deepEqual(response.headers, HEADERS);
  assert.deepEqual(response.body, {
    error: { code: 'timeout', message: 'The server ran out of time. Try again in a moment.', requestId: 'req-read' },
  });
  assert.deepEqual(logs.map((line) => [line.event ?? 'request', line.requestId, line.status ?? null]),
    [['request_timed_out', 'req-read', null], ['request', 'req-read', 500]]);
  assert.equal(fake.auditLog().length, 0);
});

test('the time a request has follows what Lambda has left', async () => {
  const timers = manualTimers();
  const context = setup({ timers });
  const { fake, viewer, manager } = context;
  const listGroupThings = fake.listGroupThings;
  fake.listGroupThings = () => new Promise(() => {});
  const budgetWith = async (invocation) => {
    const pending = context.call('GET', '/api/devices', { as: viewer, invocation });
    await settle();
    const [budget] = timers.waiting();
    timers.expire();
    await pending;
    return budget;
  };
  const left = (ms) => ({ getRemainingTimeInMillis: () => ms });
  // Four seconds are kept for the record; never more than 16 for the work.
  assert.equal(await budgetWith(left(20000)), 16000);
  assert.equal(await budgetWith(left(19850)), 15850);
  assert.equal(await budgetWith(left(9000)), 5000);
  assert.equal(await budgetWith(left(900000)), 16000);
  // Without usable word from Lambda: the fixed budget.
  for (const invocation of [undefined, null, {}, { getRemainingTimeInMillis: 5 }, left('soon'), left(NaN)]) {
    assert.equal(await budgetWith(invocation), 16000);
  }
  fake.listGroupThings = listGroupThings;

  // With no time left for the work it is not begun, and a write is still on record.
  fake.calls.length = 0;
  const late = await context.call('POST', '/api/deployments',
    { as: manager, body: { version: '1.2.3+4', things: [BOARD] }, invocation: left(3000) });
  assert.equal(late.status, 500);
  assert.equal(late.body.error.code, 'timeout');
  assert.deepEqual(fake.methodsCalled(), ['putAudit']);
  const entry = fake.auditLog().at(-1);
  assert.deepEqual([entry.action, entry.outcome, entry.target, entry.detail, entry.actor],
    ['deployment.create', 'error', '', { code: 'timeout' }, { sub: manager.sub, email: '' }]);
  assert.deepEqual(timers.waiting(), []);
});

test('a request that has run out of time cannot change anything afterwards', async () => {
  const timers = manualTimers();
  const context = setup({ timers });
  const { fake, manager } = context;
  assert.equal((await context.call('POST', '/api/firmware', { as: manager, body: uploadBody() })).status, 201);
  const created = await context.call('POST', '/api/deployments', { as: manager, body: { version: '1.2.3+4', things: [BOARD] } });
  const jobId = created.body.deployment.id;

  // Revoking: the mark is written, then the tag gets no answer.
  const answer = deferred();
  const tag = fake.tagFirmwareRevoked;
  fake.tagFirmwareRevoked = () => answer.promise;
  const pending = context.call('POST', '/api/firmware/1.2.3+4/revoke', { as: manager, body: { reason: 'bad build' } });
  await settle();
  timers.expire();
  const response = await pending;
  assert.equal(response.status, 500);
  assert.equal(response.body.error.code, 'timeout');
  const entry = fake.auditLog().at(-1);
  assert.deepEqual([entry.action, entry.outcome, entry.target, entry.detail],
    ['firmware.revoke', 'error', '1.2.3+4', { reason: 'bad build', code: 'timeout' }]);

  // The answer to the tag arrives late. The cancellation that would have followed is
  // not sent: the deployment is as it was, and the record says what is outstanding.
  fake.tagFirmwareRevoked = tag;
  answer.resolve({ ok: true });
  await settle();
  await settle();
  assert.equal(fake.jobs.get(jobId).status, 'IN_PROGRESS');
  assert.ok(!fake.methodsCalled().includes('cancelJob'));
  assert.ok(!fake.methodsCalled().includes('markRevocationEnforced'));
  const release = (await context.call('GET', '/api/firmware/1.2.3+4', { as: manager })).body.release;
  assert.deepEqual([release.status, release.revoked.enforcedAt], ['revoked', null]);

  // Revoking again completes it.
  const again = await context.call('POST', '/api/firmware/1.2.3+4/revoke', { as: manager, body: { reason: 'finish it' } });
  assert.equal(again.status, 200);
  assert.deepEqual(again.body.cancelled, [jobId]);
  assert.equal(fake.jobs.get(jobId).status, 'CANCELED');
  assert.ok(again.body.release.revoked.enforcedAt !== null);

  // Requests are told apart: one that ran out of time does not hold up another that
  // is under way at the same moment.
  const slow = deferred();
  const listGroupThings = fake.listGroupThings;
  let calls = 0;
  fake.listGroupThings = () => {
    calls += 1;
    return calls === 1 ? slow.promise : listGroupThings();
  };
  const first = context.call('GET', '/api/devices', { as: manager });
  await settle();
  timers.expire();
  assert.equal((await first).status, 500);
  const second = await context.call('GET', '/api/devices', { as: manager });
  fake.listGroupThings = listGroupThings;
  assert.equal(second.status, 200);
  assert.equal(second.body.devices.length, 1);
});

test('the request id comes from the gateway, or is made up if it is unusable', async () => {
  const context = setup();
  const { app, viewer, logs } = context;
  const send = async (requestId) => {
    const event = apiEvent('GET', '/api/nowhere', { claims: viewer.claims });
    if (requestId === undefined) delete event.requestContext.requestId;
    else event.requestContext.requestId = requestId;
    return JSON.parse((await app(event)).body).error.requestId;
  };
  assert.equal(await send('JKJaXmPLvHcESHA='), 'JKJaXmPLvHcESHA=');
  assert.equal(await send('c6af9ac6-7b61-11e6-9a41-93e8deadbeef'), 'c6af9ac6-7b61-11e6-9a41-93e8deadbeef');
  const made = [];
  for (const unusable of [undefined, null, '', 'has space', 'new\nline', 'x'.repeat(129), '<script>', 42, { id: 1 }]) {
    const id = await send(unusable);
    assert.match(id, /^[0-9a-f]{16}$/, String(unusable));
    made.push(id);
  }
  assert.equal(new Set(made).size, made.length);
  assert.ok(logs.every((line) => typeof line.requestId === 'string' && /^[A-Za-z0-9+/=_.:-]{1,128}$/.test(line.requestId)));

  // Even with a source of random numbers that does not deliver, there is a usable id.
  for (const broken of [() => '', () => 'not hex at all!', () => undefined, () => 'ABCDEF0123456789']) {
    const weak = createApp({ aws: context.fake, config: context.config, log: () => {}, randomHex: broken });
    const event = apiEvent('GET', '/api/nowhere', { claims: viewer.claims });
    delete event.requestContext.requestId;
    assert.match(JSON.parse((await weak(event)).body).error.requestId, /^[0-9a-f]{16}$/);
  }
});

test('only the listed routes exist', async () => {
  const context = setup();
  const { viewer, manager } = context;
  const get = (path) => context.call('GET', path, { as: viewer });
  for (const path of ['/api/me', '/api/devices', '/api/firmware', '/api/deployments', '/api/audit']) {
    assert.equal((await get(path)).status, 200, path);
  }
  for (const path of ['/', '/api', '/api/', '/api/devices/', '/api//devices', '/api/Devices', '/API/devices',
    '/api/devices/x/y', '/api/firmware/1.2.3+4/revoke', '/api/deployments/x/cancel', '/devices', '/api/me/extra',
    '/api/%64evices/../me', '/api/config', '/assets/app.js', '/api/devices%2F', `/${'a/'.repeat(300)}`]) {
    const response = await get(path);
    assert.equal(response.status, 404, path);
    assert.equal(response.body.error.code, 'not_found');
  }
  // Methods are matched exactly as HTTP spells them.
  for (const method of ['PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE', 'get', 'Post', '', 'GET ']) {
    for (const path of ['/api/firmware', '/api/deployments', `/api/devices/${BOARD}`, '/api/audit']) {
      const response = await context.call(method, path, { as: manager, body: {} });
      assert.equal(response.status, 404, `${method} ${path}`);
    }
  }
  // An empty path parameter is not a parameter.
  for (const [method, path] of [['GET', '/api/firmware/'], ['GET', '/api/deployments/'],
    ['POST', '/api/firmware//revoke'], ['POST', '/api/deployments//cancel']]) {
    const response = await context.call(method, path, { as: manager, body: { reason: 'x', force: true } });
    assert.equal(response.status, 404, `${method} ${path}`);
  }
  assert.equal(context.fake.auditLog().length, 0);
});

test('a path is understood whether or not the gateway decoded it', async () => {
  const context = setup();
  const { app, viewer, manager } = context;
  await context.call('POST', '/api/firmware', { as: manager, body: uploadBody() });

  for (const path of ['/api/firmware/1.2.3+4', '/api/firmware/1.2.3%2B4', '/api/firmware/1%2E2%2E3%2B4']) {
    const response = await context.call('GET', path, { as: viewer });
    assert.equal(response.status, 200, path);
  }
  // Encoded twice is not a version.
  assert.equal((await context.call('GET', '/api/firmware/1.2.3%252B4', { as: viewer })).status, 400);
  // An encoded slash never becomes a path separator.
  assert.equal((await context.call('GET', '/api%2Ffirmware', { as: viewer })).status, 404);
  assert.equal((await context.call('GET', '/api/firmware%2F1.2.3+4', { as: viewer })).status, 404);
  // Broken escapes match nothing.
  for (const path of ['/api/firmware/%', '/api/firmware/%zz', '/api/firmware/%e0%a4%a', '/api/%ff']) {
    assert.equal((await context.call('GET', path, { as: viewer })).status, 404, path);
  }

  // The path is taken from rawPath, or from the request context if that is missing.
  const event = apiEvent('GET', '/api/firmware', { claims: viewer.claims });
  delete event.rawPath;
  assert.equal((await app(event)).statusCode, 200);
  delete event.requestContext.http.path;
  assert.equal((await app(event)).statusCode, 404);
});

test('the handler answers anything that is handed to it', async () => {
  const { app } = setup();
  for (const event of [undefined, null, {}, 'GET /api/me', 42, [], { requestContext: null }, { rawPath: 7 },
    { rawPath: '/api/me', requestContext: { http: { method: {} }, authorizer: 'x' } }]) {
    const response = await app(event);
    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.headers, HEADERS);
    assert.equal(JSON.parse(response.body).error.code, 'unauthorized');
  }
});

test('createApp has working defaults and checks its arguments', async () => {
  assert.throws(() => createApp({ config: {} }), TypeError);
  assert.throws(() => createApp({ aws: {} }), TypeError);
  assert.throws(() => createApp({ aws: null, config: null }), TypeError);

  // With the defaults: the system clock, the system's random numbers, the console.
  const fake = createFakeAws();
  const config = loadConfig(fakeEnv());
  const sub = '11111111-2222-4333-8444-555555555555';
  fake.addUser({ sub, email: '', groups: ['viewers'] });
  const written = [];
  const originalLog = console.log;
  console.log = (line) => written.push(line);
  let response;
  try {
    const app = createApp({ aws: fake, config });
    const event = apiEvent('GET', '/api/devices', { claims: accessClaims({ sub, groups: ['viewers'] }) });
    delete event.requestContext.requestId;
    response = await app(event);
  } finally {
    console.log = originalLog;
  }
  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.ok(Math.abs(Date.parse(body.generatedAt) - Date.now()) < 5000);
  assert.equal(written.length, 1);
  const line = JSON.parse(written[0]);
  assert.match(line.requestId, /^[0-9a-f]{16}$/);
  assert.equal(line.route, 'GET /api/devices');

  // A clock that returns a Date is accepted as well.
  const dated = createApp({ aws: fake, config, now: () => new Date(Date.UTC(2030, 0, 1)), log: () => {} });
  const answer = await dated(apiEvent('GET', '/api/devices', { claims: accessClaims({ sub, groups: ['viewers'] }) }));
  assert.equal(JSON.parse(answer.body).generatedAt, '2030-01-01T00:00:00.000Z');
});

test('the configuration is complete or the function does not start', () => {
  const env = fakeEnv();
  const config = loadConfig(env);
  assert.equal(Object.isFrozen(config), true);
  assert.equal(config.region, 'us-east-1');
  assert.equal(config.userPoolClientId, 'localclient');
  assert.equal(config.slotSize, 933888);
  assert.equal(config.loadAddress, 0x30000);
  assert.equal(config.firmwareBucket, 'local-firmware');
  assert.match(config.signingKeyFingerprint, /^[0-9a-f]{64}$/);
  assert.equal(config.signingKey.key.type, 'public');
  assert.equal(config.signingKey.keyHash.toString('hex'), config.signingKeyFingerprint);

  for (const name of Object.keys(env)) {
    const without = { ...env };
    delete without[name];
    assert.throws(() => loadConfig(without), new RegExp(name), name);
    assert.throws(() => loadConfig({ ...env, [name]: '' }), new RegExp(name), name);
  }
  const malformed = {
    AWS_REGION: ['US-EAST-1', 'us-east-1/../x', 'us east 1', 'useast1'],
    FIRMWARE_BUCKET: ['Has-Capitals', 'a', 'has/slash', 'x'.repeat(64), 'has space'],
    PRESIGN_ROLE_ARN: ['presign-role', 'arn:aws:iam::12345:role/x', 'arn:aws:s3:::bucket', 'arn:aws:iam::000000000000:user/x'],
    USER_POOL_ID: ['us-east-1', 'pool id', '_x'],
    USER_POOL_CLIENT_ID: ['client id', 'x'.repeat(129), 'a-b'],
    THING_GROUP: ['cranium devices', 'x'.repeat(129), 'a/b'],
    STATE_TABLE: ['ab', 'has space', 'a/b'],
    AUDIT_TABLE: ['ab', 'has space'],
    SLOT_SIZE: ['0', '-5', '1.5', '0x1000', '933888 ', 'big', '99999999999'],
    LOAD_ADDRESS: ['-1', '0x30000', '1e5', '03', '99999999999'],
    SIGNING_PUBLIC_KEY_B64: ['not base64!', 'AAAA', Buffer.from('not a key').toString('base64'), `${env.SIGNING_PUBLIC_KEY_B64}\n`],
  };
  for (const [name, values] of Object.entries(malformed)) {
    for (const value of values) {
      assert.throws(() => loadConfig({ ...env, [name]: value }), Error, `${name}=${value}`);
    }
  }
  // A message about a bad variable names it and does not repeat its value.
  assert.throws(() => loadConfig({ ...env, USER_POOL_CLIENT_ID: 'secret value' }),
    (error) => error.message.includes('USER_POOL_CLIENT_ID') && !error.message.includes('secret value'));

  // Only an ECDSA P-256 public key is a signing key. Keys of another kind, and private
  // keys of any kind, stop the function from starting.
  const base64 = (key, type) => key.export({ type, format: 'der' }).toString('base64');
  const p256 = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const p384 = generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const ed25519 = generateKeyPairSync('ed25519');
  assert.equal(loadConfig({ ...env, SIGNING_PUBLIC_KEY_B64: base64(p256.publicKey, 'spki') }).signingKeyFingerprint,
    createHash('sha256').update(p256.publicKey.export({ type: 'spki', format: 'der' })).digest('hex'));
  for (const value of [base64(p384.publicKey, 'spki'), base64(rsa.publicKey, 'spki'), base64(ed25519.publicKey, 'spki'),
    base64(p256.privateKey, 'pkcs8'), base64(p256.privateKey, 'sec1'), base64(rsa.privateKey, 'pkcs8')]) {
    assert.throws(() => loadConfig({ ...env, SIGNING_PUBLIC_KEY_B64: value }), Error);
  }
  assert.equal(loadConfig({ ...env, LOAD_ADDRESS: '0' }).loadAddress, 0);
});

test('errors become responses in one place', () => {
  const refused = errorResponse(new HttpError(409, 'device_busy', 'Busy.', [{ thing: BOARD, deployment: 'x' }]), 'r1');
  assert.equal(refused.response.statusCode, 409);
  assert.equal(refused.internal, null);
  assert.deepEqual(JSON.parse(refused.response.body), {
    error: { code: 'device_busy', message: 'Busy.', requestId: 'r1', details: [{ thing: BOARD, deployment: 'x' }] },
  });
  assert.equal(errorCode(new HttpError(404, 'unknown_version', 'x')), 'unknown_version');
  assert.equal(errorCode(awsError('ListJobs', 'ThrottlingException', { code: 'throttled' })), 'throttled');
  for (const thrown of [new Error('x'), 'text', null, undefined, 7, { code: 'failed' }, awsError('ListJobs', 'X')]) {
    assert.equal(errorCode(thrown), 'internal_error');
    const { response, internal } = errorResponse(thrown, 'r2');
    assert.equal(response.statusCode, 500);
    assert.ok(internal !== null);
  }
  assert.equal(describeError(new Error('y'.repeat(1000))).message.length, 300);
  assert.deepEqual(describeError('just text'), { message: 'just text' });
  assert.deepEqual(json(200, { ok: true }), {
    statusCode: 200, headers: HEADERS, body: '{"ok":true}', isBase64Encoded: false,
  });
});
