// Tests for deployments: the checks before a job is created, the job itself, what the
// console shows while boards work through it, and cancelling.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createApp } from '../src/app.mjs';
import { apiEvent, awsError, createTestConsole, fixture } from './fake-aws.mjs';

const BOARD_A = 'cranium-00000000000000aa';
const BOARD_B = 'cranium-00000000000000bb';
const BOARD_C = 'cranium-00000000000000cc';
const JOB_ID = /^cranium-\d{1,3}-\d{1,3}-\d{1,5}-b\d{1,10}-\d{8}T\d{6}Z-[0-9a-f]{4}$/;

const idle = (version = '1.0.0+3') => ({
  fw: { version, confirmed: true },
  ota: { state: 'idle', job: null, progress: 0, last: 'none', error: '' },
  wifi: { rssi: -52 },
  uptime: 600,
});

/** A console with three boards, release 1.2.3+4 and a release manager. */
async function setup(options) {
  const console_ = createTestConsole(options);
  const manager = console_.addUser('manager', ['release-managers']);
  const viewer = console_.addUser('viewer', ['viewers']);
  for (const thing of [BOARD_A, BOARD_B, BOARD_C]) console_.fake.addThing(thing);
  const upload = async (name) => {
    const response = await console_.call('POST', '/api/firmware',
      { as: manager, body: { filename: 'zephyr.signed.bin', data: fixture(name).toString('base64') } });
    assert.equal(response.status, 201, JSON.stringify(response.body));
  };
  await upload('valid-1.2.3+4.signed.bin');
  const create = (body) => console_.call('POST', '/api/deployments', { as: manager, body });
  const deploy = async (things, version = '1.2.3+4') => {
    const response = await create({ version, things });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body.deployment.id;
  };
  const detail = async (id) => {
    // Past the two seconds a detail is cached for.
    console_.advance(2500);
    const response = await console_.call('GET', `/api/deployments/${id}`, { as: viewer });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body.deployment;
  };
  const cancel = (id, body = { force: false }) =>
    console_.call('POST', `/api/deployments/${id}/cancel`, { as: manager, body });
  return { ...console_, manager, viewer, upload, create, deploy, detail, cancel };
}

const count = (fake, method) => fake.calls.filter((call) => call.method === method).length;

test('a deployment is one snapshot job with the contract\'s document', async () => {
  const context = await setup();
  const { fake, manager, clock, config } = context;
  const release = [...fake.releases.values()][0];
  fake.calls.length = 0;

  const response = await context.create({ version: '1.2.3+4', things: [BOARD_B, BOARD_A], note: '  for the demo  ' });
  assert.equal(response.status, 201);
  const { deployment } = response.body;
  assert.match(deployment.id, JOB_ID);
  assert.ok(deployment.id.startsWith('cranium-1-2-3-b4-20261010T221500Z-'));

  const [created] = fake.calls.filter((call) => call.method === 'createJob').map((call) => call.args[0]);
  assert.deepEqual(Object.keys(created).sort(),
    ['description', 'document', 'inProgressTimeoutMinutes', 'jobId', 'things', 'urlExpiresInSec']);
  assert.equal(created.jobId, deployment.id);
  assert.deepEqual(created.things, [BOARD_A, BOARD_B]);
  assert.equal(created.urlExpiresInSec, 600);
  assert.equal(created.inProgressTimeoutMinutes, 30);
  assert.deepEqual(JSON.parse(created.document), {
    op: 'fw_update',
    v: 1,
    fw: {
      version: '1.2.3+4',
      size: release.size,
      sha256: release.sha256,
      url: `\${aws:iot:s3-presigned-url-v2:https://s3.${config.region}.amazonaws.com/${config.firmwareBucket}/firmware/${release.sha256}.bin}`,
    },
  });
  assert.ok(Buffer.byteLength(created.document) < 512);
  assert.deepEqual(JSON.parse(created.description), { by: manager.email, sub: manager.sub, note: 'for the demo' });

  assert.deepEqual(deployment, {
    id: deployment.id,
    version: '1.2.3+4',
    status: 'IN_PROGRESS',
    createdAt: new Date(clock.ms).toISOString(),
    completedAt: null,
    createdBy: { sub: manager.sub, email: manager.email },
    note: 'for the demo',
    things: [BOARD_A, BOARD_B],
    counts: { queued: 2, inProgress: 0, succeeded: 0, failed: 0, rejected: 0, canceled: 0, timedOut: 0, removed: 0 },
    executions: [BOARD_A, BOARD_B].map((thing) => ({
      thing,
      status: 'QUEUED',
      phase: 'waiting_for_device',
      progress: null,
      reason: null,
      detail: null,
      running: null,
      online: false,
      queuedAt: new Date(clock.ms).toISOString(),
      startedAt: null,
      lastUpdatedAt: new Date(clock.ms).toISOString(),
      secondsLeft: null,
    })),
  });

  // Every check came before the job was created.
  const order = fake.methodsCalled();
  for (const check of ['listUserGroups', 'getRelease', 'listGroupThings', 'listJobExecutionsForThing']) {
    assert.ok(order.indexOf(check) !== -1 && order.indexOf(check) < order.indexOf('createJob'), check);
  }
  const entry = fake.auditLog().at(-1);
  assert.equal(entry.action, 'deployment.create');
  assert.equal(entry.target, deployment.id);
  assert.equal(entry.outcome, 'ok');
  assert.deepEqual(entry.detail, { version: '1.2.3+4', things: '2' });
});

test('the request for a deployment is validated before anything is looked up', async () => {
  const context = await setup();
  const { fake } = context;
  fake.calls.length = 0;
  const cases = [
    [{ things: [BOARD_A] }, 'invalid_version'],
    [{ version: '1.2.3', things: [BOARD_A] }, 'invalid_version'],
    [{ version: 123, things: [BOARD_A] }, 'invalid_version'],
    [{ version: ['1.2.3+4'], things: [BOARD_A] }, 'invalid_version'],
    [{ version: '1.2.3+4' }, 'invalid_things'],
    [{ version: '1.2.3+4', things: [] }, 'invalid_things'],
    [{ version: '1.2.3+4', things: BOARD_A }, 'invalid_things'],
    [{ version: '1.2.3+4', things: [BOARD_A, BOARD_A] }, 'invalid_things'],
    [{ version: '1.2.3+4', things: [BOARD_A, 'cranium-*'] }, 'invalid_things'],
    [{ version: '1.2.3+4', things: Array.from({ length: 26 }, (_, n) => `cranium-${String(n).padStart(16, '0')}`) }, 'invalid_things'],
    [{ version: '1.2.3+4', things: [BOARD_A], note: 'x'.repeat(201) }, 'invalid_note'],
    [{ version: '1.2.3+4', things: [BOARD_A], note: 'a\u0000b' }, 'invalid_note'],
    [{ version: '1.2.3+4', things: [BOARD_A], note: 7 }, 'invalid_note'],
    [{ version: '1.2.3+4', things: [BOARD_A], note: null }, 'invalid_note'],
  ];
  for (const [body, code] of cases) {
    const response = await context.create(body);
    assert.equal(response.status, 400, code);
    assert.equal(response.body.error.code, code);
  }
  for (const [body, code] of [['', 'invalid_json'], ['[]', 'invalid_body'], ['{"version":', 'invalid_json']]) {
    const response = await context.create(body);
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, code);
  }
  const tooLong = await context.create(JSON.stringify({ version: '1.2.3+4', things: [BOARD_A], pad: 'x'.repeat(20000) }));
  assert.equal(tooLong.status, 413);

  for (const method of ['getRelease', 'listGroupThings', 'listJobExecutionsForThing', 'createJob']) {
    assert.equal(count(fake, method), 0, method);
  }
  assert.equal(fake.jobs.size, 0);

  // Fields the API does not know are ignored, not acted on.
  const response = await context.create({
    version: '1.2.3+4', things: [BOARD_A], jobId: 'cranium-mine', targets: ['arn:aws:iot:::thinggroup/all'],
    force: true, document: '{"op":"other"}', createdBy: { sub: 'x' },
  });
  assert.equal(response.status, 201);
  assert.match(response.body.deployment.id, JOB_ID);
  assert.deepEqual(response.body.deployment.things, [BOARD_A]);
});

