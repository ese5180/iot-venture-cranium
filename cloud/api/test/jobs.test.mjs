// Tests for deployments as AWS IoT jobs: the id, the document a board receives, the
// description that records who created it, and reading all of that back.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  IN_PROGRESS_TIMEOUT_MIN, URL_EXPIRES_SEC, buildJobDescription, buildJobDocument, buildJobId,
  countExecutions, emptyCounts, executionDetails, isActiveExecution, isSettled, isoTime, mapLimit,
  parseJobDescription, summarizeJob,
} from '../src/lib/jobs.mjs';
import { parseJobId } from '../src/lib/validate.mjs';

const NOW = Date.UTC(2026, 9, 10, 22, 15, 0);
const SHA = 'a3'.repeat(32);
const THING = 'cranium-fe5b26c0c5b1dcd7';
const MAX_VERSION = { major: 255, minor: 255, revision: 65535, build: 4294967295 };

test('a job id carries the version, the time and four random hex digits', () => {
  const id = buildJobId({ major: 1, minor: 1, revision: 0, build: 7 }, NOW, '9f3a');
  assert.equal(id, 'cranium-1-1-0-b7-20261010T221500Z-9f3a');
  assert.equal(parseJobId(id).version, '1.1.0+7');
  // The fraction of a second is dropped, not rounded.
  assert.equal(buildJobId({ major: 0, minor: 0, revision: 1, build: 0 }, NOW + 999, '0000'),
    'cranium-0-0-1-b0-20261010T221500Z-0000');
});

test('the id of the highest possible version fits the 64 characters AWS allows', () => {
  const id = buildJobId(MAX_VERSION, Date.UTC(2099, 11, 31, 23, 59, 59), 'ffff');
  assert.equal(id, 'cranium-255-255-65535-b4294967295-20991231T235959Z-ffff');
  assert.equal(id.length, 55);
  assert.ok(id.length <= 64);
  assert.match(id, /^[a-zA-Z0-9_-]{1,64}$/);
  assert.equal(parseJobId(id).version, '255.255.65535+4294967295');
});

test('a job id is only built from a proper random suffix', () => {
  const parts = { major: 1, minor: 0, revision: 0, build: 0 };
  for (const suffix of ['', '9f3', '9f3a0', '9F3A', 'zzzz', null, undefined, 0x9f3a]) {
    assert.throws(() => buildJobId(parts, NOW, suffix), TypeError);
  }
  assert.throws(() => buildJobId({ ...parts, major: 256 }, NOW, '9f3a'), TypeError);
});

test('the job document is what the device contract says', () => {
  const text = buildJobDocument({
    version: '1.1.0+7', size: 815284, sha256: SHA, region: 'us-east-1', bucket: 'cranium-ota-firmware-1abc2def3ghi',
  });
  assert.deepEqual(JSON.parse(text), {
    op: 'fw_update',
    v: 1,
    fw: {
      version: '1.1.0+7',
      size: 815284,
      sha256: SHA,
      url: `\${aws:iot:s3-presigned-url-v2:https://s3.us-east-1.amazonaws.com/cranium-ota-firmware-1abc2def3ghi/firmware/${SHA}.bin}`,
    },
  });
  // Compact, in the order of the contract, and nothing in the URL needs encoding.
  assert.ok(text.startsWith('{"op":"fw_update","v":1,"fw":{"version":"1.1.0+7","size":815284,"sha256":"'));
  assert.equal(/[\s%+]/.test(JSON.parse(text).fw.url), false);
});

test('the largest possible job document stays below 512 bytes', () => {
  // The highest version, the longest bucket name S3 allows, and a region name longer
  // than any that exists: the longest of every value the builder accepts.
  const text = buildJobDocument({
    version: '255.255.65535+4294967295',
    size: Number.MAX_SAFE_INTEGER,
    sha256: 'f'.repeat(64),
    region: 'r'.repeat(32),
    bucket: `a${'b'.repeat(61)}c`,
  });
  assert.equal(JSON.parse(text).fw.url.includes('b'.repeat(61)), true);
  assert.equal(Buffer.byteLength(text), 407);
  assert.ok(Buffer.byteLength(text) < 512);
  assert.throws(() => buildJobDocument({
    version: '1.0.0+0', size: 1, sha256: 'f'.repeat(64), region: 'r'.repeat(33), bucket: 'firmware-bucket',
  }), TypeError);
});

