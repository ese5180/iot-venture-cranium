// An in-memory stand-in for src/aws.mjs.
//
// It implements the adapter interface documented at the top of src/aws.mjs with the
// same inputs, outputs and failure modes, and keeps to the rules of the AWS services
// behind it where the console depends on them: write-once objects, conditional and
// transactional table writes, job and execution state, the limits AWS puts on ids,
// descriptions and comments. It starts empty. Nothing in it is a sample record: what
// it holds is what a test or a preview session put there.
//
// On top of the adapter methods it has helpers that play the parts the console does
// not: the provisioning tool (addThing), the user administrator (addUser, user) and
// the boards (device, execution):
//
//   const fake = createFakeAws({ now });
//   fake.addThing('cranium-0123456789abcdef', { certificates: ['<64 hex>'] });
//   fake.addUser({ sub, email, groups: ['release-managers'] });
//   fake.device(thing).report({ fw: { version: '1.0.0+3', confirmed: true }, uptime: 60, ... });
//   fake.device(thing).nextJob();                    // { jobId, status, document } or null
//   fake.execution(jobId, thing).update('IN_PROGRESS', { step: 'downloading' });   // { accepted: true }
//
// A board that follows the device contract goes: report ota.state "awaiting_user" with
// ota.job; update IN_PROGRESS step=downloading; report "downloading" with progress;
// report "verifying"; update IN_PROGRESS step=rebooting; report "rebooting", then
// "testing" with the new fw.version; update SUCCEEDED running=<version>; report "idle".
// Every report also counts as a sign of life: a board is online for 150 s after one.
//
// Time comes from the `now` function passed in (the system clock by default). Jobs
// behave as in AWS IoT: an execution in progress times out after the job's timeout, a
// snapshot job completes when all its executions have ended, and a cancelled job stays
// cancelled. fake.calls lists every adapter call; fake.failNext makes one fail.
//
// Also exported: fixture and fakeEnv (the fixture images and a configuration that
// accepts them), accessClaims and apiEvent (a request as API Gateway delivers it), and
// createTestConsole (the real handlers on a fake, as the tests use them).
//
// This file is test and preview code. It is never packaged with the function.

import { createHash, createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { createApp } from '../src/app.mjs';
import { loadConfig } from '../src/config.mjs';

const THING_NAME = /^[a-zA-Z0-9:_-]{1,128}$/;
const JOB_ID = /^[a-zA-Z0-9_-]{1,64}$/;
const NO_CONTROL = /^[^\p{C}]+$/u;
const REASON_CODE = /^[\p{Lu}\p{Nd}_]+$/u;
const DETAIL_KEY = /^[a-zA-Z0-9:_-]{1,128}$/;
const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'REJECTED', 'REMOVED', 'CANCELED']);
const DEVICE_STATUSES = new Set(['IN_PROGRESS', 'SUCCEEDED', 'FAILED', 'REJECTED']);
const ACCOUNT = '000000000000';
const REGION = 'us-east-1';

/** The error src/aws.mjs throws for a failure a handler cannot act on. */
export function awsError(operation, awsName, { code = 'failed', status = null } = {}) {
  const error = new Error(`${operation}: ${awsName}`);
  error.name = 'AwsError';
  error.code = code;
  error.operation = operation;
  error.awsError = awsName;
  error.awsStatus = status;
  return error;
}

function invalid(operation, why) {
  const error = awsError(operation, 'InvalidRequestException', { status: 400 });
  error.message = `${operation}: InvalidRequestException: ${why}`;
  return error;
}

