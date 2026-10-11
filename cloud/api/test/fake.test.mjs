// Tests for the in-memory adapter itself. The other tests and the local preview rely
// on it behaving like the services behind src/aws.mjs, so its own rules are pinned
// down here: shadows, job and execution state, write-once and conditional writes, and
// the limits AWS puts on what it is sent.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { accessClaims, apiEvent, createFakeAws, fakeEnv, fixture } from './fake-aws.mjs';

const THING = 'cranium-00000000000000aa';
const OTHER = 'cranium-00000000000000bb';
const JOB = 'cranium-1-2-3-b4-20261010T221500Z-9f3a';
const T0 = Date.UTC(2026, 9, 10, 22, 15, 0);

function setup(options = {}) {
  const clock = { ms: T0 };
  const fake = createFakeAws({ now: () => clock.ms, ...options });
  fake.addThing(THING);
  fake.addThing(OTHER);
  const job = (extra = {}) => ({
    jobId: JOB, things: [THING, OTHER], document: '{"op":"fw_update"}', description: 'a job', urlExpiresInSec: 600,
    inProgressTimeoutMinutes: 30, ...extra,
  });
  return { fake, clock, job };
}

const refused = (operation) => (error) => error.name === 'AwsError' && error.code === 'failed' &&
  error.awsError === 'InvalidRequestException' && error.operation === operation;

test('it starts empty', async () => {
  const fake = createFakeAws();
  assert.deepEqual(await fake.listGroupThings(), []);
  assert.deepEqual(await fake.listJobs(), []);
  assert.deepEqual(await fake.listReleases(), []);
  assert.deepEqual(await fake.queryAudit({ before: null, limit: 10 }), []);
  assert.equal(await fake.getUser('anyone'), null);
  assert.deepEqual(await fake.listUserGroups('anyone'), []);
  assert.equal(await fake.getShadow(THING), null);
  assert.equal(fake.objects.size, 0);
  assert.equal(fake.highestRegistered(), null);
});

test('a shadow update merges, deletes on null and stamps what it touched', async () => {
  const { fake, clock } = setup();
  const board = fake.device(THING);
  board.report({ fw: { version: '1.0.0+3', confirmed: true }, ota: { state: 'awaiting_user', job: JOB, progress: 0 }, uptime: 60 });
  clock.ms += 30_000;
  board.report({ ota: { state: 'idle', job: null, progress: 10 } });

  const shadow = await fake.getShadow(THING);
  assert.deepEqual(shadow.state.reported, {
    fw: { version: '1.0.0+3', confirmed: true },
    ota: { state: 'idle', progress: 10 },   // the job key is gone, as in AWS IoT
    uptime: 90,
  });
  const first = Math.floor(T0 / 1000);
  assert.deepEqual(shadow.metadata.reported, {
    fw: { version: { timestamp: first }, confirmed: { timestamp: first } },
    ota: { state: { timestamp: first + 30 }, progress: { timestamp: first + 30 } },
    uptime: { timestamp: first + 30 },
  });
  assert.equal(shadow.version, 2);
  assert.equal(shadow.timestamp, first + 30);

  // What is read is a copy.
  shadow.state.reported.fw.version = 'changed';
  assert.equal((await fake.getShadow(THING)).state.reported.fw.version, '1.0.0+3');

  // The uptime runs on from the value the board gave last.
  clock.ms += 5000;
  board.report({ uptime: 2 });
  clock.ms += 7000;
  board.report({ wifi: { rssi: -40 } });
  assert.equal((await fake.getShadow(THING)).state.reported.uptime, 9);

  board.setRaw('anything at all');
  assert.equal(await fake.getShadow(THING), 'anything at all');
  board.report({ uptime: 1 });
  assert.deepEqual((await fake.getShadow(THING)).state.reported, { uptime: 1 });
  board.clear();
  assert.equal(await fake.getShadow(THING), null);
  assert.throws(() => fake.device('cranium-00000000000000ff'), TypeError);
});