test('only an existing, active release can be deployed', async () => {
  const context = await setup();
  const unknown = await context.create({ version: '9.9.9+9', things: [BOARD_A] });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error.code, 'unknown_version');

  await context.call('POST', '/api/firmware/1.2.3+4/revoke', { as: context.manager, body: { reason: 'bad' } });
  const revoked = await context.create({ version: '1.2.3+4', things: [BOARD_A] });
  assert.equal(revoked.status, 409);
  assert.equal(revoked.body.error.code, 'release_revoked');
  assert.equal(context.fake.jobs.size, 0);
  assert.equal(count(context.fake, 'createJob'), 0);
  assert.deepEqual(context.fake.auditLog().slice(-1).map((entry) => [entry.target, entry.outcome, entry.detail.code]),
    [['1.2.3+4', 'rejected', 'release_revoked']]);
});

test('only boards of the project\'s group can be targeted', async () => {
  const context = await setup();
  const { fake } = context;
  const stranger = 'cranium-00000000000000dd';
  fake.addThing(stranger, { inGroup: false });
  const absent = 'cranium-00000000000000ee';

  for (const things of [[stranger], [absent], [BOARD_A, stranger], [BOARD_A, absent, stranger]]) {
    const response = await context.create({ version: '1.2.3+4', things });
    assert.equal(response.status, 422, things.join());
    assert.equal(response.body.error.code, 'unknown_device');
    for (const thing of things.filter((name) => name !== BOARD_A)) {
      assert.ok(response.body.error.message.includes(thing));
    }
  }
  assert.equal(fake.jobs.size, 0);

  // A board that disappears between the check and the job.
  const original = fake.createJob;
  fake.createJob = async () => ({ ok: false, reason: 'target_not_found' });
  const gone = await context.create({ version: '1.2.3+4', things: [BOARD_A] });
  fake.createJob = original;
  assert.equal(gone.status, 422);
  assert.equal(gone.body.error.code, 'unknown_device');
});

test('a board with an unfinished update cannot get another one', async () => {
  const context = await setup();
  const { fake } = context;
  const first = await context.deploy([BOARD_A, BOARD_B]);
  fake.execution(first, BOARD_B).update('IN_PROGRESS', { step: 'downloading' });

  // Queued on A, in progress on B.
  let response = await context.create({ version: '1.2.3+4', things: [BOARD_A, BOARD_B, BOARD_C] });
  assert.equal(response.status, 409);
  assert.equal(response.body.error.code, 'device_busy');
  assert.deepEqual(response.body.error.details, [
    { thing: BOARD_A, deployment: first },
    { thing: BOARD_B, deployment: first },
  ]);
  assert.equal(fake.jobs.size, 1);

  // A board that is not part of it is free.
  const second = await context.deploy([BOARD_C]);
  assert.notEqual(second, first);

  // Once a board has finished, in whatever way, it is free again.
  fake.execution(first, BOARD_B).update('FAILED', { reason: 'download_failed' });
  response = await context.create({ version: '1.2.3+4', things: [BOARD_B] });
  assert.equal(response.status, 201);
  fake.execution(first, BOARD_A).update('REJECTED', { reason: 'declined' });
  fake.execution(response.body.deployment.id, BOARD_B).update('SUCCEEDED', { running: '1.2.3+4' });
  fake.execution(second, BOARD_C).update('IN_PROGRESS', { step: 'downloading' });
  context.advance(31 * 60 * 1000);   // C times out
  assert.equal(fake.execution(second, BOARD_C).get().status, 'TIMED_OUT');
  assert.equal((await context.create({ version: '1.2.3+4', things: [BOARD_A, BOARD_B, BOARD_C] })).status, 201);
});

test('a job some other tool created on a board blocks it too', async () => {
  const context = await setup();
  await context.fake.createJob({
    jobId: 'factory-test-7', things: [BOARD_A], document: '{}', description: 'not ours',
    urlExpiresInSec: 600, inProgressTimeoutMinutes: 30,
  });
  const response = await context.create({ version: '1.2.3+4', things: [BOARD_A] });
  assert.equal(response.status, 409);
  assert.deepEqual(response.body.error.details, [{ thing: BOARD_A, deployment: 'factory-test-7' }]);
});

test('a board is not free while AWS is still creating the execution of its last deployment', async () => {
  // AWS creates the executions of a job a few seconds after the job. In that time the
  // list of a board's executions does not show the deployment that was just made.
  const context = await setup({ rolloutDelayMs: 4000 });
  const { fake } = context;
  const first = await context.deploy([BOARD_A, BOARD_B]);
  assert.deepEqual(await fake.listJobExecutionsForThing(BOARD_A), []);

  context.advance(1000);
  const response = await context.create({ version: '1.2.3+4', things: [BOARD_B, BOARD_C] });
  assert.equal(response.status, 409);
  assert.equal(response.body.error.code, 'device_busy');
  assert.deepEqual(response.body.error.details, [{ thing: BOARD_B, deployment: first }]);
  assert.equal(fake.jobs.size, 1);
  // A board the first deployment does not name is free.
  assert.equal((await context.create({ version: '1.2.3+4', things: [BOARD_C] })).status, 201);

  // Once the executions exist, each is counted once.
  context.advance(4000);
  const later = await context.create({ version: '1.2.3+4', things: [BOARD_A, BOARD_B] });
  assert.deepEqual(later.body.error.details, [
    { thing: BOARD_A, deployment: first },
    { thing: BOARD_B, deployment: first },
  ]);

  // A deployment that was cancelled before its executions were created holds no board.
  const fresh = await setup({ rolloutDelayMs: 4000 });
  const withdrawn = await fresh.deploy([BOARD_A]);
  assert.equal((await fresh.cancel(withdrawn, { force: false })).status, 200);
  assert.equal((await fresh.create({ version: '1.2.3+4', things: [BOARD_A] })).status, 201);
});

test('two deployments to the same board at the same moment: one is withdrawn', async () => {
  const context = await setup();
  const { fake, manager } = context;
  const before = fake.auditLog().length;

  const answers = await Promise.all([
    context.create({ version: '1.2.3+4', things: [BOARD_A, BOARD_B], note: 'one' }),
    context.create({ version: '1.2.3+4', things: [BOARD_B, BOARD_C], note: 'two' }),
  ]);
  // Both found the boards free and both created a job; then each looked again.
  assert.equal(fake.jobs.size, 2);
  assert.deepEqual(answers.map((answer) => answer.status).sort(), [201, 409]);
  const kept = answers.find((answer) => answer.status === 201).body.deployment;
  const refused = answers.find((answer) => answer.status === 409).body.error;
  assert.equal(refused.code, 'device_busy');
  assert.match(refused.message, /given another update at the same moment, so this deployment was withdrawn/);
  assert.deepEqual(refused.details, [{ thing: BOARD_B, deployment: kept.id }]);

  // The one AWS created later gave way: it was cancelled with force, all of it.
  const [withdrawn] = [...fake.jobs.values()].filter((job) => job.jobId !== kept.id);
  assert.ok(kept.id < withdrawn.jobId);
  assert.deepEqual([withdrawn.status, withdrawn.forceCanceled, withdrawn.reasonCode, withdrawn.comment],
    ['CANCELED', true, 'DEVICE_BUSY', manager.sub]);
  assert.equal(fake.jobs.get(kept.id).status, 'IN_PROGRESS');
  for (const thing of [BOARD_A, BOARD_B, BOARD_C]) {
    const open = (await fake.listJobExecutionsForThing(thing)).filter((execution) => execution.status === 'QUEUED');
    assert.deepEqual(open.map((execution) => execution.jobId), kept.things.includes(thing) ? [kept.id] : [], thing);
  }
  // A board gets the deployment that stayed.
  assert.equal(fake.device(BOARD_B).nextJob().jobId, kept.id);

  // Both requests are on record, the withdrawn one with the job it had created.
  const entries = fake.auditLog().slice(before).map((entry) => [entry.outcome, entry.target, entry.detail.code ?? null]);
  assert.deepEqual(entries.sort(), [
    ['ok', kept.id, null],
    ['rejected', withdrawn.jobId, 'device_busy'],
  ].sort());

  // Afterwards the board is busy with the one that stayed, like any other.
  const next = await context.create({ version: '1.2.3+4', things: [BOARD_B] });
  assert.deepEqual(next.body.error.details, [{ thing: BOARD_B, deployment: kept.id }]);
});

