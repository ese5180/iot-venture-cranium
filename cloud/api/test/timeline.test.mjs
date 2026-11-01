// Tests for the phase of a board in a deployment: the execution status decides the
// outcome, the shadow adds the live step and progress while it names this deployment.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { EXECUTION_STATUSES } from '../src/lib/jobs.mjs';
import { deriveTimeline } from '../src/lib/timeline.mjs';

const JOB = 'cranium-1-1-0-b7-20261010T221500Z-9f3a';
const OTHER = 'cranium-1-0-9-b2-20261001T100000Z-0c1d';
const THING = 'cranium-fe5b26c0c5b1dcd7';

/** A board as lib/shadow.mjs describes it. */
function board({ online = true, state = 'idle', job = null, progress = 0 } = {}) {
  return {
    thing: THING, online, lastSeen: '2026-10-10T22:15:00.000Z',
    fw: { version: '1.0.0+3', confirmed: true },
    ota: { state, job, progress, last: 'none', error: '' },
    rssi: -50, uptime: 100,
  };
}

const phase = (input) => deriveTimeline({ jobId: JOB, ...input });

test('every execution status has a phase', () => {
  const expected = {
    QUEUED: 'waiting_for_device',
    IN_PROGRESS: 'downloading',
    SUCCEEDED: 'succeeded',
    FAILED: 'failed',
    TIMED_OUT: 'timed_out',
    REJECTED: 'refused',
    REMOVED: 'removed',
    CANCELED: 'cancelled',
  };
  assert.deepEqual(Object.keys(expected).sort(), [...EXECUTION_STATUSES].sort());
  for (const [status, name] of Object.entries(expected)) {
    assert.deepEqual(phase({ status }), { phase: name, progress: null }, status);
    assert.deepEqual(phase({ status, device: null }), { phase: name, progress: null }, status);
  }
  assert.throws(() => phase({ status: 'PAUSED' }), RangeError);
  assert.throws(() => phase({ status: undefined }), RangeError);
});

test('a queued board waits for the device or for the button', () => {
  const queued = (device) => phase({ status: 'QUEUED', device });
  assert.equal(queued(board({ state: 'awaiting_user', job: JOB })).phase, 'waiting_for_button');
  // Offline, or it has not picked this deployment up.
  assert.equal(queued(board({ online: false, state: 'awaiting_user', job: JOB })).phase, 'waiting_for_device');
  assert.equal(queued(board({ state: 'idle' })).phase, 'waiting_for_device');
  assert.equal(queued(board({ state: 'awaiting_user', job: null })).phase, 'waiting_for_device');
  assert.equal(queued(board({ state: 'awaiting_user', job: OTHER })).phase, 'waiting_for_device');
  assert.equal(queued({ ...board(), ota: null }).phase, 'waiting_for_device');
  assert.equal(queued({ ...board(), online: 'yes', ota: { state: 'awaiting_user', job: JOB } }).phase, 'waiting_for_device');
  assert.equal(queued(board({ state: 'idle', job: JOB })).phase, 'waiting_for_device');
});

test('a board that says it has started is starting until AWS says so too, and is not at a button', () => {
  const queued = (device) => phase({ status: 'QUEUED', device });
  // The firmware reports "downloading" a moment before AWS has accepted the start: as soon as
  // it sees the job from 1.7.2 on, and after Button 1 before that. The execution, not the
  // shadow, says whether the update has started, so that is no download yet, and the phase
  // does not fall back to the board not having picked it up.
  assert.deepEqual(queued(board({ state: 'downloading', job: JOB, progress: 0 })),
    { phase: 'starting', progress: null });
  assert.deepEqual(queued(board({ state: 'downloading', job: JOB, progress: 50 })),
    { phase: 'starting', progress: null });
  // The same for anything else a board may claim about a deployment it holds.
  for (const state of ['verifying', 'rebooting', 'testing']) {
    assert.deepEqual(queued(board({ state, job: JOB, progress: 100 })), { phase: 'starting', progress: null }, state);
  }
  // Only awaiting_user is a board at its button. A state nobody knows claims neither.
  assert.equal(queued({ ...board(), ota: { state: 'something_new', job: JOB } }).phase, 'waiting_for_device');
  // Not for another deployment, and not while the board is offline.
  assert.equal(queued(board({ state: 'downloading', job: OTHER, progress: 50 })).phase, 'waiting_for_device');
  assert.equal(queued(board({ online: false, state: 'downloading', job: JOB })).phase, 'waiting_for_device');

  // Seen as a board that asks goes through it, the phase only moves forward.
  const asking = [
    ['QUEUED', board({ state: 'idle' })],
    ['QUEUED', board({ state: 'awaiting_user', job: JOB })],
    ['QUEUED', board({ state: 'downloading', job: JOB })],
    ['IN_PROGRESS', board({ state: 'downloading', job: JOB, progress: 10 })],
  ];
  assert.deepEqual(asking.map(([status, device]) => phase({ status, step: 'downloading', device }).phase),
    ['waiting_for_device', 'waiting_for_button', 'starting', 'downloading']);

  // And one that does not ask never comes to a button.
  const notAsking = [
    ['QUEUED', board({ state: 'idle' })],
    ['QUEUED', board({ state: 'downloading', job: JOB })],
    ['IN_PROGRESS', board({ state: 'downloading', job: JOB, progress: 10 })],
  ];
  assert.deepEqual(notAsking.map(([status, device]) => phase({ status, step: 'downloading', device }).phase),
    ['waiting_for_device', 'starting', 'downloading']);
});