test('a job starts in progress with every board queued', async () => {
  const { fake, job } = setup();
  assert.deepEqual(await fake.createJob(job()), { ok: true });
  assert.deepEqual(await fake.createJob(job()), { ok: false, reason: 'exists' });
  assert.deepEqual(await fake.createJob(job({ jobId: 'other', things: ['cranium-00000000000000ff'] })),
    { ok: false, reason: 'target_not_found' });

  assert.deepEqual(await fake.describeJob(JOB), {
    jobId: JOB, status: 'IN_PROGRESS', description: 'a job', things: [THING, OTHER], createdAt: T0, lastUpdatedAt: T0,
    completedAt: null, forceCanceled: false, reasonCode: null,
    counts: { queued: 2, inProgress: 0, succeeded: 0, failed: 0, rejected: 0, canceled: 0, timedOut: 0, removed: 0 },
  });
  assert.deepEqual(await fake.listJobExecutionsForJob(JOB), [THING, OTHER].map((thing) => ({
    thing, status: 'QUEUED', queuedAt: T0, startedAt: null, lastUpdatedAt: T0, executionNumber: 1,
  })));
  assert.deepEqual(await fake.listJobExecutionsForThing(THING),
    [{ jobId: JOB, status: 'QUEUED', queuedAt: T0, startedAt: null, lastUpdatedAt: T0, executionNumber: 1 }]);
  assert.deepEqual(await fake.listJobExecutionsForThing('cranium-00000000000000ff'), []);
  assert.equal(await fake.describeJob('unknown'), null);
  assert.deepEqual(await fake.listJobExecutionsForJob('unknown'), []);
  assert.equal(await fake.describeJobExecution(JOB, 'cranium-00000000000000ff'), null);
});

test('a board is handed the job in progress first, then the one queued longest', async () => {
  const { fake, clock, job } = setup();
  assert.equal(fake.device(THING).nextJob(), null);
  await fake.createJob(job({ jobId: 'first', document: '{"n":1}' }));
  clock.ms += 1000;
  await fake.createJob(job({ jobId: 'second', document: '{"n":2}' }));
  assert.deepEqual(fake.device(THING).nextJob(), { jobId: 'first', status: 'QUEUED', document: { n: 1 } });

  fake.execution('second', THING).update('IN_PROGRESS', { step: 'downloading' });
  assert.deepEqual(fake.device(THING).nextJob(), { jobId: 'second', status: 'IN_PROGRESS', document: { n: 2 } });
  fake.execution('second', THING).update('SUCCEEDED');
  assert.equal(fake.device(THING).nextJob().jobId, 'first');
  // The other board has its own executions of the same jobs.
  assert.equal(fake.device(OTHER).nextJob().jobId, 'first');

  await fake.cancelJob({ jobId: 'first', force: false, reasonCode: 'X', comment: 'who' });
  assert.equal(fake.device(THING).nextJob(), null);
  assert.equal(fake.device(OTHER).nextJob().jobId, 'second');
});