test('two deployments at the same moment while AWS has not created their executions', async () => {
  const context = await setup({ rolloutDelayMs: 4000 });
  const { fake } = context;
  const answers = await Promise.all([
    context.create({ version: '1.2.3+4', things: [BOARD_A] }),
    context.create({ version: '1.2.3+4', things: [BOARD_A] }),
  ]);
  assert.deepEqual(answers.map((answer) => answer.status).sort(), [201, 409]);
  const kept = answers.find((answer) => answer.status === 201).body.deployment;
  assert.deepEqual(answers.find((answer) => answer.status === 409).body.error.details,
    [{ thing: BOARD_A, deployment: kept.id }]);
  context.advance(5000);
  assert.deepEqual((await fake.listJobExecutionsForThing(BOARD_A)).map((execution) => [execution.jobId, execution.status]),
    [[kept.id, 'QUEUED']]);
});

test('a deployment gives way to a job that another tool created in the same moment', async () => {
  const context = await setup();
  const { fake, manager } = context;
  const original = fake.createJob;
  // The other tool's job appears between the check and the creation.
  fake.createJob = async (input) => {
    await original({
      jobId: 'factory-test-9', things: [BOARD_A], document: '{}', description: 'not ours',
      urlExpiresInSec: 600, inProgressTimeoutMinutes: 30,
    });
    return original(input);
  };
  const response = await context.create({ version: '1.2.3+4', things: [BOARD_A, BOARD_B] });
  fake.createJob = original;

  assert.equal(response.status, 409);
  assert.equal(response.body.error.code, 'device_busy');
  assert.deepEqual(response.body.error.details, [{ thing: BOARD_A, deployment: 'factory-test-9' }]);
  const [own] = [...fake.jobs.values()].filter((job) => job.jobId !== 'factory-test-9');
  assert.deepEqual([own.status, own.forceCanceled, own.reasonCode, own.comment], ['CANCELED', true, 'DEVICE_BUSY', manager.sub]);
  assert.equal(fake.jobs.get('factory-test-9').status, 'IN_PROGRESS');
});

test('the second look at the boards is best effort; the first one decided', async () => {
  const context = await setup();
  const { fake } = context;
  // After the job is created, the boards' executions cannot be listed.
  const list = fake.listJobExecutionsForThing;
  let lists = 0;
  fake.listJobExecutionsForThing = async (thing) => {
    lists += 1;
    if (lists > 1) throw awsError('ListJobExecutionsForThing', 'ThrottlingException', { code: 'throttled' });
    return list(thing);
  };
  const response = await context.create({ version: '1.2.3+4', things: [BOARD_A] });
  fake.listJobExecutionsForThing = list;

  assert.equal(response.status, 201);
  assert.equal(fake.jobs.get(response.body.deployment.id).status, 'IN_PROGRESS');
  assert.ok(context.logs.some((line) => line.event === 'busy_recheck_failed' && line.deployment === response.body.deployment.id));
  assert.equal(fake.auditLog().at(-1).outcome, 'ok');

  // A deployment that cannot be withdrawn is an error, and the entry names its job.
  const cancel = fake.cancelJob;
  const create = fake.createJob;
  fake.createJob = async (input) => {
    await create({
      jobId: 'factory-test-9', things: [BOARD_B], document: '{}', description: 'not ours',
      urlExpiresInSec: 600, inProgressTimeoutMinutes: 30,
    });
    return create(input);
  };
  fake.cancelJob = async () => {
    throw awsError('CancelJob', 'ServiceUnavailableException');
  };
  const stuck = await context.create({ version: '1.2.3+4', things: [BOARD_B] });
  fake.createJob = create;
  fake.cancelJob = cancel;
  assert.equal(stuck.status, 500);
  const entry = fake.auditLog().at(-1);
  assert.deepEqual([entry.outcome, entry.detail.code], ['error', 'internal_error']);
  assert.match(entry.target, JOB_ID);
  assert.equal(fake.jobs.get(entry.target).status, 'IN_PROGRESS');
});

test('a job this request created is recognised when AWS reports its id as taken', async () => {
  const context = await setup();
  const { fake, manager } = context;
  // The SDK sends a call again when the answer got lost. The job was created by the
  // first attempt, so the second one is told that the id exists.
  const original = fake.createJob;
  let attempts = 0;
  fake.createJob = async (input) => {
    attempts += 1;
    const result = await original(input);
    return attempts === 1 ? { ok: false, reason: 'exists' } : result;
  };
  const response = await context.create({ version: '1.2.3+4', things: [BOARD_B, BOARD_A], note: 'evening build' });
  fake.createJob = original;

  assert.equal(response.status, 201);
  assert.equal(attempts, 1);
  assert.equal(fake.jobs.size, 1);
  assert.deepEqual([...fake.jobs.keys()], [response.body.deployment.id]);
  assert.deepEqual(response.body.deployment.createdBy, { sub: manager.sub, email: manager.email });
  assert.deepEqual([fake.auditLog().at(-1).outcome, fake.auditLog().at(-1).target], ['ok', response.body.deployment.id]);
});

test('what a board reports never decides whether it is deployed to', async () => {
  const context = await setup();
  const { fake } = context;
  // The board claims a newer version, an update in progress and a job of its own.
  fake.device(BOARD_A).report({
    fw: { version: '99.0.0+0', confirmed: true },
    ota: { state: 'downloading', job: 'cranium-9-9-9-b9-20261010T000000Z-aaaa', progress: 50, last: 'none', error: '' },
    uptime: 5,
  });
  const before = count(fake, 'getShadow');
  fake.calls.length = 0;
  const response = await context.create({ version: '1.2.3+4', things: [BOARD_A] });
  assert.equal(response.status, 201);
  // No shadow was read before the job existed.
  const order = fake.methodsCalled();
  assert.equal(before, 0);
  assert.ok(order.indexOf('createJob') < order.indexOf('getShadow'));
  // It is shown, and that is all.
  assert.equal(response.body.deployment.executions[0].running, '99.0.0+0');
  assert.equal(response.body.deployment.executions[0].phase, 'waiting_for_device');
});

test('a job id that is taken is drawn again', async () => {
  const context = await setup();
  const { fake, config, clock, manager } = context;
  const draws = ['aaaa', 'aaaa', 'bbbb', 'cccc'];
  const app = createApp({
    aws: fake, config, now: () => clock.ms, log: () => {}, randomHex: () => draws.shift(),
  });
  const send = async (things) => {
    const response = await app(apiEvent('POST', '/api/deployments',
      { claims: manager.claims, body: { version: '1.2.3+4', things } }));
    return { status: response.statusCode, body: JSON.parse(response.body) };
  };
  const first = await send([BOARD_A]);
  assert.equal(first.status, 201);
  assert.ok(first.body.deployment.id.endsWith('-aaaa'));
  const second = await send([BOARD_B]);
  assert.equal(second.status, 201);
  assert.ok(second.body.deployment.id.endsWith('-bbbb'));
  assert.equal(fake.jobs.size, 2);

  // A source of randomness that does not deliver is an error, not a weak id.
  for (const broken of [() => 'zzzz', () => '', () => undefined, () => 'AB12']) {
    const weak = createApp({ aws: fake, config, now: () => clock.ms, log: () => {}, randomHex: broken });
    const response = await weak(apiEvent('POST', '/api/deployments',
      { claims: manager.claims, body: { version: '1.2.3+4', things: [BOARD_C] } }));
    assert.equal(response.statusCode, 500);
  }
  assert.equal(fake.jobs.size, 2);
});

test('a release revoked while a deployment is being created wins', async () => {
  const context = await setup();
  const { fake, manager } = context;
  const original = fake.createJob;
  // The release is revoked by someone else just after the job was created.
  fake.createJob = async (input) => {
    const result = await original(input);
    await fake.markReleaseRevoked({ sk: '001.002.00003.0000000004', revoked: { by: { sub: 'x', email: '' }, at: 'now', reason: 'r' } });
    return result;
  };
  const response = await context.create({ version: '1.2.3+4', things: [BOARD_A] });
  fake.createJob = original;

  assert.equal(response.status, 409);
  assert.equal(response.body.error.code, 'release_revoked');
  const [job] = [...fake.jobs.values()];
  assert.equal(job.status, 'CANCELED');
  assert.equal(job.forceCanceled, true);
  assert.equal(job.reasonCode, 'RELEASE_REVOKED');
  assert.equal(job.comment, manager.sub);
  assert.equal(fake.execution(job.jobId, BOARD_A).get().status, 'CANCELED');
  const entry = fake.auditLog().at(-1);
  assert.deepEqual([entry.target, entry.outcome, entry.detail.code], [job.jobId, 'rejected', 'release_revoked']);
});