test('a job document is never built from values that do not fit', () => {
  const good = { version: '1.1.0+7', size: 815284, sha256: SHA, region: 'us-east-1', bucket: 'firmware-bucket' };
  assert.ok(buildJobDocument(good));
  const bad = [
    { version: '1.1.0' }, { version: '01.1.0+7' }, { version: null },
    { size: 0 }, { size: -1 }, { size: 1.5 }, { size: '815284' },
    { sha256: SHA.toUpperCase() }, { sha256: SHA.slice(1) }, { sha256: `${SHA}0` }, { sha256: null },
    { region: 'us-east-1/../x' }, { region: 'US-EAST-1' }, { region: '' }, { region: 'us east 1' },
    { bucket: 'Has-Capitals' }, { bucket: 'has/slash' }, { bucket: 'a}b' }, { bucket: 'ab' }, { bucket: 'x'.repeat(64) },
    { bucket: 'has space' }, { bucket: '' },
  ];
  for (const change of bad) {
    assert.throws(() => buildJobDocument({ ...good, ...change }), TypeError, JSON.stringify(change));
  }
});

test('the job description records who created the deployment, as compact JSON', () => {
  const sub = '11111111-2222-4333-8444-555555555555';
  const by = ['manager', 'example.invalid'].join('@');
  const text = buildJobDescription({ email: by, sub, note: 'for the demo' });
  assert.equal(text, `{"by":"${by}","sub":"${sub}","note":"for the demo"}`);
  assert.deepEqual(parseJobDescription(text), { createdBy: { sub, email: by }, note: 'for the demo' });
});

test('a description is plain ASCII whatever the note contains', () => {
  const sub = '11111111-2222-4333-8444-555555555555';
  const note = 'Größe "4 µm" \\ naïve ☕ 😀';
  const text = buildJobDescription({ email: '', sub, note });
  assert.match(text, /^[\x20-\x7e]+$/);
  assert.equal(parseJobDescription(text).note, note);
  assert.equal(JSON.parse(text).note, note);

  // The longest note still fits what AWS IoT accepts; the address is dropped first.
  const longest = buildJobDescription({ email: `${'m'.repeat(300)}`, sub, note: '😀'.repeat(100) });
  assert.ok(longest.length <= 2028);
  assert.equal(parseJobDescription(longest).note, '😀'.repeat(100));
  const tight = buildJobDescription({ email: 'é'.repeat(320), sub, note: '😀'.repeat(100) });
  assert.ok(tight.length <= 2028, String(tight.length));
  assert.deepEqual(parseJobDescription(tight), { createdBy: { sub, email: '' }, note: '😀'.repeat(100) });
});

test('a description written by someone else is not trusted', () => {
  const nobody = { createdBy: null, note: '' };
  for (const text of [undefined, null, '', 'plain text', '[]', '"text"', '5', 'null', '{', 7, {}, 'x'.repeat(3000)]) {
    assert.deepEqual(parseJobDescription(text), nobody, String(text).slice(0, 20));
  }
  assert.deepEqual(parseJobDescription('{"by":"x","note":"hello"}'), { createdBy: null, note: 'hello' });
  assert.deepEqual(parseJobDescription('{"sub":5,"by":["a"],"note":{"a":1}}'), nobody);
  assert.deepEqual(parseJobDescription('{"sub":"abc","by":"line\\nbreak","note":"bell\\u0007"}'),
    { createdBy: { sub: 'abc', email: '' }, note: '' });
  assert.deepEqual(parseJobDescription(JSON.stringify({ sub: 'abc', by: 'x', note: 'n'.repeat(201) })),
    { createdBy: { sub: 'abc', email: 'x' }, note: '' });
  assert.deepEqual(parseJobDescription('{"sub":"abc","__proto__":{"note":"inherited"}}'),
    { createdBy: { sub: 'abc', email: '' }, note: '' });
  // A sub that is not a line of reasonable length names nobody.
  for (const sub of ['a\\u0000b', 'a\\nb', '\\u202eabc', 'x'.repeat(129), '']) {
    assert.deepEqual(parseJobDescription(`{"sub":"${sub}","by":"x","note":"n"}`), { createdBy: null, note: 'n' }, sub);
  }
  assert.deepEqual(parseJobDescription('{"__proto__":{"sub":"abc"},"note":"n"}'), { createdBy: null, note: 'n' });
});