test('a board moves its execution forward and never back', async () => {
  const { fake, clock, job } = setup();
  await fake.createJob(job());
  const execution = fake.execution(JOB, THING);

  clock.ms += 1000;
  assert.deepEqual(execution.update('IN_PROGRESS', { step: 'downloading' }), { accepted: true });
  clock.ms += 1000;
  assert.deepEqual(await fake.describeJobExecution(JOB, THING), {
    thing: THING, status: 'IN_PROGRESS', queuedAt: T0, startedAt: T0 + 1000, lastUpdatedAt: T0 + 1000,
    executionNumber: 1, statusDetails: { step: 'downloading' }, secondsLeft: 1799, forceCanceled: false,
  });
  // The details are replaced when given and kept when not.
  assert.deepEqual(execution.update('IN_PROGRESS'), { accepted: true });
  assert.deepEqual((await fake.describeJobExecution(JOB, THING)).statusDetails, { step: 'downloading' });
  assert.deepEqual(execution.update('IN_PROGRESS', { step: 'rebooting' }), { accepted: true });
  assert.deepEqual(execution.update('SUCCEEDED', { running: '1.2.3+4' }), { accepted: true });
  assert.deepEqual((await fake.describeJobExecution(JOB, THING)).statusDetails, { running: '1.2.3+4' });
  assert.equal((await fake.describeJobExecution(JOB, THING)).secondsLeft, null);
  assert.equal((await fake.describeJobExecution(JOB, THING)).startedAt, T0 + 1000);

  // Finished is final.
  for (const status of ['IN_PROGRESS', 'FAILED', 'REJECTED', 'SUCCEEDED']) {
    assert.deepEqual(execution.update(status, { reason: 'x' }), { accepted: false, code: 'InvalidStateTransition' });
  }
  // A board cannot set what only AWS sets, and cannot touch what is not its own.
  for (const status of ['QUEUED', 'CANCELED', 'TIMED_OUT', 'REMOVED', 'DONE', undefined]) {
    assert.deepEqual(fake.execution(JOB, OTHER).update(status), { accepted: false, code: 'InvalidRequest' });
  }
  assert.deepEqual(fake.execution(JOB, 'cranium-00000000000000ff').update('IN_PROGRESS'), { accepted: false, code: 'ResourceNotFound' });
  assert.deepEqual(fake.execution('unknown', THING).update('IN_PROGRESS'), { accepted: false, code: 'ResourceNotFound' });
  assert.equal(fake.execution('unknown', THING).get(), null);

  // statusDetails are short strings without control characters, ten pairs at most.
  const other = fake.execution(JOB, OTHER);
  for (const details of [{ progress: 40 }, { detail: '' }, { detail: 'two\nlines' }, { 'bad key': 'x' }, { detail: 'x'.repeat(1025) },
    Object.fromEntries(Array.from({ length: 11 }, (_, n) => [`k${n}`, 'v'])), 'text', null]) {
    assert.deepEqual(other.update('IN_PROGRESS', details), { accepted: false, code: 'InvalidRequest' });
  }
  assert.equal(other.get().status, 'QUEUED');

  // A snapshot job is complete when all its executions have ended.
  assert.equal((await fake.describeJob(JOB)).status, 'IN_PROGRESS');
  clock.ms += 1000;
  assert.deepEqual(other.update('REJECTED', { reason: 'declined' }), { accepted: true });
  const done = await fake.describeJob(JOB);
  assert.equal(done.status, 'COMPLETED');
  assert.equal(done.completedAt, clock.ms);
  assert.deepEqual(done.counts, { queued: 0, inProgress: 0, succeeded: 1, failed: 0, rejected: 1, canceled: 0, timedOut: 0, removed: 0 });
});

test('an execution in progress times out after the job\'s timeout', async () => {
  const { fake, clock, job } = setup();
  await fake.createJob(job({ inProgressTimeoutMinutes: 1 }));
  fake.execution(JOB, THING).update('IN_PROGRESS', { step: 'downloading' });
  clock.ms += 59_000;
  assert.equal((await fake.describeJobExecution(JOB, THING)).secondsLeft, 1);
  clock.ms += 1000;
  const timedOut = await fake.describeJobExecution(JOB, THING);
  assert.deepEqual([timedOut.status, timedOut.secondsLeft, timedOut.lastUpdatedAt], ['TIMED_OUT', null, T0 + 60_000]);
  assert.deepEqual(fake.execution(JOB, THING).update('SUCCEEDED'), { accepted: false, code: 'InvalidStateTransition' });
  // A queued execution has no timer.
  clock.ms += 86_400_000;
  assert.equal((await fake.describeJobExecution(JOB, OTHER)).status, 'QUEUED');
});