test('a deployment that was created is answered with 201 even if it cannot be read back', async () => {
  const context = await setup();
  const { fake, manager, clock } = context;
  // After the job is created, neither the release nor the job can be read.
  const readRelease = fake.getRelease;
  let reads = 0;
  fake.getRelease = async (sk) => {
    reads += 1;
    if (reads === 2) throw awsError('GetItem', 'InternalServerError');
    return readRelease(sk);
  };
  fake.failNext('describeJob');
  const response = await context.create({ version: '1.2.3+4', things: [BOARD_B, BOARD_A], note: 'evening build' });
  fake.getRelease = readRelease;

  assert.equal(response.status, 201);
  const [job] = [...fake.jobs.values()];
  assert.equal(job.status, 'IN_PROGRESS');
  const at = new Date(clock.ms).toISOString();
  assert.deepEqual(response.body.deployment, {
    id: job.jobId,
    version: '1.2.3+4',
    status: 'IN_PROGRESS',
    createdAt: at,
    completedAt: null,
    createdBy: { sub: manager.sub, email: manager.email },
    note: 'evening build',
    things: [BOARD_A, BOARD_B],
    counts: { queued: 2, inProgress: 0, succeeded: 0, failed: 0, rejected: 0, canceled: 0, timedOut: 0, removed: 0 },
    executions: [BOARD_A, BOARD_B].map((thing) => ({
      thing, status: 'QUEUED', phase: 'waiting_for_device', progress: null, reason: null, detail: null, running: null,
      online: false, queuedAt: at, startedAt: null, lastUpdatedAt: at, secondsLeft: null,
    })),
  });
  assert.ok(context.logs.some((line) => line.event === 'release_recheck_failed'));
  assert.ok(context.logs.some((line) => line.event === 'deployment_unreadable'));
  const entry = fake.auditLog().at(-1);
  assert.deepEqual([entry.action, entry.target, entry.outcome], ['deployment.create', job.jobId, 'ok']);

  // The next read is the real thing.
  const seen = await context.detail(job.jobId);
  assert.deepEqual(seen.executions.map((row) => row.status), ['QUEUED', 'QUEUED']);
});

test('a cancellation whose result cannot be read back is on record all the same', async () => {
  const context = await setup();
  const { fake } = context;
  const id = await context.deploy([BOARD_A]);
  // The job can be described before the cancellation and not after it.
  const describe = fake.describeJob;
  let describes = 0;
  fake.describeJob = async (jobId) => {
    describes += 1;
    if (describes === 2) throw awsError('DescribeJob', 'ServiceUnavailableException');
    return describe(jobId);
  };
  const response = await context.cancel(id, { force: true });
  fake.describeJob = describe;

  assert.equal(response.status, 500);
  assert.equal(fake.jobs.get(id).status, 'CANCELED');
  const entry = fake.auditLog().at(-1);
  assert.deepEqual([entry.outcome, entry.target, entry.detail],
    ['error', id, { force: 'true', cancelled: 'true', code: 'internal_error' }]);
});

test('a board is followed through a whole update', async () => {
  const context = await setup();
  const { fake } = context;
  fake.device(BOARD_A).report(idle());
  const id = await context.deploy([BOARD_A]);
  const board = fake.device(BOARD_A);
  const execution = fake.execution(id, BOARD_A);
  const row = async () => (await context.detail(id)).executions[0];

  // Offered, not yet picked up.
  let seen = await row();
  assert.deepEqual([seen.status, seen.phase, seen.progress, seen.online, seen.running],
    ['QUEUED', 'waiting_for_device', null, true, '1.0.0+3']);

  // The board holds the job and waits for its button. The execution stays queued.
  board.report({ ota: { state: 'awaiting_user', job: id }, uptime: 610 });
  seen = await row();
  assert.deepEqual([seen.status, seen.phase, seen.startedAt, seen.secondsLeft], ['QUEUED', 'waiting_for_button', null, null]);

  // Button pressed: the board says "downloading" at once, a moment before AWS has
  // accepted the start. Until then nothing has started, and the phase does not go back.
  board.report({ ota: { state: 'downloading', progress: 0 }, uptime: 618 });
  seen = await row();
  assert.deepEqual([seen.status, seen.phase, seen.progress, seen.startedAt], ['QUEUED', 'waiting_for_button', null, null]);

  // The board announces the download and starts once AWS accepted that.
  assert.deepEqual(execution.update('IN_PROGRESS', { step: 'downloading' }), { accepted: true });
  board.report({ ota: { state: 'downloading', progress: 0 }, uptime: 620 });
  seen = await row();
  assert.deepEqual([seen.status, seen.phase, seen.progress], ['IN_PROGRESS', 'downloading', 0]);
  assert.ok(seen.startedAt !== null);
  assert.ok(seen.secondsLeft > 29 * 60 && seen.secondsLeft <= 30 * 60);

  board.report({ ota: { progress: 40 }, uptime: 630 });
  seen = await row();
  assert.deepEqual([seen.phase, seen.progress], ['downloading', 40]);

  board.report({ ota: { state: 'verifying', progress: 100 }, uptime: 640 });
  seen = await row();
  assert.deepEqual([seen.phase, seen.progress], ['verifying', 100]);

  // Verified: the board announces the reboot and swaps once AWS accepted that.
  assert.deepEqual(execution.update('IN_PROGRESS', { step: 'rebooting' }), { accepted: true });
  board.report({ ota: { state: 'rebooting' } });
  seen = await row();
  assert.deepEqual([seen.status, seen.phase], ['IN_PROGRESS', 'rebooting']);

  // The new image is up and on trial.
  board.report({ fw: { version: '1.2.3+4', confirmed: false }, ota: { state: 'testing' }, uptime: 5 });
  seen = await row();
  assert.deepEqual([seen.status, seen.phase, seen.running], ['IN_PROGRESS', 'testing', '1.2.3+4']);

  // It reached AWS again, confirmed itself and reported success.
  assert.deepEqual(execution.update('SUCCEEDED', { running: '1.2.3+4' }), { accepted: true });
  board.report({ fw: { confirmed: true }, ota: { state: 'idle', job: null, progress: 0, last: 'succeeded' }, uptime: 20 });
  const done = await context.detail(id);
  assert.equal(done.status, 'COMPLETED');
  assert.ok(done.completedAt !== null);
  assert.deepEqual(done.counts, { queued: 0, inProgress: 0, succeeded: 1, failed: 0, rejected: 0, canceled: 0, timedOut: 0, removed: 0 });
  assert.deepEqual([done.executions[0].status, done.executions[0].phase, done.executions[0].progress,
    done.executions[0].running, done.executions[0].secondsLeft], ['SUCCEEDED', 'succeeded', null, '1.2.3+4', null]);

  // The devices view agrees.
  context.advance(6000);
  const devices = await context.call('GET', '/api/devices', { as: context.viewer });
  const device = devices.body.devices.find((entry) => entry.thing === BOARD_A);
  assert.deepEqual(device.fw, { version: '1.2.3+4', confirmed: true });
  assert.deepEqual(device.ota, { state: 'idle', job: null, progress: 0, last: 'succeeded', error: '' });
  const history = await context.call('GET', `/api/devices/${BOARD_A}`, { as: context.viewer });
  assert.deepEqual(history.body.executions.map((entry) => [entry.deployment, entry.version, entry.status]),
    [[id, '1.2.3+4', 'SUCCEEDED']]);
});