/** A deep copy of plain data, as it would come back from a service. */
function copy(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/** Refuse what the real adapter cannot store in a table. */
function assertStorable(value, path = 'item') {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${path} is not a finite number`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertStorable(entry, `${path}[${index}]`));
    return;
  }
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [key, entry] of Object.entries(value)) {
      if (entry !== undefined) assertStorable(entry, `${path}.${key}`);
    }
    return;
  }
  throw new TypeError(`${path} cannot be stored`);
}

/** Merge a shadow update into a document the way AWS IoT does: null deletes a key. */
function mergeReported(state, metadata, update, stamp) {
  for (const [key, value] of Object.entries(update)) {
    if (value === null) {
      delete state[key];
      delete metadata[key];
    } else if (typeof value === 'object' && !Array.isArray(value)) {
      if (typeof state[key] !== 'object' || state[key] === null || Array.isArray(state[key])) {
        state[key] = {};
        metadata[key] = {};
      }
      mergeReported(state[key], metadata[key], value, stamp);
    } else {
      state[key] = copy(value);
      metadata[key] = Array.isArray(value) ? value.map(() => ({ timestamp: stamp })) : { timestamp: stamp };
    }
  }
}

/**
 * @param {object} [options]
 * @param {() => number} [options.now]           the clock, epoch milliseconds
 * @param {number} [options.rolloutDelayMs]      how long after a job is created its
 *                                               executions appear (AWS creates them
 *                                               shortly after the job, not with it)
 */
export function createFakeAws({ now = Date.now, rolloutDelayMs = 0 } = {}) {
  const things = new Map();     // name -> { inGroup, principals }
  const shadows = new Map();    // name -> shadow document
  const booted = new Map();     // name -> when the board's uptime started, in ms
  const jobs = new Map();       // jobId -> job
  const objects = new Map();    // key -> { body, contentType, sha256Base64, tags }
  const releases = new Map();   // sk -> item
  const auditItems = new Map(); // sk -> item
  const users = new Map();      // sub -> { email, enabled, status, groups }
  const faults = new Map();     // method -> [error | () => error]
  const calls = [];
  let highest;                  // the pointer item's value

  const clock = () => {
    const value = now();
    return value instanceof Date ? value.getTime() : value;
  };

  function newExecution(at) {
    return {
      status: 'QUEUED', queuedAt: at, startedAt: null, lastUpdatedAt: at, executionNumber: 1,
      versionNumber: 1, statusDetails: {}, forceCanceled: false,
    };
  }

  /** Bring a job up to the current time: roll out, time out, complete. */
  function settle(job) {
    const at = clock();
    if (!job.rolledOut && at >= job.rolloutAt) {
      job.rolledOut = true;
      if (job.status === 'IN_PROGRESS') {
        for (const thing of job.things) job.executions.set(thing, newExecution(job.rolloutAt));
      }
    }
    for (const execution of job.executions.values()) {
      if (execution.status === 'IN_PROGRESS' && at - execution.startedAt >= job.timeoutMs) {
        execution.status = 'TIMED_OUT';
        execution.lastUpdatedAt = execution.startedAt + job.timeoutMs;
        execution.versionNumber += 1;
      }
    }
    if (job.status === 'IN_PROGRESS' && job.rolledOut &&
        [...job.executions.values()].every((execution) => TERMINAL.has(execution.status))) {
      job.status = 'COMPLETED';
      job.completedAt = Math.max(job.createdAt, ...[...job.executions.values()].map((e) => e.lastUpdatedAt));
      job.lastUpdatedAt = job.completedAt;
    }
    return job;
  }

  function countsOf(job) {
    const counts = { queued: 0, inProgress: 0, succeeded: 0, failed: 0, rejected: 0, canceled: 0, timedOut: 0, removed: 0 };
    const names = {
      QUEUED: 'queued', IN_PROGRESS: 'inProgress', SUCCEEDED: 'succeeded', FAILED: 'failed',
      REJECTED: 'rejected', CANCELED: 'canceled', TIMED_OUT: 'timedOut', REMOVED: 'removed',
    };
    for (const execution of job.executions.values()) counts[names[execution.status]] += 1;
    return counts;
  }

  function summaryOf(execution) {
    return {
      status: execution.status, queuedAt: execution.queuedAt, startedAt: execution.startedAt,
      lastUpdatedAt: execution.lastUpdatedAt, executionNumber: execution.executionNumber,
    };
  }

  function checkThingName(operation, thing) {
    if (typeof thing !== 'string' || !THING_NAME.test(thing)) throw invalid(operation, 'thing name');
  }

  function checkJobId(operation, jobId) {
    if (typeof jobId !== 'string' || !JOB_ID.test(jobId)) throw invalid(operation, 'job id');
  }

  const adapter = {
    async listGroupThings() {
      return [...things].filter(([, thing]) => thing.inGroup).map(([name]) => name).reverse();
    },

    async listThingPrincipals(thing) {
      checkThingName('ListThingPrincipals', thing);
      return things.has(thing) ? [...things.get(thing).principals] : [];
    },

    async getShadow(thing) {
      checkThingName('GetThingShadow', thing);
      return shadows.has(thing) ? copy(shadows.get(thing)) : null;
    },

    async listJobs() {
      return [...jobs.values()].map(settle).map((job) => ({
        jobId: job.jobId, status: job.status, createdAt: job.createdAt, lastUpdatedAt: job.lastUpdatedAt,
        completedAt: job.completedAt,
      }));
    },

    async describeJob(jobId) {
      checkJobId('DescribeJob', jobId);
      if (!jobs.has(jobId)) return null;
      const job = settle(jobs.get(jobId));
      return {
        jobId: job.jobId, status: job.status, description: job.description, things: [...job.things],
        createdAt: job.createdAt, lastUpdatedAt: job.lastUpdatedAt, completedAt: job.completedAt,
        forceCanceled: job.forceCanceled, reasonCode: job.reasonCode, counts: countsOf(job),
      };
    },

    async listJobExecutionsForJob(jobId) {
      checkJobId('ListJobExecutionsForJob', jobId);
      if (!jobs.has(jobId)) return [];
      const job = settle(jobs.get(jobId));
      return [...job.executions].map(([thing, execution]) => ({ thing, ...summaryOf(execution) }));
    },

    async describeJobExecution(jobId, thing) {
      checkJobId('DescribeJobExecution', jobId);
      checkThingName('DescribeJobExecution', thing);
      const job = jobs.has(jobId) ? settle(jobs.get(jobId)) : null;
      const execution = job?.executions.get(thing);
      if (execution === undefined) return null;
      const left = execution.status === 'IN_PROGRESS'
        ? Math.max(0, Math.ceil((execution.startedAt + job.timeoutMs - clock()) / 1000))
        : null;
      return {
        thing, ...summaryOf(execution), statusDetails: { ...execution.statusDetails }, secondsLeft: left,
        forceCanceled: execution.forceCanceled,
      };
    },

    async listJobExecutionsForThing(thing) {
      checkThingName('ListJobExecutionsForThing', thing);
      if (!things.has(thing)) return [];
      const found = [];
      for (const job of jobs.values()) {
        const execution = settle(job).executions.get(thing);
        if (execution !== undefined) found.push({ jobId: job.jobId, ...summaryOf(execution) });
      }
      return found;
    },

    async createJob({ jobId, things: targets, document, description, urlExpiresInSec, inProgressTimeoutMinutes }) {
      checkJobId('CreateJob', jobId);
      if (!Array.isArray(targets) || targets.length === 0) throw invalid('CreateJob', 'targets');
      targets.forEach((thing) => checkThingName('CreateJob', thing));
      if (typeof document !== 'string' || document.length > 32768) throw invalid('CreateJob', 'document');
      try {
        JSON.parse(document);
      } catch {
        throw invalid('CreateJob', 'document is not JSON');
      }
      if (typeof description !== 'string' || description.length > 2028 || !NO_CONTROL.test(description)) {
        throw invalid('CreateJob', 'description');
      }
      if (!Number.isInteger(urlExpiresInSec) || urlExpiresInSec < 60 || urlExpiresInSec > 3600) {
        throw invalid('CreateJob', 'presignedUrlConfig.expiresInSec');
      }
      if (!Number.isInteger(inProgressTimeoutMinutes) || inProgressTimeoutMinutes < 1 || inProgressTimeoutMinutes > 10080) {
        throw invalid('CreateJob', 'timeoutConfig.inProgressTimeoutInMinutes');
      }
      if (jobs.has(jobId)) return { ok: false, reason: 'exists' };
      if (targets.some((thing) => !things.has(thing))) return { ok: false, reason: 'target_not_found' };
      const at = clock();
      jobs.set(jobId, settle({
        jobId, status: 'IN_PROGRESS', description, document, things: [...targets], createdAt: at,
        lastUpdatedAt: at, completedAt: null, forceCanceled: false, reasonCode: null, comment: null,
        urlExpiresInSec, timeoutMs: inProgressTimeoutMinutes * 60_000, executions: new Map(),
        rolloutAt: at + rolloutDelayMs, rolledOut: false,
      }));
      return { ok: true };
    },

    async cancelJob({ jobId, force, reasonCode, comment }) {
      checkJobId('CancelJob', jobId);
      if (typeof force !== 'boolean') throw invalid('CancelJob', 'force');
      if (typeof reasonCode !== 'string' || reasonCode.length > 128 || !REASON_CODE.test(reasonCode)) {
        throw invalid('CancelJob', 'reasonCode');
      }
      if (typeof comment !== 'string' || comment.length > 2028 || !NO_CONTROL.test(comment)) {
        throw invalid('CancelJob', 'comment');
      }
      if (!jobs.has(jobId)) return { ok: false, reason: 'not_found' };
      const job = settle(jobs.get(jobId));
      if (job.status === 'COMPLETED' || job.status === 'DELETION_IN_PROGRESS') {
        return { ok: false, reason: 'refused', detail: `job is ${job.status}` };
      }
      const running = [...job.executions.values()].some((execution) => execution.status === 'IN_PROGRESS');
      if (job.status === 'CANCELED' && !(force && running)) {
        return { ok: false, reason: 'refused', detail: 'job is CANCELED' };
      }
      const at = clock();
      for (const execution of job.executions.values()) {
        if (execution.status === 'QUEUED' || (force && execution.status === 'IN_PROGRESS')) {
          execution.forceCanceled = execution.status === 'IN_PROGRESS';
          execution.status = 'CANCELED';
          execution.lastUpdatedAt = at;
          execution.versionNumber += 1;
        }
      }
      job.status = 'CANCELED';
      job.forceCanceled = job.forceCanceled || force;
      job.reasonCode = reasonCode;
      job.comment = comment;
      job.lastUpdatedAt = at;
      return { ok: true };
    },

    async putFirmwareObject({ key, body, sha256Base64 }) {
      if (typeof key !== 'string' || key === '') throw invalid('PutObject', 'key');
      if (!(body instanceof Uint8Array)) throw invalid('PutObject', 'body');
      // S3 compares what it received with the digest the caller announced.
      if (createHash('sha256').update(body).digest('base64') !== sha256Base64) {
        throw awsError('PutObject', 'BadDigest', { status: 400 });
      }
      if (objects.has(key)) return { stored: false, reason: 'exists' };
      objects.set(key, {
        body: Buffer.from(body), contentType: 'application/octet-stream', sha256Base64, tags: {},
      });
      return { stored: true };
    },

    async tagFirmwareRevoked(key) {
      if (!objects.has(key)) return { ok: false, reason: 'not_found' };
      // PutObjectTagging replaces the whole tag set.
      objects.get(key).tags = { revoked: 'true' };
      return { ok: true };
    },

    async getRelease(sk) {
      return releases.has(sk) ? copy(releases.get(sk)) : null;
    },

    async listReleases() {
      return [...releases.keys()].sort().reverse().map((sk) => copy(releases.get(sk)));
    },

    async highestReleaseKey() {
      return highest ?? null;
    },

    async registerRelease({ sk, release }) {
      if (typeof sk !== 'string' || sk === '') throw new TypeError('sk is required');
      assertStorable(release, 'release');
      // Both conditions of the transaction; either one cancels both writes.
      if (releases.has(sk)) return { ok: false, reason: 'exists' };
      if (highest !== undefined && !(highest < sk)) return { ok: false, reason: 'not_newer', highest };
      releases.set(sk, { ...copy(release), pk: 'REL', sk });
      highest = sk;
      return { ok: true };
    },

    async markReleaseRevoked({ sk, revoked }) {
      assertStorable(revoked, 'revoked');
      const item = releases.get(sk);
      if (item === undefined || item.status !== 'active') return { ok: false, reason: 'not_active' };
      item.status = 'revoked';
      item.revoked = copy(revoked);
      return { ok: true, release: copy(item) };
    },

    async putAudit(item) {
      assertStorable(item, 'item');
      if (typeof item.sk !== 'string' || item.sk === '') throw new TypeError('sk is required');
      if (auditItems.has(item.sk)) return { ok: false, reason: 'exists' };
      auditItems.set(item.sk, { ...copy(item), pk: 'AUD' });
      return { ok: true };
    },

    async queryAudit({ before, limit }) {
      if (!Number.isInteger(limit) || limit < 1) throw new TypeError('limit must be a positive integer');
      return [...auditItems.keys()].sort().reverse()
        .filter((sk) => before === null || before === undefined || sk < before)
        .slice(0, limit)
        .map((sk) => copy(auditItems.get(sk)));
    },

    async getUser(sub) {
      const user = users.get(sub);
      return user === undefined ? null : { enabled: user.enabled, status: user.status, email: user.email };
    },

    async listUserGroups(sub) {
      const user = users.get(sub);
      return user === undefined ? [] : [...user.groups];
    },
  };

  const fake = {};
  for (const [method, run] of Object.entries(adapter)) {
    fake[method] = async (...args) => {
      calls.push({ method, args: args.map((arg) => (arg instanceof Uint8Array ? `<${arg.length} bytes>` : arg)) });
      const queued = faults.get(method);
      if (queued !== undefined && queued.length > 0) {
        const fault = queued.shift();
        throw typeof fault === 'function' ? fault() : fault;
      }
      return run(...args);
    };
  }

  Object.assign(fake, {
    /** Every adapter call so far, in order: { method, args }. */
    calls,

    /** The names of the adapter methods called so far, in order. */
    methodsCalled() {
      return calls.map((call) => call.method);
    },

    /** Make the next `times` calls of an adapter method throw, as the real adapter would. */
    failNext(method, { times = 1, code = 'failed', awsName = 'InternalFailureException' } = {}) {
      if (!Object.hasOwn(adapter, method)) throw new TypeError(`No adapter method ${method}`);
      const queued = faults.get(method) ?? [];
      for (let count = 0; count < times; count += 1) queued.push(() => awsError(method, awsName, { code }));
      faults.set(method, queued);
    },

    /** What the provisioning tool does: register a board and attach its certificate. */
    addThing(thing, { certificates = [], inGroup = true } = {}) {
      if (typeof thing !== 'string' || !THING_NAME.test(thing)) throw new TypeError('Not a thing name');
      things.set(thing, {
        inGroup,
        principals: certificates.map((id) => `arn:aws:iot:${REGION}:${ACCOUNT}:cert/${id}`),
      });
    },

    removeThing(thing) {
      things.delete(thing);
      shadows.delete(thing);
      booted.delete(thing);
    },

    /** The board's side of its shadow. */
    device(thing) {
      if (!things.has(thing)) throw new TypeError(`No thing ${thing}`);
      return {
        /**
         * Publish to shadow/update: merges into state.reported and stamps the metadata.
         * Like the firmware, every publish carries the uptime; unless one is given it is
         * the time since the board's first report, or since the uptime it gave last.
         */
        report(reported) {
          const at = clock();
          const stamp = Math.floor(at / 1000);
          if (Number.isFinite(reported.uptime)) booted.set(thing, at - reported.uptime * 1000);
          else if (!booted.has(thing)) booted.set(thing, at);
          const update = reported.uptime === undefined
            ? { ...reported, uptime: Math.floor((at - booted.get(thing)) / 1000) }
            : reported;

          let shadow = shadows.get(thing);
          const wellFormed = shadow !== null && typeof shadow === 'object' &&
            typeof shadow.state?.reported === 'object' && shadow.state.reported !== null &&
            typeof shadow.metadata?.reported === 'object' && shadow.metadata.reported !== null;
          if (!wellFormed) shadow = { state: { reported: {} }, metadata: { reported: {} }, version: 0, timestamp: stamp };
          mergeReported(shadow.state.reported, shadow.metadata.reported, update, stamp);
          shadow.version = (Number.isInteger(shadow.version) ? shadow.version : 0) + 1;
          shadow.timestamp = stamp;
          shadows.set(thing, shadow);
        },
        /** Put any document in place of the shadow, to see how the console copes. */
        setRaw(document) {
          shadows.set(thing, copy(document));
        },
        clear() {
          shadows.delete(thing);
        },
        get() {
          return copy(shadows.get(thing) ?? null);
        },
        /**
         * What the board gets when it asks AWS IoT for its next job: the execution in
         * progress, or else the one queued longest, as { jobId, status, document }; null
         * if there is none. AWS would put a download URL where the document names one.
         */
        nextJob() {
          const pending = [];
          for (const job of jobs.values()) {
            const execution = settle(job).executions.get(thing);
            if (execution !== undefined && !TERMINAL.has(execution.status)) pending.push({ job, execution });
          }
          pending.sort((a, b) =>
            (a.execution.status === 'IN_PROGRESS' ? 0 : 1) - (b.execution.status === 'IN_PROGRESS' ? 0 : 1) ||
            a.execution.queuedAt - b.execution.queuedAt);
          if (pending.length === 0) return null;
          const [{ job, execution }] = pending;
          return { jobId: job.jobId, status: execution.status, document: JSON.parse(job.document) };
        },
      };
    },

    /** The board's side of one job execution. */
    execution(jobId, thing) {
      return {
        get() {
          const job = jobs.has(jobId) ? settle(jobs.get(jobId)) : null;
          const execution = job?.executions.get(thing);
          return execution === undefined ? null : copy(execution);
        },
        /**
         * UpdateJobExecution as the board sends it over MQTT. Returns { accepted: true }
         * or { accepted: false, code } with the code AWS IoT answers on update/rejected.
         * A board may only continue once its update was accepted.
         */
        update(status, details) {
          if (!DEVICE_STATUSES.has(status)) return { accepted: false, code: 'InvalidRequest' };
          if (details !== undefined) {
            const entries = details === null || typeof details !== 'object' ? null : Object.entries(details);
            const valid = entries !== null && entries.length <= 10 && entries.every(([key, value]) =>
              DETAIL_KEY.test(key) && typeof value === 'string' && value.length >= 1 && value.length <= 1024 &&
              NO_CONTROL.test(value));
            if (!valid) return { accepted: false, code: 'InvalidRequest' };
          }
          const job = jobs.has(jobId) ? settle(jobs.get(jobId)) : null;
          const execution = job?.executions.get(thing);
          if (execution === undefined) return { accepted: false, code: 'ResourceNotFound' };
          if (TERMINAL.has(execution.status)) return { accepted: false, code: 'InvalidStateTransition' };
          const at = clock();
          if (status === 'IN_PROGRESS' && execution.startedAt === null) execution.startedAt = at;
          execution.status = status;
          execution.lastUpdatedAt = at;
          execution.versionNumber += 1;
          if (details !== undefined) execution.statusDetails = { ...details };
          settle(job);
          return { accepted: true };
        },
      };
    },

    /** What the user administrator does: create a user and put it in groups. */
    addUser({ sub, email, groups = [], enabled = true, status = 'CONFIRMED' }) {
      if (typeof sub !== 'string' || sub === '') throw new TypeError('sub is required');
      users.set(sub, { email, enabled, status, groups: new Set(groups) });
    },

    user(sub) {
      const user = users.get(sub);
      if (user === undefined) throw new TypeError(`No user ${sub}`);
      return {
        setGroups(groups) {
          user.groups = new Set(groups);
        },
        disable() {
          user.enabled = false;
        },
        enable() {
          user.enabled = true;
        },
        setStatus(status) {
          user.status = status;
        },
        remove() {
          users.delete(sub);
        },
      };
    },

    /** What is stored, for assertions. */
    objects,
    releases,
    jobs,
    auditLog() {
      return [...auditItems.keys()].sort().map((sk) => copy(auditItems.get(sk)));
    },
    highestRegistered() {
      return highest ?? null;
    },
  });

  return fake;
}

/** A file from test/fixtures. */
export function fixture(name) {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
}

/**
 * An environment for loadConfig (src/config.mjs) that goes with the fake: local names,
 * the layout of the fixture images, and the public key the fixtures are signed for.
 */
export function fakeEnv(overrides = {}) {
  const der = createPublicKey(fixture('test_signing_pub.pem')).export({ type: 'spki', format: 'der' });
  return {
    AWS_REGION: REGION,
    STATE_TABLE: 'local-state',
    AUDIT_TABLE: 'local-audit',
    FIRMWARE_BUCKET: 'local-firmware',
    THING_GROUP: 'cranium-devices',
    PRESIGN_ROLE_ARN: `arn:aws:iam::${ACCOUNT}:role/local-presign`,
    USER_POOL_ID: `${REGION}_local`,
    USER_POOL_CLIENT_ID: 'localclient',
    SIGNING_PUBLIC_KEY_B64: der.toString('base64'),
    SLOT_SIZE: '933888',
    LOAD_ADDRESS: '196608',
    ...overrides,
  };
}

/**
 * The claims of an access token as API Gateway hands them to the function: every value
 * a string, and the groups flattened into one bracketed string.
 */
export function accessClaims({ sub, groups = [], clientId = 'localclient', exp = 4102444800 }) {
  const claims = {
    sub,
    token_use: 'access',
    client_id: clientId,
    scope: 'openid cranium/console',
    username: sub,
    exp: String(exp),
  };
  if (groups !== null) claims['cognito:groups'] = `[${groups.join(' ')}]`;
  return claims;
}

let requestCount = 0;

/**
 * An API Gateway HTTP API event in payload format 2.0. Like the gateway, it gives
 * every request its own id unless one is passed in.
 */
export function apiEvent(method, path, { claims, body, query, requestId, base64 = false } = {}) {
  if (requestId === undefined) {
    requestCount += 1;
    requestId = `local-${String(requestCount).padStart(6, '0')}`;
  }
  const event = {
    version: '2.0',
    routeKey: 'ANY /api/{proxy+}',
    rawPath: path,
    rawQueryString: query === undefined ? '' : new URLSearchParams(query).toString(),
    headers: { 'content-type': 'application/json' },
    requestContext: {
      http: { method, path, protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
      requestId,
      routeKey: 'ANY /api/{proxy+}',
      stage: '$default',
    },
    isBase64Encoded: false,
  };
  if (claims !== undefined) event.requestContext.authorizer = { jwt: { claims, scopes: ['cranium/console'] } };
  if (query !== undefined) event.queryStringParameters = { ...query };
  if (body !== undefined) {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    event.body = base64 ? Buffer.from(text, 'utf8').toString('base64') : text;
    event.isBase64Encoded = base64;
  }
  return event;
}

// A reserved domain that can never receive mail.
const MAIL_DOMAIN = 'example.invalid';

/**
 * The real handlers wired to a fake adapter, with a clock the caller moves by hand.
 * Used by the tests; everything it holds was put there by the test.
 *
 *   const console_ = createTestConsole();
 *   const manager = console_.addUser('manager', ['release-managers']);
 *   const { status, body } = await console_.call('GET', '/api/firmware', { as: manager });
 */
export function createTestConsole({ rolloutDelayMs = 0, env = {}, startMs = Date.UTC(2026, 9, 10, 22, 15, 0) } = {}) {
  const clock = { ms: startMs };
  const now = () => clock.ms;
  const fake = createFakeAws({ now, rolloutDelayMs });
  const config = loadConfig(fakeEnv(env));
  const logs = [];
  let draws = 0;
  const app = createApp({
    aws: fake,
    config,
    now,
    log: (line) => logs.push(line),
    // Repeatable, so that ids in a test are the same on every run.
    randomHex: (count) => {
      draws += 1;
      return createHash('sha256').update(`draw ${draws}`).digest('hex').repeat(4).slice(0, 2 * count);
    },
  });
  let people = 0;

  return {
    fake,
    app,
    config,
    clock,
    logs,

    /** Move the clock forward. */
    advance(ms) {
      clock.ms += ms;
    },

    /** Create a user in the fake pool and return it with the claims of its token. */
    addUser(name, groups, { tokenGroups = groups, enabled = true, status = 'CONFIRMED' } = {}) {
      people += 1;
      const sub = `00000000-0000-4000-8000-${String(people).padStart(12, '0')}`;
      const email = `${name}@${MAIL_DOMAIN}`;
      fake.addUser({ sub, email, groups, enabled, status });
      return { sub, email, claims: accessClaims({ sub, groups: tokenGroups, clientId: config.userPoolClientId }) };
    },

    /** Send one request through the handler. `as` is a user from addUser. */
    async call(method, path, { as, claims, body, query, requestId, base64 } = {}) {
      const event = apiEvent(method, path, { claims: claims ?? as?.claims, body, query, requestId, base64 });
      const response = await app(event);
      return { status: response.statusCode, headers: response.headers, body: JSON.parse(response.body) };
    },
  };
}