test('cancelling reaches queued boards, and boards at work only with force', async () => {
  const { fake, clock, job } = setup();
  await fake.createJob(job());
  fake.execution(JOB, OTHER).update('IN_PROGRESS', { step: 'downloading' });
  clock.ms += 5000;

  const cancel = (force) => fake.cancelJob({ jobId: JOB, force, reasonCode: 'CONSOLE_CANCEL', comment: 'who' });
  assert.deepEqual(await cancel(false), { ok: true });
  let described = await fake.describeJob(JOB);
  assert.deepEqual([described.status, described.forceCanceled, described.reasonCode, described.completedAt],
    ['CANCELED', false, 'CONSOLE_CANCEL', null]);
  assert.deepEqual([described.counts.canceled, described.counts.inProgress], [1, 1]);
  assert.equal(fake.execution(JOB, THING).get().status, 'CANCELED');
  assert.equal(fake.execution(JOB, OTHER).get().status, 'IN_PROGRESS');

  // Nothing more to do without force; with force the board at work is stopped.
  assert.deepEqual(await cancel(false), { ok: false, reason: 'refused', detail: 'job is CANCELED' });
  assert.deepEqual(await cancel(true), { ok: true });
  described = await fake.describeJob(JOB);
  assert.deepEqual([described.status, described.forceCanceled, described.counts.canceled], ['CANCELED', true, 2]);
  assert.equal((await fake.describeJobExecution(JOB, OTHER)).forceCanceled, true);
  assert.deepEqual(await cancel(true), { ok: false, reason: 'refused', detail: 'job is CANCELED' });
  // A cancelled job stays cancelled.
  assert.equal((await fake.describeJob(JOB)).status, 'CANCELED');

  assert.deepEqual(await fake.cancelJob({ jobId: 'unknown', force: true, reasonCode: 'X', comment: 'who' }),
    { ok: false, reason: 'not_found' });
  await fake.createJob(job({ jobId: 'finished', things: [THING] }));
  fake.execution('finished', THING).update('SUCCEEDED');
  assert.deepEqual(await fake.cancelJob({ jobId: 'finished', force: true, reasonCode: 'X', comment: 'who' }),
    { ok: false, reason: 'refused', detail: 'job is COMPLETED' });
});

test('executions appear only after the rollout delay', async () => {
  const { fake, clock, job } = setup({ rolloutDelayMs: 3000 });
  await fake.createJob(job());
  assert.deepEqual(await fake.listJobExecutionsForJob(JOB), []);
  assert.deepEqual((await fake.describeJob(JOB)).counts.queued, 0);
  assert.equal((await fake.describeJob(JOB)).status, 'IN_PROGRESS');
  assert.deepEqual(fake.execution(JOB, THING).update('IN_PROGRESS'), { accepted: false, code: 'ResourceNotFound' });
  clock.ms += 3000;
  assert.equal((await fake.listJobExecutionsForJob(JOB)).length, 2);
  assert.equal((await fake.listJobExecutionsForJob(JOB))[0].queuedAt, T0 + 3000);

  // A job cancelled before its rollout never gets executions.
  await fake.createJob(job({ jobId: 'early' }));
  await fake.cancelJob({ jobId: 'early', force: false, reasonCode: 'X', comment: 'who' });
  clock.ms += 10_000;
  assert.deepEqual(await fake.listJobExecutionsForJob('early'), []);
  assert.equal((await fake.describeJob('early')).status, 'CANCELED');
});