test('every way an update can end is shown for what it is', async () => {
  const context = await setup();
  const { fake } = context;
  await context.upload('valid-1.2.3+5.signed.bin');
  for (const thing of [BOARD_A, BOARD_B, BOARD_C]) fake.device(thing).report(idle());
  const id = await context.deploy([BOARD_A, BOARD_B, BOARD_C], '1.2.3+5');

  // A: someone said no on the board. B: the bootloader went back. C: never answers.
  fake.execution(id, BOARD_A).update('REJECTED', { reason: 'declined', running: '1.0.0+3' });
  fake.execution(id, BOARD_B).update('IN_PROGRESS', { step: 'downloading' });
  fake.execution(id, BOARD_B).update('IN_PROGRESS', { step: 'rebooting' });
  fake.execution(id, BOARD_B).update('FAILED', { reason: 'rolled_back', detail: 'image did not confirm', running: '1.0.0+3' });
  fake.execution(id, BOARD_C).update('IN_PROGRESS', { step: 'downloading' });
  context.advance(31 * 60 * 1000);
  fake.device(BOARD_C).report({ fw: { version: '1.2.3+5', confirmed: true }, uptime: 9 });

  const seen = await context.detail(id);
  assert.equal(seen.status, 'COMPLETED');
  assert.deepEqual(seen.counts, { queued: 0, inProgress: 0, succeeded: 0, failed: 1, rejected: 1, canceled: 0, timedOut: 1, removed: 0 });
  const rows = Object.fromEntries(seen.executions.map((row) => [row.thing, row]));
  assert.deepEqual([rows[BOARD_A].status, rows[BOARD_A].phase, rows[BOARD_A].reason, rows[BOARD_A].running],
    ['REJECTED', 'declined', 'declined', '1.0.0+3']);
  assert.deepEqual([rows[BOARD_B].status, rows[BOARD_B].phase, rows[BOARD_B].reason, rows[BOARD_B].detail],
    ['FAILED', 'rolled_back', 'rolled_back', 'image did not confirm']);
  // Timed out stays timed out; next to it is what the board reports now.
  assert.deepEqual([rows[BOARD_C].status, rows[BOARD_C].phase, rows[BOARD_C].running, rows[BOARD_C].secondsLeft],
    ['TIMED_OUT', 'timed_out', '1.2.3+5', null]);

  // Refusals that are not a person's choice.
  const second = await context.deploy([BOARD_A], '1.2.3+5');
  fake.execution(second, BOARD_A).update('REJECTED', { reason: 'not_newer', running: '1.2.3+5' });
  const refused = (await context.detail(second)).executions[0];
  assert.deepEqual([refused.phase, refused.reason, refused.running], ['refused', 'not_newer', '1.2.3+5']);
});

test('what a board writes into its execution is cleaned before it is shown', async () => {
  const context = await setup();
  const { fake } = context;
  const id = await context.deploy([BOARD_A, BOARD_B]);
  assert.equal(fake.execution(id, BOARD_A).update('FAILED', {
    reason: '<img src=x onerror=alert(1)>',
    detail: `${'A'.repeat(900)}`,
    running: '1.0.0+3; DROP TABLE releases',
    step: 'rebooting',
    extra: 'ignored',
  }).accepted, true);
  assert.equal(fake.execution(id, BOARD_B).update('REJECTED', { reason: 'Declined', detail: 'ok "quoted" <b>text</b>' }).accepted, true);

  const seen = await context.detail(id);
  const rows = Object.fromEntries(seen.executions.map((row) => [row.thing, row]));
  assert.deepEqual([rows[BOARD_A].phase, rows[BOARD_A].reason, rows[BOARD_A].detail, rows[BOARD_A].running],
    ['failed', null, null, null]);
  // Not the board's "Declined": the reason must match exactly to count.
  assert.deepEqual([rows[BOARD_B].phase, rows[BOARD_B].reason, rows[BOARD_B].detail],
    ['refused', null, 'ok "quoted" <b>text</b>']);
  assert.deepEqual(Object.keys(rows[BOARD_A]).sort(), ['detail', 'lastUpdatedAt', 'online', 'phase', 'progress',
    'queuedAt', 'reason', 'running', 'secondsLeft', 'startedAt', 'status', 'thing']);
});

test('a detail is cached for two seconds and finished executions are described once', async () => {
  const context = await setup();
  const { fake, viewer } = context;
  const id = await context.deploy([BOARD_A, BOARD_B]);
  const get = () => context.call('GET', `/api/deployments/${id}`, { as: viewer });
  fake.calls.length = 0;

  // Within two seconds of the read that followed the creation: nothing is asked.
  context.advance(1500);
  await get();
  assert.equal(count(fake, 'describeJob'), 0);
  context.advance(600);
  await get();
  assert.equal(count(fake, 'describeJob'), 1);
  assert.equal(count(fake, 'listJobExecutionsForJob'), 1);
  assert.equal(count(fake, 'describeJobExecution'), 2);
  await get();
  await get();
  assert.equal(count(fake, 'describeJob'), 1);

  // A finished execution does not change: it is not described again.
  fake.execution(id, BOARD_A).update('REJECTED', { reason: 'declined' });
  context.advance(2100);
  let seen = (await get()).body.deployment;
  assert.equal(seen.executions[0].phase, 'declined');
  assert.equal(count(fake, 'describeJobExecution'), 4);
  context.advance(2100);
  seen = (await get()).body.deployment;
  assert.equal(seen.executions[0].phase, 'declined');
  assert.equal(count(fake, 'describeJobExecution'), 5);   // only board B, which is still queued
  assert.equal(count(fake, 'describeJob'), 3);
});

test('an execution that changes after it had ended is read again', async () => {
  const context = await setup();
  const { fake } = context;
  const id = await context.deploy([BOARD_A]);
  fake.execution(id, BOARD_A).update('IN_PROGRESS', { step: 'downloading' });
  fake.execution(id, BOARD_A).update('FAILED', { reason: 'download_failed' });
  assert.equal((await context.detail(id)).executions[0].phase, 'failed');

  // AWS IoT can queue a failed execution again when a job has a retry configuration.
  // The console creates none, but it must not show a remembered result if that happens.
  const job = fake.jobs.get(id);
  Object.assign(job.executions.get(BOARD_A), {
    status: 'QUEUED', startedAt: null, lastUpdatedAt: context.clock.ms + 1000, statusDetails: {},
  });
  job.status = 'IN_PROGRESS';
  job.completedAt = null;
  const again = (await context.detail(id)).executions[0];
  assert.deepEqual([again.status, again.phase, again.reason], ['QUEUED', 'waiting_for_device', null]);
});

test('a shadow or an execution that cannot be read does not fail the view', async () => {
  const context = await setup();
  const { fake } = context;
  fake.device(BOARD_A).report(idle());
  fake.device(BOARD_B).report(idle());
  const id = await context.deploy([BOARD_A, BOARD_B]);
  fake.execution(id, BOARD_A).update('FAILED', { reason: 'rolled_back' });

  fake.failNext('getShadow');
  fake.failNext('describeJobExecution');
  const seen = await context.detail(id);
  assert.equal(seen.executions.length, 2);
  const rows = Object.fromEntries(seen.executions.map((row) => [row.thing, row]));
  // The list entry still gives the status; the board's details follow on the next poll.
  assert.equal(rows[BOARD_A].status, 'FAILED');
  assert.equal(rows[BOARD_B].status, 'QUEUED');
  assert.equal([rows[BOARD_A].online, rows[BOARD_B].online].filter(Boolean).length, 1);
  assert.ok(context.logs.some((line) => line.event === 'shadow_unreadable'));
  assert.ok(context.logs.some((line) => line.event === 'execution_unreadable'));

  const next = await context.detail(id);
  const again = Object.fromEntries(next.executions.map((row) => [row.thing, row]));
  assert.deepEqual([again[BOARD_A].phase, again[BOARD_A].online, again[BOARD_B].online], ['rolled_back', true, true]);
});

test('boards are shown as queued while AWS is still creating their executions', async () => {
  const context = await setup({ rolloutDelayMs: 4000 });
  const { fake } = context;
  const response = await context.create({ version: '1.2.3+4', things: [BOARD_A, BOARD_B] });
  assert.equal(response.status, 201);
  const { deployment } = response.body;
  assert.equal(count(fake, 'describeJobExecution'), 0);
  assert.deepEqual(deployment.executions.map((row) => [row.thing, row.status, row.phase, row.queuedAt]), [
    [BOARD_A, 'QUEUED', 'waiting_for_device', deployment.createdAt],
    [BOARD_B, 'QUEUED', 'waiting_for_device', deployment.createdAt],
  ]);
  assert.equal(deployment.counts.queued, 2);

  context.advance(100);
  const listed = await context.call('GET', '/api/deployments', { as: context.viewer });
  assert.equal(listed.body.deployments[0].counts.queued, 2);

  // Once they exist, they are read like any other.
  context.advance(4000);
  fake.execution(deployment.id, BOARD_A).update('IN_PROGRESS', { step: 'downloading' });
  const seen = await context.detail(deployment.id);
  assert.deepEqual(seen.executions.map((row) => row.status), ['IN_PROGRESS', 'QUEUED']);
  assert.deepEqual(seen.counts, { queued: 1, inProgress: 1, succeeded: 0, failed: 0, rejected: 0, canceled: 0, timedOut: 0, removed: 0 });
});