test('a job becomes a DeploymentSummary', () => {
  const job = {
    jobId: 'cranium-1-1-0-b7-20261010T221500Z-9f3a',
    status: 'IN_PROGRESS',
    description: '{"by":"someone","sub":"abc","note":"hello"}',
    things: [THING, 'cranium-0000000000000001', 'not-a-board', THING],
    createdAt: NOW,
    lastUpdatedAt: NOW + 5000,
    completedAt: null,
    counts: { ...emptyCounts(), queued: 1, inProgress: 1 },
  };
  assert.deepEqual(summarizeJob(job), {
    id: 'cranium-1-1-0-b7-20261010T221500Z-9f3a',
    version: '1.1.0+7',
    status: 'IN_PROGRESS',
    createdAt: '2026-10-10T22:15:00.000Z',
    completedAt: null,
    createdBy: { sub: 'abc', email: 'someone' },
    note: 'hello',
    things: ['cranium-0000000000000001', THING],
    counts: { ...emptyCounts(), queued: 1, inProgress: 1 },
  });

  const done = summarizeJob({ ...job, status: 'COMPLETED', completedAt: NOW + 60000, counts: { ...emptyCounts(), succeeded: 2 } });
  assert.equal(done.completedAt, '2026-10-10T22:16:00.000Z');
  assert.equal(isSettled(done), true);
  assert.equal(isSettled(summarizeJob(job)), false);
  // Cancelled without force: boards that had started are still running.
  assert.equal(isSettled(summarizeJob({ ...job, status: 'CANCELED', counts: { ...emptyCounts(), canceled: 1, inProgress: 1 } })), false);
  assert.equal(isSettled(summarizeJob({ ...job, status: 'CANCELED', counts: { ...emptyCounts(), canceled: 2 } })), true);
  // The status can be ahead of the counts: not settled until every board is counted.
  assert.equal(isSettled(summarizeJob({ ...job, status: 'CANCELED', counts: { ...emptyCounts(), canceled: 1 } })), false);
  assert.equal(isSettled(summarizeJob({ ...job, status: 'CANCELED', counts: emptyCounts() })), false);
  assert.equal(isSettled(summarizeJob({ ...job, status: 'COMPLETED', counts: { ...emptyCounts(), succeeded: 1 } })), false);
  assert.equal(isSettled(summarizeJob({ ...job, status: 'COMPLETED', counts: { ...emptyCounts(), succeeded: 1, queued: 1 } })), false);
  assert.equal(isSettled(summarizeJob({ ...job, status: 'COMPLETED', counts: { ...emptyCounts(), failed: 1, timedOut: 1 } })), true);
  for (const status of ['IN_PROGRESS', 'SCHEDULED', 'DELETION_IN_PROGRESS']) {
    assert.equal(isSettled(summarizeJob({ ...job, status, counts: { ...emptyCounts(), succeeded: 2 } })), false, status);
  }
});

test('boards of a new job count as queued until AWS has created their executions', () => {
  const job = {
    jobId: 'cranium-1-1-0-b7-20261010T221500Z-9f3a', status: 'IN_PROGRESS', description: '',
    things: [THING, 'cranium-0000000000000001'], createdAt: NOW, lastUpdatedAt: NOW, completedAt: null,
    counts: emptyCounts(),
  };
  assert.equal(summarizeJob(job).counts.queued, 2);
  assert.equal(summarizeJob({ ...job, counts: { ...emptyCounts(), succeeded: 1 } }).counts.queued, 1);
  assert.equal(summarizeJob({ ...job, counts: { ...emptyCounts(), succeeded: 1, queued: 1 } }).counts.queued, 1);
  // Only while the job is in progress.
  assert.equal(summarizeJob({ ...job, status: 'CANCELED' }).counts.queued, 0);
  assert.equal(summarizeJob({ ...job, status: 'COMPLETED' }).counts.queued, 0);
});

test('jobs of other tools and malformed jobs are not deployments', () => {
  const job = {
    jobId: 'cranium-1-1-0-b7-20261010T221500Z-9f3a', status: 'IN_PROGRESS', description: '', things: [THING],
    createdAt: NOW, lastUpdatedAt: NOW, completedAt: null, counts: emptyCounts(),
  };
  assert.ok(summarizeJob(job));
  assert.equal(summarizeJob(null), null);
  assert.equal(summarizeJob(undefined), null);
  assert.equal(summarizeJob({ ...job, jobId: 'AFR_OTA-update-7' }), null);
  assert.equal(summarizeJob({ ...job, jobId: 'cranium-999-1-0-b7-20261010T221500Z-9f3a' }), null);
  assert.equal(summarizeJob({ ...job, status: 'PAUSED' }), null);
  assert.equal(summarizeJob({ ...job, status: null }), null);
  // Without a creation time from AWS, the time in the id is used.
  assert.equal(summarizeJob({ ...job, createdAt: null }).createdAt, '2026-10-10T22:15:00.000Z');
  // Counts that are not counts are ignored.
  const odd = summarizeJob({ ...job, status: 'CANCELED', things: 'x', counts: { queued: -3, failed: '2', succeeded: 1.5, canceled: 1 } });
  assert.deepEqual(odd.counts, { ...emptyCounts(), canceled: 1 });
  assert.deepEqual(odd.things, []);
});