test('it refuses what AWS IoT would refuse', async () => {
  const { fake, job } = setup();
  const bad = [
    { jobId: 'has space' }, { jobId: 'x'.repeat(65) }, { jobId: '' }, { jobId: 'cranium-1.2.3+4' },
    { things: [] }, { things: ['has space'] }, { things: 'cranium-00000000000000aa' },
    { document: 'not json' }, { document: `"${'x'.repeat(32768)}"` }, { document: { op: 'fw_update' } },
    { description: '' }, { description: 'two\nlines' }, { description: 'bell\u0007' }, { description: 'x'.repeat(2029) },
    { description: 'zero\u200bwidth' }, { description: undefined },
    { urlExpiresInSec: 59 }, { urlExpiresInSec: 3601 }, { urlExpiresInSec: '600' }, { urlExpiresInSec: undefined },
    { inProgressTimeoutMinutes: 0 }, { inProgressTimeoutMinutes: 10081 }, { inProgressTimeoutMinutes: 1.5 },
  ];
  for (const change of bad) {
    await assert.rejects(fake.createJob(job(change)), refused('CreateJob'), JSON.stringify(change).slice(0, 60));
  }
  assert.equal(fake.jobs.size, 0);
  assert.deepEqual(await fake.createJob(job({ description: 'x'.repeat(2028), urlExpiresInSec: 60, inProgressTimeoutMinutes: 10080 })),
    { ok: true });

  const cancel = { jobId: JOB, force: false, reasonCode: 'CONSOLE_CANCEL', comment: 'who' };
  for (const change of [{ reasonCode: 'console_cancel' }, { reasonCode: 'HAS SPACE' }, { reasonCode: '' }, { reasonCode: 'X'.repeat(129) },
    { comment: '' }, { comment: 'a\tb' }, { comment: 'x'.repeat(2029) }, { comment: undefined }, { force: 'yes' }, { force: undefined },
    { jobId: 'has space' }]) {
    await assert.rejects(fake.cancelJob({ ...cancel, ...change }), refused('CancelJob'), JSON.stringify(change));
  }
  assert.equal((await fake.describeJob(JOB)).status, 'IN_PROGRESS');

  for (const thing of ['has space', '', 'x'.repeat(129), undefined]) {
    await assert.rejects(fake.getShadow(thing), refused('GetThingShadow'));
    await assert.rejects(fake.listThingPrincipals(thing), refused('ListThingPrincipals'));
    await assert.rejects(fake.listJobExecutionsForThing(thing), refused('ListJobExecutionsForThing'));
  }
});

test('an object is written once, and only if its checksum is right', async () => {
  const { fake } = setup();
  const body = fixture('valid-1.2.3+4.signed.bin');
  const sha256Base64 = createHash('sha256').update(body).digest('base64');
  const key = 'firmware/x.bin';

  await assert.rejects(fake.putFirmwareObject({ key, body, sha256Base64: createHash('sha256').update('other').digest('base64') }),
    (error) => error.name === 'AwsError' && error.awsError === 'BadDigest');
  await assert.rejects(fake.putFirmwareObject({ key, body: body.toString('base64'), sha256Base64 }), refused('PutObject'));
  assert.equal(fake.objects.size, 0);

  assert.deepEqual(await fake.putFirmwareObject({ key, body, sha256Base64 }), { stored: true });
  const other = Buffer.from('different bytes');
  assert.deepEqual(await fake.putFirmwareObject({ key, body: other, sha256Base64: createHash('sha256').update(other).digest('base64') }),
    { stored: false, reason: 'exists' });
  assert.ok(fake.objects.get(key).body.equals(body));

  assert.deepEqual(await fake.tagFirmwareRevoked(key), { ok: true });
  assert.deepEqual(fake.objects.get(key).tags, { revoked: 'true' });
  assert.deepEqual(await fake.tagFirmwareRevoked('firmware/none.bin'), { ok: false, reason: 'not_found' });
});