test('unknown and malformed deployment ids', async () => {
  const context = await setup();
  const { viewer, fake } = context;
  const missing = await context.call('GET', '/api/deployments/cranium-1-2-3-b4-20261010T221500Z-0000', { as: viewer });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'unknown_deployment');

  await fake.createJob({
    jobId: 'factory-test-7', things: [BOARD_A], document: '{}', description: 'not ours',
    urlExpiresInSec: 600, inProgressTimeoutMinutes: 30,
  });
  fake.calls.length = 0;
  for (const id of ['factory-test-7', 'cranium-1-2-3', 'cranium-256-2-3-b4-20261010T221500Z-0000', '..%2f..%2fjobs', '%00',
    'cranium-1-2-3-b4-20261010T221500Z-0000%0a']) {
    const response = await context.call('GET', `/api/deployments/${id}`, { as: viewer });
    assert.equal(response.status, 400, id);
    assert.equal(response.body.error.code, 'invalid_deployment');
    const cancelled = await context.cancel(id);
    assert.equal(cancelled.status, 400, id);
  }
  assert.equal(count(fake, 'describeJob'), 0);
  assert.equal(count(fake, 'cancelJob'), 0);
  assert.equal(fake.jobs.get('factory-test-7').status, 'IN_PROGRESS');
});

test('deployments are listed newest first, without the jobs of other tools', async () => {
  const context = await setup();
  const { fake, viewer } = context;
  const empty = await context.call('GET', '/api/deployments', { as: viewer });
  assert.deepEqual(empty.body, { deployments: [] });

  const ids = [];
  for (const thing of [BOARD_A, BOARD_B, BOARD_C]) {
    context.advance(60_000);
    ids.push(await context.deploy([thing]));
  }
  await fake.createJob({
    jobId: 'factory-test-7', things: [BOARD_A], document: '{}', description: 'not ours',
    urlExpiresInSec: 600, inProgressTimeoutMinutes: 30,
  });
  await fake.createJob({
    jobId: 'cranium-not-a-deployment', things: [BOARD_A], document: '{}', description: 'not ours',
    urlExpiresInSec: 600, inProgressTimeoutMinutes: 30,
  });
  fake.execution(ids[0], BOARD_A).update('SUCCEEDED', { running: '1.2.3+4' });

  context.advance(2500);
  const listed = await context.call('GET', '/api/deployments', { as: viewer });
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.deployments.map((entry) => entry.id), [...ids].reverse());
  const oldest = listed.body.deployments.at(-1);
  assert.equal(oldest.status, 'COMPLETED');
  assert.equal(oldest.counts.succeeded, 1);
  assert.equal(Object.hasOwn(oldest, 'executions'), false);
  assert.deepEqual(Object.keys(oldest).sort(),
    ['completedAt', 'counts', 'createdAt', 'createdBy', 'id', 'note', 'status', 'things', 'version']);
});

test('the list shows at most 25 deployments and describes at most 5 jobs at a time', async () => {
  const context = await setup();
  const { fake, viewer } = context;
  for (let n = 0; n < 30; n += 1) {
    context.advance(60_000);
    await fake.createJob({
      jobId: `cranium-1-2-3-b4-202610${String(11 + Math.floor(n / 10)).padStart(2, '0')}T0${n % 10}0000Z-${String(n).padStart(4, '0')}`,
      things: [BOARD_A], document: '{}', description: '{}', urlExpiresInSec: 600, inProgressTimeoutMinutes: 30,
    });
  }
  let inFlight = 0;
  let most = 0;
  const original = fake.describeJob;
  fake.describeJob = async (id) => {
    inFlight += 1;
    most = Math.max(most, inFlight);
    await new Promise((resolve) => setImmediate(resolve));
    try {
      return await original(id);
    } finally {
      inFlight -= 1;
    }
  };
  context.advance(2500);
  const listed = await context.call('GET', '/api/deployments', { as: viewer });
  fake.describeJob = original;

  assert.equal(listed.body.deployments.length, 25);
  assert.ok(most <= 5, `${most} jobs described at once`);
  assert.equal(most, 5);
  // The 25 newest, newest first.
  const created = listed.body.deployments.map((entry) => entry.createdAt);
  assert.deepEqual(created, [...created].sort().reverse());
  assert.ok(listed.body.deployments[0].id.endsWith('-0029'));
  assert.ok(listed.body.deployments.at(-1).id.endsWith('-0005'));
});

test('finished jobs are remembered; running ones are asked about again after two seconds', async () => {
  const context = await setup();
  const { fake, viewer } = context;
  const done = await context.deploy([BOARD_A]);
  fake.execution(done, BOARD_A).update('SUCCEEDED', { running: '1.2.3+4' });
  const running = await context.deploy([BOARD_B]);
  const stopped = await context.deploy([BOARD_C]);
  fake.execution(stopped, BOARD_C).update('IN_PROGRESS', { step: 'downloading' });
  await context.cancel(stopped);   // without force: the board that started carries on
  const list = () => context.call('GET', '/api/deployments', { as: viewer });

  context.advance(2500);
  fake.calls.length = 0;
  await list();
  const described = () => fake.calls.filter((call) => call.method === 'describeJob').map((call) => call.args[0]).sort();
  assert.deepEqual(described(), [done, running, stopped].sort());

  // Within two seconds nothing is asked again, not even the list.
  fake.calls.length = 0;
  context.advance(1000);
  await list();
  assert.deepEqual(fake.methodsCalled().filter((name) => name !== 'getUser'), []);

  // Later, the finished job comes from memory. The cancelled one still has a board at
  // work, so it is not finished yet.
  context.advance(2500);
  await list();
  assert.equal(count(fake, 'listJobs'), 1);
  assert.deepEqual(described(), [running, stopped].sort());

  fake.execution(stopped, BOARD_C).update('FAILED', { reason: 'interrupted' });
  fake.calls.length = 0;
  context.advance(2500);
  const settled = await list();
  assert.deepEqual(described(), [running, stopped].sort());
  assert.equal(settled.body.deployments.find((entry) => entry.id === stopped).counts.failed, 1);
  fake.calls.length = 0;
  context.advance(2500);
  await list();
  assert.deepEqual(described(), [running]);
});

test('cancelling without force stops only boards that have not started', async () => {
  const context = await setup();
  const { fake, manager } = context;
  const id = await context.deploy([BOARD_A, BOARD_B]);
  fake.execution(id, BOARD_B).update('IN_PROGRESS', { step: 'downloading' });
  fake.calls.length = 0;

  const response = await context.cancel(id, { force: false });
  assert.equal(response.status, 200);
  assert.deepEqual(fake.calls.find((call) => call.method === 'cancelJob').args[0],
    { jobId: id, force: false, reasonCode: 'CONSOLE_CANCEL', comment: manager.sub });

  // The answer is what AWS says after the call.
  const { deployment } = response.body;
  assert.equal(deployment.status, 'CANCELED');
  assert.deepEqual(deployment.executions.map((row) => [row.thing, row.status, row.phase]), [
    [BOARD_A, 'CANCELED', 'cancelled'],
    [BOARD_B, 'IN_PROGRESS', 'downloading'],
  ]);
  const order = fake.methodsCalled();
  assert.ok(order.indexOf('cancelJob') < order.lastIndexOf('describeJob'));
  assert.ok(order.indexOf('cancelJob') < order.lastIndexOf('listJobExecutionsForJob'));

  // The board that had started may finish.
  assert.equal(fake.execution(id, BOARD_B).update('SUCCEEDED', { running: '1.2.3+4' }).accepted, true);
  const entry = fake.auditLog().at(-1);
  assert.deepEqual([entry.action, entry.target, entry.outcome, entry.detail], ['deployment.cancel', id, 'ok', { force: 'false' }]);
});

test('cancelling with force also stops boards that have started', async () => {
  const context = await setup();
  const { fake } = context;
  const id = await context.deploy([BOARD_A, BOARD_B]);
  fake.execution(id, BOARD_B).update('IN_PROGRESS', { step: 'downloading' });

  const response = await context.cancel(id, { force: true });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.deployment.executions.map((row) => [row.status, row.phase]),
    [['CANCELED', 'cancelled'], ['CANCELED', 'cancelled']]);
  assert.equal(fake.jobs.get(id).forceCanceled, true);
  // The board asks AWS before it installs, and is told no.
  assert.deepEqual(fake.execution(id, BOARD_B).update('IN_PROGRESS', { step: 'rebooting' }),
    { accepted: false, code: 'InvalidStateTransition' });
  assert.equal(fake.auditLog().at(-1).detail.force, 'true');
});