test('a running update shows the live step and progress from the shadow', () => {
  const running = (step, device) => phase({ status: 'IN_PROGRESS', step, device });

  assert.deepEqual(running('downloading', board({ state: 'downloading', job: JOB, progress: 40 })),
    { phase: 'downloading', progress: 40 });
  assert.deepEqual(running('downloading', board({ state: 'verifying', job: JOB, progress: 100 })),
    { phase: 'verifying', progress: 100 });
  assert.deepEqual(running('rebooting', board({ state: 'rebooting', job: JOB, progress: 100 })),
    { phase: 'rebooting', progress: 100 });
  assert.deepEqual(running('rebooting', board({ state: 'testing', job: JOB, progress: 100 })),
    { phase: 'testing', progress: 100 });
  // An offline board keeps the last step it reported.
  assert.deepEqual(running('downloading', board({ online: false, state: 'downloading', job: JOB, progress: 70 })),
    { phase: 'downloading', progress: 70 });
});

test('without a shadow for this deployment the execution alone gives the step', () => {
  const running = (step, device) => phase({ status: 'IN_PROGRESS', step, device });
  assert.deepEqual(running('downloading', null), { phase: 'downloading', progress: null });
  assert.deepEqual(running('rebooting', null), { phase: 'rebooting', progress: null });
  assert.deepEqual(running(null, null), { phase: 'downloading', progress: null });
  assert.deepEqual(running('something_else', board()), { phase: 'downloading', progress: null });
  // The shadow talks about another deployment, or about none.
  assert.deepEqual(running('downloading', board({ state: 'testing', job: OTHER, progress: 100 })),
    { phase: 'downloading', progress: null });
  assert.deepEqual(running('rebooting', board({ state: 'downloading', job: null, progress: 30 })),
    { phase: 'rebooting', progress: null });
  // The shadow names this deployment but is not in an update step.
  assert.deepEqual(running('downloading', board({ state: 'awaiting_user', job: JOB })),
    { phase: 'downloading', progress: null });
  assert.deepEqual(running('rebooting', board({ state: 'idle', job: JOB })),
    { phase: 'rebooting', progress: null });
});

test('an update only moves forward: the later of the two sources wins', () => {
  const running = (step, state, progress = 100) =>
    phase({ status: 'IN_PROGRESS', step, device: board({ state, job: JOB, progress }) });
  // The shadow lags behind the execution.
  assert.deepEqual(running('rebooting', 'downloading', 80), { phase: 'rebooting', progress: null });
  assert.deepEqual(running('rebooting', 'verifying'), { phase: 'rebooting', progress: null });
  // The execution lags behind the shadow.
  assert.deepEqual(running('downloading', 'rebooting'), { phase: 'rebooting', progress: 100 });
  assert.deepEqual(running('downloading', 'testing'), { phase: 'testing', progress: 100 });
});

test('the board\'s reason tells rolled back from failed and declined from refused', () => {
  assert.equal(phase({ status: 'FAILED', reason: 'rolled_back' }).phase, 'rolled_back');
  for (const reason of ['download_failed', 'digest_mismatch', 'header_mismatch', 'flash_error', 'interrupted',
    'not_installed', 'declined', null, undefined, 'something_new']) {
    assert.equal(phase({ status: 'FAILED', reason }).phase, 'failed', String(reason));
  }
  assert.equal(phase({ status: 'REJECTED', reason: 'declined' }).phase, 'declined');
  for (const reason of ['bad_document', 'unsupported', 'url_not_allowed', 'not_newer', 'too_large', 'rolled_back',
    null, undefined, 'something_new']) {
    assert.equal(phase({ status: 'REJECTED', reason }).phase, 'refused', String(reason));
  }
});

test('an outcome is never changed by what the shadow says', () => {
  const claims = board({ state: 'testing', job: JOB, progress: 100 });
  const idle = board({ state: 'idle', job: null });
  for (const device of [claims, idle, null]) {
    assert.deepEqual(phase({ status: 'SUCCEEDED', device }), { phase: 'succeeded', progress: null });
    assert.deepEqual(phase({ status: 'FAILED', reason: 'flash_error', device }), { phase: 'failed', progress: null });
    assert.deepEqual(phase({ status: 'REJECTED', reason: 'not_newer', device }), { phase: 'refused', progress: null });
    // Cancelled and timed out stay that way even if the board went on by itself.
    assert.deepEqual(phase({ status: 'CANCELED', device }), { phase: 'cancelled', progress: null });
    assert.deepEqual(phase({ status: 'TIMED_OUT', device }), { phase: 'timed_out', progress: null });
    assert.deepEqual(phase({ status: 'REMOVED', device }), { phase: 'removed', progress: null });
  }
  // A reason only counts for the status it belongs to.
  assert.equal(phase({ status: 'CANCELED', reason: 'rolled_back' }).phase, 'cancelled');
  assert.equal(phase({ status: 'SUCCEEDED', reason: 'declined' }).phase, 'succeeded');
  assert.equal(phase({ status: 'TIMED_OUT', reason: 'declined', step: 'rebooting' }).phase, 'timed_out');
});