test('releases are registered in one step, only upwards, and revoked once', async () => {
  const { fake } = setup();
  const release = (version) => ({ version, size: 1, status: 'active', revoked: null, uploadedBy: { sub: 's', email: '' } });
  const key = (n) => `001.000.${String(n).padStart(5, '0')}.0000000000`;

  assert.deepEqual(await fake.registerRelease({ sk: key(5), release: release('1.0.5+0') }), { ok: true });
  assert.deepEqual(await fake.registerRelease({ sk: key(5), release: release('1.0.5+0') }), { ok: false, reason: 'exists' });
  assert.deepEqual(await fake.registerRelease({ sk: key(4), release: release('1.0.4+0') }),
    { ok: false, reason: 'not_newer', highest: key(5) });
  assert.deepEqual(await fake.registerRelease({ sk: key(10), release: release('1.0.10+0') }), { ok: true });
  // Neither write of a refused transaction happened.
  assert.deepEqual([...fake.releases.keys()], [key(5), key(10)]);
  assert.equal(fake.highestRegistered(), key(10));
  assert.deepEqual((await fake.listReleases()).map((item) => item.sk), [key(10), key(5)]);
  assert.deepEqual(await fake.getRelease(key(5)), { ...release('1.0.5+0'), pk: 'REL', sk: key(5) });
  assert.equal(await fake.getRelease(key(4)), null);

  const revoked = { by: { sub: 's', email: '' }, at: '2026-10-11T00:00:00.000Z', reason: 'bad' };
  const marked = await fake.markReleaseRevoked({ sk: key(10), revoked });
  assert.deepEqual(marked, { ok: true, release: { ...release('1.0.10+0'), pk: 'REL', sk: key(10), status: 'revoked', revoked } });
  assert.deepEqual(await fake.markReleaseRevoked({ sk: key(10), revoked }), { ok: false, reason: 'not_active' });
  assert.deepEqual(await fake.markReleaseRevoked({ sk: key(4), revoked }), { ok: false, reason: 'not_active' });
  // Revoking does not lower the pointer.
  assert.deepEqual(await fake.registerRelease({ sk: key(9), release: release('1.0.9+0') }),
    { ok: false, reason: 'not_newer', highest: key(10) });

  // Only plain data can be stored, as with the real tables.
  for (const value of [NaN, Infinity, () => {}, new Date(), new Map(), 10n]) {
    await assert.rejects(fake.registerRelease({ sk: key(20), release: { ...release('1.0.20+0'), size: value } }), TypeError);
  }
  // What is stored is a copy, and so is what is read.
  const mutable = release('1.0.30+0');
  await fake.registerRelease({ sk: key(30), release: mutable });
  mutable.status = 'changed';
  const read = await fake.getRelease(key(30));
  read.status = 'changed too';
  assert.equal((await fake.getRelease(key(30))).status, 'active');
});

test('the audit table is append-only and read newest first below a cursor', async () => {
  const { fake } = setup();
  const item = (n) => ({ sk: `2026-10-10T22:15:0${n}.000Z#r${n}`, action: 'firmware.upload', outcome: 'ok' });
  for (const n of [3, 1, 2]) assert.deepEqual(await fake.putAudit(item(n)), { ok: true });
  assert.deepEqual(await fake.putAudit({ ...item(2), outcome: 'error' }), { ok: false, reason: 'exists' });
  assert.equal(fake.auditLog()[1].outcome, 'ok');

  const keys = async (query) => (await fake.queryAudit(query)).map((entry) => entry.sk.slice(-2));
  assert.deepEqual(await keys({ before: null, limit: 10 }), ['r3', 'r2', 'r1']);
  assert.deepEqual(await keys({ before: null, limit: 2 }), ['r3', 'r2']);
  assert.deepEqual(await keys({ before: item(3).sk, limit: 10 }), ['r2', 'r1']);
  assert.deepEqual(await keys({ before: item(1).sk, limit: 10 }), []);
  assert.equal((await fake.queryAudit({ before: null, limit: 1 }))[0].pk, 'AUD');
  await assert.rejects(fake.queryAudit({ before: null, limit: 0 }), TypeError);
  await assert.rejects(fake.putAudit({ action: 'x' }), TypeError);
});