test('what a board wrote into its execution is reduced to the contract', () => {
  assert.deepEqual(executionDetails({ step: 'downloading' }),
    { reason: null, detail: null, step: 'downloading', running: null });
  assert.deepEqual(executionDetails({ reason: 'digest_mismatch', detail: 'sha256 differs at 0x1000', running: '1.0.0+3' }),
    { reason: 'digest_mismatch', detail: 'sha256 differs at 0x1000', step: null, running: '1.0.0+3' });

  const nothing = { reason: null, detail: null, step: null, running: null };
  for (const value of [null, undefined, 'reason=declined', 5, [], [{ reason: 'declined' }]]) {
    assert.deepEqual(executionDetails(value), nothing);
  }
  assert.deepEqual(executionDetails(Object.create({ reason: 'declined', step: 'rebooting' })), nothing);

  const hostile = executionDetails({
    reason: '<img src=x onerror=alert(1)>',
    detail: 'line one\nline two',
    step: 'installing',
    running: '1.0.0',
    admin: 'true',
    __proto__: { reason: 'declined' },
  });
  assert.deepEqual(hostile, nothing);

  for (const reason of ['Declined', 'has space', '9lives', 'x'.repeat(33), '', 5, null, ['declined']]) {
    assert.equal(executionDetails({ reason }).reason, null, JSON.stringify(reason));
  }
  assert.equal(executionDetails({ reason: 'a_reason_added_by_new_firmware' }).reason, 'a_reason_added_by_new_firmware');
  for (const detail of ['', 'x'.repeat(201), 'tab\there', 'café', '\u202eabc', 7, null]) {
    assert.equal(executionDetails({ detail }).detail, null, JSON.stringify(detail));
  }
  assert.equal(executionDetails({ detail: 'x'.repeat(200) }).detail.length, 200);
  for (const running of ['1.0.0', '01.0.0+3', '1.0.0+3\n', 'latest', 103, null]) {
    assert.equal(executionDetails({ running }).running, null, JSON.stringify(running));
  }
});

test('execution statuses are counted and classified', () => {
  assert.deepEqual(countExecutions([
    { status: 'QUEUED' }, { status: 'QUEUED' }, { status: 'IN_PROGRESS' }, { status: 'SUCCEEDED' },
    { status: 'FAILED' }, { status: 'REJECTED' }, { status: 'CANCELED' }, { status: 'TIMED_OUT' },
    { status: 'REMOVED' }, { status: 'toString' },
  ]), { queued: 2, inProgress: 1, succeeded: 1, failed: 1, rejected: 1, canceled: 1, timedOut: 1, removed: 1 });
  assert.equal(isActiveExecution('QUEUED'), true);
  assert.equal(isActiveExecution('IN_PROGRESS'), true);
  for (const status of ['SUCCEEDED', 'FAILED', 'REJECTED', 'CANCELED', 'TIMED_OUT', 'REMOVED', undefined]) {
    assert.equal(isActiveExecution(status), false);
  }
  assert.equal(URL_EXPIRES_SEC, 600);
  assert.equal(IN_PROGRESS_TIMEOUT_MIN, 30);
  assert.equal(isoTime(NOW), '2026-10-10T22:15:00.000Z');
  for (const value of [null, undefined, NaN, Infinity, 1e17, '5']) assert.equal(isoTime(value), null);
});

test('mapLimit keeps the order and never runs more tasks than allowed', async () => {
  let running = 0;
  let most = 0;
  const results = await mapLimit([5, 1, 4, 2, 3, 0, 6, 2], 3, async (value, index) => {
    running += 1;
    most = Math.max(most, running);
    await new Promise((resolve) => setTimeout(resolve, value));
    running -= 1;
    return `${index}:${value}`;
  });
  assert.deepEqual(results, ['0:5', '1:1', '2:4', '3:2', '4:3', '5:0', '6:6', '7:2']);
  assert.equal(most, 3);
  assert.deepEqual(await mapLimit([], 5, async () => 1), []);

  // After a failure no further task is started.
  let started = 0;
  await assert.rejects(mapLimit([1, 2, 3, 4, 5, 6], 2, async (value) => {
    started += 1;
    if (value === 2) throw new Error('stop');
    await new Promise((resolve) => setTimeout(resolve, 5));
    return value;
  }), /stop/);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(started <= 3, `${started} tasks started`);
});