test('AWS stops boards a few seconds after a cancellation, and the answers say what is so', async () => {
  // As measured on AWS IoT: the job is cancelled at once, its executions 5 to 15 s later.
  const context = await setup({ cancelDelayMs: 10_000 });
  const { fake } = context;
  const id = await context.deploy([BOARD_A, BOARD_B]);
  fake.execution(id, BOARD_B).update('IN_PROGRESS', { step: 'downloading' });

  // The answer is what AWS holds after the call: cancelled, the boards not yet.
  const forced = await context.cancel(id, { force: true });
  assert.equal(forced.status, 200);
  assert.equal(forced.body.deployment.status, 'CANCELED');
  assert.deepEqual(forced.body.deployment.executions.map((row) => [row.thing, row.status]),
    [[BOARD_A, 'QUEUED'], [BOARD_B, 'IN_PROGRESS']]);
  assert.deepEqual([forced.body.deployment.counts.queued, forced.body.deployment.counts.inProgress], [1, 1]);

  // Asking again in that time, with or without force: nothing is sent to AWS, and the
  // answer is neither "finished" nor "refused".
  fake.calls.length = 0;
  for (const force of [true, false]) {
    context.advance(3000);
    const again = await context.cancel(id, { force });
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'already_cancelled');
    assert.equal(again.body.error.message, 'This deployment is already cancelled with force. ' +
      'AWS takes a few seconds to stop its boards: 2 boards are still listed as unfinished.');
  }
  assert.equal(count(fake, 'cancelJob'), 0);
  // Until AWS has stopped it, a board's update still passes. That is why a board looks
  // at its job once more before it installs (device contract).
  assert.equal(fake.execution(id, BOARD_B).update('IN_PROGRESS', { step: 'rebooting' }).accepted, true);

  context.advance(5000);
  const seen = await context.detail(id);
  assert.deepEqual(seen.executions.map((row) => row.status), ['CANCELED', 'CANCELED']);
  const done = await context.cancel(id, { force: true });
  assert.equal(done.body.error.code, 'already_finished');

  // Without force: the offer is withdrawn a few seconds later, and a board that had
  // started stays.
  const second = await context.deploy([BOARD_A, BOARD_B]);
  fake.execution(second, BOARD_B).update('IN_PROGRESS', { step: 'downloading' });
  assert.equal((await context.cancel(second, { force: false })).status, 200);
  context.advance(3000);
  const plain = await context.cancel(second, { force: false });
  assert.equal(plain.body.error.code, 'already_cancelled');
  assert.match(plain.body.error.message, /^This deployment is already cancelled\. 1 board is still at work on it, because/);
  context.advance(10_000);
  assert.deepEqual((await context.detail(second)).executions.map((row) => row.status), ['CANCELED', 'IN_PROGRESS']);

  // A board that is only waiting while AWS withdraws the offer needs nothing more.
  const third = await context.deploy([BOARD_C]);
  assert.equal((await context.cancel(third, { force: false })).status, 200);
  fake.calls.length = 0;
  for (const force of [false, true]) {
    const waiting = await context.cancel(third, { force });
    assert.equal(waiting.body.error.code, 'already_cancelled');
    assert.equal(waiting.body.error.message, 'This deployment is already cancelled. ' +
      'AWS takes a few seconds to withdraw the offer: 1 board is still listed as waiting.');
  }
  assert.equal(count(fake, 'cancelJob'), 0);
});

test('a board that a forced cancellation did not stop is not passed over', async () => {
  // Not what AWS documents, but if a board is still at work minutes after a forced
  // cancellation, the console does not go on saying that AWS is stopping it.
  const context = await setup({ cancelDelayMs: 3_600_000 });
  const { fake } = context;
  const id = await context.deploy([BOARD_A]);
  fake.execution(id, BOARD_A).update('IN_PROGRESS', { step: 'downloading' });
  assert.equal((await context.cancel(id, { force: true })).status, 200);

  context.advance(119_000);
  assert.match((await context.cancel(id, { force: false })).body.error.message, /AWS takes a few seconds to stop its boards/);
  context.advance(2000);
  const plain = await context.cancel(id, { force: false });
  assert.equal(plain.body.error.code, 'already_cancelled');
  assert.equal(plain.body.error.message, 'This deployment is already cancelled with force. ' +
    '1 board is still at work on it all the same. Cancel with force to try again.');
  // With force it is asked of AWS once more, and the answer is passed on as it is.
  const forced = await context.cancel(id, { force: true });
  assert.equal(forced.status, 409);
  assert.equal(forced.body.error.code, 'cancel_refused');
  assert.equal(count(fake, 'cancelJob'), 2);
});

/** A deployment to A and B that was cancelled without force after B had started. */
async function cancelledWithBoardAtWork(repeatedCancel) {
  const context = await setup({ repeatedCancel });
  const id = await context.deploy([BOARD_A, BOARD_B]);
  context.fake.execution(id, BOARD_B).update('IN_PROGRESS', { step: 'downloading' });
  assert.equal((await context.cancel(id, { force: false })).status, 200);
  context.fake.calls.length = 0;
  return { ...context, id };
}

test('a deployment that is cancelled already says what is left of it', async () => {
  const context = await cancelledWithBoardAtWork();
  const { fake, id } = context;

  // Cancelling without force again cannot reach the board that had started, and the
  // answer does not pretend that nothing is left.
  const plain = await context.cancel(id, { force: false });
  assert.equal(plain.status, 409);
  assert.equal(plain.body.error.code, 'already_cancelled');
  assert.match(plain.body.error.message, /1 board is still at work/);
  assert.match(plain.body.error.message, /with force/);
  assert.equal(count(fake, 'cancelJob'), 0);

  // Whether a board is at work is read from the executions, not from the job's counts,
  // which AWS brings up to date later.
  const describe = fake.describeJob;
  fake.describeJob = async (jobId) => {
    const job = await describe(jobId);
    return job === null ? null : { ...job, counts: { ...job.counts, inProgress: 0 } };
  };
  const lagging = await context.cancel(id, { force: false });
  fake.describeJob = describe;
  assert.equal(lagging.body.error.code, 'already_cancelled');

  // Once the board has finished, nothing is left, with or without force.
  fake.execution(id, BOARD_B).update('FAILED', { reason: 'interrupted' });
  for (const force of [false, true]) {
    const done = await context.cancel(id, { force });
    assert.equal(done.status, 409);
    assert.equal(done.body.error.code, 'already_finished');
  }
  assert.equal(count(fake, 'cancelJob'), 0);
  assert.deepEqual(fake.auditLog().slice(-4).map((entry) => [entry.outcome, entry.detail.code]), [
    ['rejected', 'already_cancelled'], ['rejected', 'already_cancelled'],
    ['rejected', 'already_finished'], ['rejected', 'already_finished'],
  ]);
});

// AWS documents what a forced cancellation does to a job that is in progress. It does
// not document what one does to a job that was cancelled before, without force, and
// still has a board at work. The three tests below are the three things it could do.

test('a board at work on a cancelled deployment: AWS refuses the forced cancellation', async () => {
  const context = await cancelledWithBoardAtWork('refused');
  const { fake, id } = context;

  const forced = await context.cancel(id, { force: true });
  assert.equal(forced.status, 409);
  assert.equal(forced.body.error.code, 'cancel_refused');
  assert.match(forced.body.error.message, /AWS did not accept the cancellation/);
  assert.match(forced.body.error.message, /1 board is still at work/);
  assert.equal(count(fake, 'cancelJob'), 1);
  assert.equal(fake.execution(id, BOARD_B).get().status, 'IN_PROGRESS');
  const entry = fake.auditLog().at(-1);
  assert.deepEqual([entry.action, entry.target, entry.outcome, entry.detail],
    ['deployment.cancel', id, 'rejected', { force: 'true', code: 'cancel_refused' }]);
  assert.ok(context.logs.some((line) => line.event === 'cancel_refused' && line.deployment === id));

  // The page keeps showing the board as it is.
  const seen = await context.detail(id);
  assert.deepEqual(seen.executions.map((row) => [row.thing, row.status]),
    [[BOARD_A, 'CANCELED'], [BOARD_B, 'IN_PROGRESS']]);
});

test('a board at work on a cancelled deployment: AWS accepts the forced cancellation', async () => {
  const context = await cancelledWithBoardAtWork('accepted');
  const { fake, id } = context;

  const forced = await context.cancel(id, { force: true });
  assert.equal(forced.status, 200);
  assert.deepEqual(forced.body.deployment.executions.map((row) => row.status), ['CANCELED', 'CANCELED']);
  assert.equal(fake.execution(id, BOARD_B).update('IN_PROGRESS', { step: 'rebooting' }).accepted, false);

  const again = await context.cancel(id, { force: true });
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'already_finished');
});