test('users, groups and things are what the administrator made them', async () => {
  const { fake } = setup();
  fake.addUser({ sub: 'u1', email: 'address', groups: ['viewers'] });
  assert.deepEqual(await fake.getUser('u1'), { enabled: true, status: 'CONFIRMED', email: 'address' });
  assert.deepEqual(await fake.listUserGroups('u1'), ['viewers']);
  fake.user('u1').setGroups(['viewers', 'release-managers']);
  fake.user('u1').disable();
  fake.user('u1').setStatus('RESET_REQUIRED');
  assert.deepEqual(await fake.getUser('u1'), { enabled: false, status: 'RESET_REQUIRED', email: 'address' });
  assert.deepEqual(await fake.listUserGroups('u1'), ['viewers', 'release-managers']);
  fake.user('u1').enable();
  assert.equal((await fake.getUser('u1')).enabled, true);
  fake.user('u1').remove();
  assert.equal(await fake.getUser('u1'), null);
  assert.throws(() => fake.user('u1'), TypeError);

  fake.addThing('cranium-00000000000000cc', { certificates: ['ab'.repeat(32)], inGroup: false });
  assert.deepEqual((await fake.listGroupThings()).sort(), [THING, OTHER]);
  assert.deepEqual(await fake.listThingPrincipals('cranium-00000000000000cc'),
    [`arn:aws:iot:us-east-1:000000000000:cert/${'ab'.repeat(32)}`]);
  assert.deepEqual(await fake.listThingPrincipals('cranium-00000000000000ff'), []);
  fake.removeThing(OTHER);
  assert.deepEqual(await fake.listGroupThings(), [THING]);
});

test('calls are recorded and failures can be arranged', async () => {
  const { fake } = setup();
  await fake.listJobs();
  await fake.getShadow(THING);
  assert.deepEqual(fake.methodsCalled(), ['listJobs', 'getShadow']);
  assert.deepEqual(fake.calls[1], { method: 'getShadow', args: [THING] });

  fake.failNext('listJobs', { times: 2, code: 'throttled', awsName: 'ThrottlingException' });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(fake.listJobs(), (error) => error.name === 'AwsError' && error.code === 'throttled' &&
      error.awsError === 'ThrottlingException' && error.operation === 'listJobs');
  }
  assert.deepEqual(await fake.listJobs(), []);
  assert.throws(() => fake.failNext('noSuchMethod'), TypeError);
});

test('the request helpers build what API Gateway delivers', () => {
  const claims = accessClaims({ sub: 'u1', groups: ['viewers', 'release-managers'], clientId: 'client', exp: 1790000000 });
  assert.deepEqual(claims, {
    sub: 'u1', token_use: 'access', client_id: 'client', scope: 'openid cranium/console', username: 'u1',
    exp: '1790000000', 'cognito:groups': '[viewers release-managers]',
  });
  assert.equal(Object.hasOwn(accessClaims({ sub: 'u1', groups: null }), 'cognito:groups'), false);
  assert.equal(accessClaims({ sub: 'u1' })['cognito:groups'], '[]');

  const event = apiEvent('POST', '/api/deployments', { claims, body: { version: '1.2.3+4' }, query: { limit: '5' }, requestId: 'r1' });
  assert.equal(event.version, '2.0');
  assert.equal(event.rawPath, '/api/deployments');
  assert.equal(event.requestContext.http.method, 'POST');
  assert.equal(event.requestContext.requestId, 'r1');
  assert.deepEqual(event.requestContext.authorizer.jwt.claims, claims);
  assert.equal(event.body, '{"version":"1.2.3+4"}');
  assert.deepEqual(event.queryStringParameters, { limit: '5' });
  assert.equal(event.isBase64Encoded, false);
  const encoded = apiEvent('POST', '/api/firmware', { body: 'text', base64: true });
  assert.deepEqual([encoded.body, encoded.isBase64Encoded], ['dGV4dA==', true]);
  assert.equal(Object.hasOwn(encoded.requestContext, 'authorizer'), false);
  // Every request gets its own id, as from the gateway.
  assert.notEqual(apiEvent('GET', '/api/me').requestContext.requestId, apiEvent('GET', '/api/me').requestContext.requestId);

  const env = fakeEnv({ SLOT_SIZE: '4096' });
  assert.equal(env.SLOT_SIZE, '4096');
  assert.equal(env.USER_POOL_CLIENT_ID, 'localclient');
  assert.match(env.SIGNING_PUBLIC_KEY_B64, /^[A-Za-z0-9+/]+=*$/);
});