test('a board at work on a cancelled deployment: AWS accepts the call and changes nothing', async () => {
  const context = await cancelledWithBoardAtWork('ignored');
  const { fake, id } = context;

  // The answer is what AWS holds after the call: the board is still at work.
  const forced = await context.cancel(id, { force: true });
  assert.equal(forced.status, 200);
  assert.equal(forced.body.deployment.status, 'CANCELED');
  assert.deepEqual(forced.body.deployment.executions.map((row) => [row.thing, row.status, row.phase]),
    [[BOARD_A, 'CANCELED', 'cancelled'], [BOARD_B, 'IN_PROGRESS', 'downloading']]);
  assert.equal(forced.body.deployment.counts.inProgress, 1);
  assert.equal(fake.execution(id, BOARD_B).get().status, 'IN_PROGRESS');
  // The log keeps the case, for whoever wants to know what AWS did.
  const line = context.logs.find((item) => item.event === 'cancel_unconfirmed');
  assert.deepEqual(line, { level: 'warn', event: 'cancel_unconfirmed', deployment: id, accepted: true, atWork: 1 });
});

test('a finished or unknown deployment cannot be cancelled', async () => {
  const context = await setup();
  const { fake } = context;
  const id = await context.deploy([BOARD_A]);
  fake.execution(id, BOARD_A).update('REJECTED', { reason: 'declined' });
  fake.calls.length = 0;

  for (const force of [false, true]) {
    const response = await context.cancel(id, { force });
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, 'already_finished');
  }
  assert.equal(count(fake, 'cancelJob'), 0);
  assert.equal(fake.jobs.get(id).status, 'COMPLETED');

  const unknown = await context.cancel('cranium-1-2-3-b4-20261010T221500Z-0000', { force: true });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error.code, 'unknown_deployment');

  // AWS has the last word. A refusal is reported as finished only if nothing is left:
  // here the board ends its update between the look at the job and the cancellation.
  const other = await context.deploy([BOARD_B]);
  const original = fake.cancelJob;
  fake.cancelJob = async (input) => {
    fake.execution(other, BOARD_B).update('REJECTED', { reason: 'declined' });
    return original(input);
  };
  const ended = await context.cancel(other, { force: true });
  assert.equal(ended.status, 409);
  assert.equal(ended.body.error.code, 'already_finished');

  // A refusal while a board is still offered the update is not "finished".
  const open = await context.deploy([BOARD_C]);
  fake.cancelJob = async () => ({ ok: false, reason: 'refused', detail: 'not now' });
  const refused = await context.cancel(open, { force: false });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, 'cancel_refused');
  assert.match(refused.body.error.message, /1 board is still offered this update/);
  // The same while AWS has not created the board's execution yet.
  const listed = fake.listJobExecutionsForJob;
  fake.listJobExecutionsForJob = async () => [];
  const early = await context.cancel(open, { force: false });
  fake.listJobExecutionsForJob = listed;
  assert.equal(early.body.error.code, 'cancel_refused');
  assert.match(early.body.error.message, /the deployment is still open/);

  fake.cancelJob = async () => ({ ok: false, reason: 'not_found' });
  const vanished = await context.cancel(open, { force: true });
  fake.cancelJob = original;
  assert.equal(vanished.status, 404);
  const cancellations = fake.auditLog().filter((entry) => entry.action === 'deployment.cancel');
  assert.deepEqual(cancellations.slice(-4).map((entry) => [entry.outcome, entry.detail.code]), [
    ['rejected', 'already_finished'], ['rejected', 'cancel_refused'], ['rejected', 'cancel_refused'],
    ['rejected', 'unknown_deployment'],
  ]);
  assert.equal(fake.jobs.get(open).status, 'IN_PROGRESS');
});

test('the cancel request itself is validated', async () => {
  const context = await setup();
  const { fake } = context;
  const id = await context.deploy([BOARD_A]);
  fake.calls.length = 0;
  for (const body of [{ force: 'true' }, { force: 1 }, { force: null }, { force: [true] }]) {
    const response = await context.cancel(id, body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(response.body.error.code, 'invalid_force');
  }
  for (const [body, code] of [['', 'invalid_json'], ['true', 'invalid_body'], ['[]', 'invalid_body']]) {
    const response = await context.cancel(id, body);
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, code);
  }
  assert.equal(count(fake, 'cancelJob'), 0);
  assert.equal(count(fake, 'describeJob'), 0);
  assert.equal(fake.jobs.get(id).status, 'IN_PROGRESS');

  // Without the flag a cancel is not forced.
  assert.equal((await context.cancel(id, {})).status, 200);
  assert.equal(fake.calls.find((call) => call.method === 'cancelJob').args[0].force, false);
});

test('one session: upload, deploy, watch, cancel, revoke', async () => {
  const context = await setup();
  const { fake, manager, viewer } = context;
  for (const thing of [BOARD_A, BOARD_B]) fake.device(thing).report(idle());
  await context.upload('valid-1.2.3+5.signed.bin');

  // Deploy 1.2.3+4 to A, which installs it.
  const first = await context.deploy([BOARD_A]);
  fake.device(BOARD_A).report({ ota: { state: 'awaiting_user', job: first } });
  assert.equal((await context.detail(first)).executions[0].phase, 'waiting_for_button');
  fake.execution(first, BOARD_A).update('IN_PROGRESS', { step: 'downloading' });
  fake.device(BOARD_A).report({ ota: { state: 'downloading', progress: 60 } });
  assert.deepEqual((await context.detail(first)).executions.map((row) => [row.phase, row.progress]), [['downloading', 60]]);
  fake.execution(first, BOARD_A).update('IN_PROGRESS', { step: 'rebooting' });
  fake.execution(first, BOARD_A).update('SUCCEEDED', { running: '1.2.3+4' });
  fake.device(BOARD_A).report({ fw: { version: '1.2.3+4', confirmed: true }, ota: { state: 'idle', job: null, progress: 0, last: 'succeeded' } });
  assert.equal((await context.detail(first)).status, 'COMPLETED');

  // Deploy 1.2.3+5 to A, and think better of it before the board has started.
  context.advance(60_000);
  const second = await context.deploy([BOARD_A], '1.2.3+5');
  const cancelled = await context.cancel(second, { force: false });
  assert.deepEqual(cancelled.body.deployment.executions.map((row) => row.phase), ['cancelled']);

  // Deploy it to both; B starts. Then the release turns out to be bad: revoking it
  // stops B as well.
  context.advance(60_000);
  const third = await context.deploy([BOARD_A, BOARD_B], '1.2.3+5');
  fake.execution(third, BOARD_B).update('IN_PROGRESS', { step: 'downloading' });
  const revoked = await context.call('POST', '/api/firmware/1.2.3+5/revoke', { as: manager, body: { reason: 'drops Wi-Fi' } });
  assert.equal(revoked.status, 200);
  assert.deepEqual(revoked.body.cancelled, [third]);
  assert.deepEqual((await context.detail(third)).executions.map((row) => row.phase), ['cancelled', 'cancelled']);
  assert.equal(fake.execution(third, BOARD_B).update('IN_PROGRESS', { step: 'rebooting' }).accepted, false);
  assert.equal((await context.create({ version: '1.2.3+5', things: [BOARD_B] })).body.error.code, 'release_revoked');

  // What a viewer sees afterwards.
  context.advance(6000);
  const firmware = await context.call('GET', '/api/firmware', { as: viewer });
  assert.deepEqual(firmware.body.releases.map((release) => [release.version, release.status]),
    [['1.2.3+5', 'revoked'], ['1.2.3+4', 'active']]);
  const deployments = await context.call('GET', '/api/deployments', { as: viewer });
  assert.deepEqual(deployments.body.deployments.map((entry) => [entry.id, entry.status]),
    [[third, 'CANCELED'], [second, 'CANCELED'], [first, 'COMPLETED']]);
  const audit = await context.call('GET', '/api/audit', { as: viewer });
  assert.deepEqual(audit.body.entries.map((entry) => [entry.action, entry.outcome, entry.target]), [
    ['deployment.create', 'rejected', '1.2.3+5'],
    ['firmware.revoke', 'ok', '1.2.3+5'],
    ['deployment.create', 'ok', third],
    ['deployment.cancel', 'ok', second],
    ['deployment.create', 'ok', second],
    ['deployment.create', 'ok', first],
    ['firmware.upload', 'ok', '1.2.3+5'],
    ['firmware.upload', 'ok', '1.2.3+4'],
  ]);
  assert.ok(audit.body.entries.every((entry) => entry.actor.sub === manager.sub && entry.actor.email === manager.email));
});
