/**
 * Deployments: list, create, watch and cancel.
 *
 * AWS IoT Jobs is the only store. A deployment is a snapshot job on a chosen set of
 * boards; nothing about it is copied anywhere else, so what the console shows cannot
 * drift from what AWS holds. Results are cached for a moment in this module's memory
 * to keep polling browsers within the request limits of AWS IoT.
 *
 * What a board reports never decides anything here. Whether a release may be deployed
 * is decided by its record; whether a board is free is decided by its executions in
 * AWS IoT Jobs. The shadow only adds the live step and progress to the picture.
 */

import { conflict, describeError, field, notFound, unprocessable } from '../http.mjs';
import {
  EXECUTION_STATUSES, IN_PROGRESS_TIMEOUT_MIN, MAX_IN_FLIGHT, URL_EXPIRES_SEC, buildJobDescription,
  buildJobDocument, buildJobId, countExecutions, executionDetails, isActiveExecution, isSettled, isoTime,
  mapLimit, summarizeJob,
} from '../lib/jobs.mjs';
import { unknownDevice } from '../lib/shadow.mjs';
import { deriveTimeline } from '../lib/timeline.mjs';
import {
  MAX_NOTE, isThing, parseJobId, requireBoolean, requireJobId, requireText, requireThings, requireVersion,
} from '../lib/validate.mjs';
import { releaseFromItem, releaseKey } from './firmware.mjs';

const CACHE_MS = 2000;
const LIST_LIMIT = 25;
const MAX_CACHED = 1000;
const ANY_JOB_ID = /^[A-Za-z0-9_-]{1,64}$/;

function unknownDeployment() {
  return notFound('unknown_deployment', 'There is no deployment with that id.');
}

function alreadyFinished() {
  return conflict('already_finished', 'This deployment has already finished; there is nothing left to cancel.');
}

function put(cache, key, value) {
  if (cache.size >= MAX_CACHED) cache.clear();
  cache.set(key, value);
}

/** The execution of a board that a new job names: queued since the job was created. */
function queuedRow(thing, createdAt) {
  return {
    thing, status: 'QUEUED', queuedAt: createdAt, startedAt: null, lastUpdatedAt: createdAt,
    details: executionDetails(null), secondsLeft: null,
  };
}

export function createDeploymentHandlers({ aws, config, now, randomHex, log }, { devices }) {
  let listing = null;            // { jobs, at }: the result of ListJobs
  const summaries = new Map();   // id -> { summary, settled, at }
  const details = new Map();     // id -> { detail, at }
  const closed = new Map();      // "id/thing" -> a described execution that has ended

  function forget(id) {
    listing = null;
    summaries.delete(id);
    details.delete(id);
  }

  function warn(event, fields, error) {
    log({ level: 'warn', event, ...fields, error: describeError(error).message });
  }

  function rememberSummary(id, summary) {
    put(summaries, id, { summary, settled: isSettled(summary), at: now() });
  }

  /** The summary of one deployment for the list, or null if the job is not one. */
  async function summaryOf(id) {
    const cached = summaries.get(id);
    if (cached !== undefined && (cached.settled || now() - cached.at < CACHE_MS)) return cached.summary;
    const summary = summarizeJob(await aws.describeJob(id));
    if (summary === null) summaries.delete(id);
    else rememberSummary(id, summary);
    return summary;
  }

  /**
   * One execution with what the board wrote into it. An execution that has ended does
   * not change any more and is described only once.
   */
  async function describeExecution(id, listed) {
    const key = `${id}/${listed.thing}`;
    const cached = closed.get(key);
    const unchanged = cached !== undefined && cached.status === listed.status &&
      cached.lastUpdatedAt === listed.lastUpdatedAt;
    if (unchanged) return cached.row;

    let described = null;
    try {
      described = await aws.describeJobExecution(id, listed.thing);
    } catch (error) {
      // The list entry still says where the board is; the details follow on the next poll.
      warn('execution_unreadable', { deployment: id, thing: listed.thing }, error);
    }
    const complete = described !== null && EXECUTION_STATUSES.includes(described.status);
    const source = complete ? described : listed;
    const row = {
      thing: listed.thing,
      status: source.status,
      queuedAt: source.queuedAt ?? listed.queuedAt ?? null,
      startedAt: source.startedAt ?? listed.startedAt ?? null,
      lastUpdatedAt: source.lastUpdatedAt ?? listed.lastUpdatedAt ?? null,
      details: executionDetails(complete ? described.statusDetails : null),
      secondsLeft: complete && Number.isInteger(described.secondsLeft) && described.secondsLeft >= 0
        ? described.secondsLeft : null,
    };
    if (complete && !isActiveExecution(row.status)) {
      put(closed, key, { status: listed.status, lastUpdatedAt: listed.lastUpdatedAt, row });
    }
    return row;
  }

  /** An Execution as the API returns it. */
  function present(summary, row, device) {
    const { phase, progress } = deriveTimeline({
      status: row.status, reason: row.details.reason, step: row.details.step, jobId: summary.id, device,
    });
    const queuedAt = isoTime(row.queuedAt) ?? isoTime(row.lastUpdatedAt) ?? summary.createdAt;
    return {
      thing: row.thing,
      status: row.status,
      phase,
      progress,
      reason: row.details.reason,
      detail: row.details.detail,
      // What the board said when it finished. For an execution it could not finish
      // (still open, cancelled, timed out) this is what it reports now.
      running: row.details.running ?? device.fw?.version ?? null,
      online: device.online,
      queuedAt,
      startedAt: isoTime(row.startedAt),
      lastUpdatedAt: isoTime(row.lastUpdatedAt) ?? queuedAt,
      secondsLeft: row.status === 'IN_PROGRESS' ? row.secondsLeft : null,
    };
  }

  /** The DeploymentDetail for an id, or null if there is no such deployment. */
  async function detailOf(id, { fresh = false } = {}) {
    const cached = details.get(id);
    if (!fresh && cached !== undefined && now() - cached.at < CACHE_MS) return cached.detail;

    const job = await aws.describeJob(id);
    const summary = summarizeJob(job);
    if (summary === null) {
      forget(id);
      return null;
    }
    const listed = (await aws.listJobExecutionsForJob(id))
      .filter((execution) => isThing(execution.thing) && EXECUTION_STATUSES.includes(execution.status));
    const rows = await mapLimit(listed, MAX_IN_FLIGHT, (execution) => describeExecution(id, execution));
    const byThing = new Map(rows.map((row) => [row.thing, row]));

    const things = [...new Set([...summary.things, ...byThing.keys()])].sort();
    const boards = await devices.loadDevices(things, CACHE_MS);
    const executions = [];
    things.forEach((thing, index) => {
      let row = byThing.get(thing);
      if (row === undefined) {
        // AWS creates the executions shortly after the job. Until it has, a board the
        // job names is queued by definition; for a job that is over there is nothing.
        if (summary.status !== 'IN_PROGRESS') return;
        row = queuedRow(thing, job.createdAt ?? null);
      }
      executions.push(present(summary, row, boards[index]));
    });

    const detail = { ...summary, counts: countExecutions(executions), executions };
    put(details, id, { detail, at: now() });
    rememberSummary(id, summary);
    return detail;
  }

  /** The jobs AWS lists that are deployments of this console. */
  async function listedJobs({ fresh = false } = {}) {
    if (!fresh && listing !== null && now() - listing.at < CACHE_MS) return listing.jobs;
    const jobs = (await aws.listJobs()).filter((job) => parseJobId(job.jobId) !== null);
    listing = { jobs, at: now() };
    return jobs;
  }

  /**
   * Cancel, with force, every deployment of a version that is not over. Used when a
   * release is revoked. One job that cannot be cancelled does not stop the others.
   */
  async function cancelUnfinished(version, comment) {
    const jobs = (await listedJobs({ fresh: true }))
      .filter((job) => parseJobId(job.jobId).version === version)
      .sort((a, b) => (a.jobId < b.jobId ? -1 : 1));
    const cancelled = [];
    const failed = [];
    await mapLimit(jobs, MAX_IN_FLIGHT, async (job) => {
      try {
        if (job.status === 'COMPLETED' || job.status === 'DELETION_IN_PROGRESS') return;
        if (job.status === 'CANCELED') {
          // Cancelled without force, a job can still have boards that had started.
          const summary = summarizeJob(await aws.describeJob(job.jobId));
          if (summary === null || summary.counts.inProgress === 0) return;
        }
        const result = await aws.cancelJob({
          jobId: job.jobId, force: true, reasonCode: 'RELEASE_REVOKED', comment,
        });
        forget(job.jobId);
        if (result.ok) cancelled.push(job.jobId);
      } catch (error) {
        failed.push(job.jobId);
        log({ level: 'error', event: 'cancel_failed', deployment: job.jobId, error: describeError(error) });
      }
    });
    listing = null;
    return { cancelled: cancelled.sort(), failed: failed.sort() };
  }

  return {
    cancelUnfinished,

    async list() {
      const newest = [...await listedJobs()]
        .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0) || (a.jobId < b.jobId ? 1 : -1))
        .slice(0, LIST_LIMIT);
      const loaded = await mapLimit(newest, MAX_IN_FLIGHT, (job) => summaryOf(job.jobId));
      return { body: { deployments: loaded.filter((summary) => summary !== null) } };
    },

    async get({ params }) {
      const job = requireJobId(params.id);
      const detail = await detailOf(job.id);
      if (detail === null) throw unknownDeployment();
      return { body: { deployment: detail } };
    },

    async create({ actor, json, entry }) {
      const body = json();
      const version = requireVersion(field(body, 'version'));
      entry.target = version.text;
      entry.detail.version = version.text;
      const things = requireThings(field(body, 'things'));
      entry.detail.things = String(things.length);
      const note = requireText(field(body, 'note'), 'note', { max: MAX_NOTE });

      const sortKey = releaseKey(version.parts);
      const release = releaseFromItem(await aws.getRelease(sortKey));
      if (release === null || release.version !== version.text) {
        throw notFound('unknown_version', `There is no release ${version.text}.`);
      }
      if (release.status !== 'active') {
        throw conflict('release_revoked', `Release ${version.text} is revoked and cannot be deployed.`);
      }

      const members = new Set(await devices.groupThings());
      const strangers = things.filter((thing) => !members.has(thing));
      if (strangers.length > 0) {
        throw unprocessable('unknown_device', strangers.length === 1
          ? `${strangers[0]} is not a registered board.`
          : `These are not registered boards: ${strangers.join(', ')}.`);
      }

      // Decided by the executions AWS holds, never by what a board reports.
      const busy = (await mapLimit(things, MAX_IN_FLIGHT, async (thing) =>
        (await aws.listJobExecutionsForThing(thing))
          .filter((execution) => isActiveExecution(execution.status) &&
            typeof execution.jobId === 'string' && ANY_JOB_ID.test(execution.jobId))
          .map((execution) => ({ thing, deployment: execution.jobId })))).flat();
      if (busy.length > 0) {
        const names = [...new Set(busy.map((item) => item.thing))];
        const who = names.length === 1 ? `${names[0]} still has` : `${names.length} boards still have`;
        throw conflict('device_busy',
          `${who} an update that is not finished. Wait for it or cancel it first.`, busy);
      }

      const document = buildJobDocument({
        version: release.version, size: release.size, sha256: release.sha256,
        region: config.region, bucket: config.firmwareBucket,
      });
      const description = buildJobDescription({ email: actor.email, sub: actor.sub, note });

      let id = null;
      for (let attempt = 0; attempt < 3 && id === null; attempt += 1) {
        const candidate = buildJobId(version.parts, now(), String(randomHex(4)).slice(0, 4));
        const created = await aws.createJob({
          jobId: candidate, things, document, description,
          urlExpiresInSec: URL_EXPIRES_SEC, inProgressTimeoutMinutes: IN_PROGRESS_TIMEOUT_MIN,
        });
        if (created.ok) {
          id = candidate;
        } else if (created.reason === 'target_not_found') {
          throw unprocessable('unknown_device', 'One of the chosen boards is no longer registered.');
        } else if (created.reason !== 'exists') {
          throw new Error(`The job could not be created: ${String(created.reason)}`);
        }
      }
      if (id === null) throw new Error('No free job id after three attempts');
      entry.target = id;
      forget(id);

      // The release may have been revoked while this request was running. Revoking
      // cancels the deployments it can see; this one may have appeared too late for that.
      let current = release;
      try {
        current = releaseFromItem(await aws.getRelease(sortKey));
      } catch (error) {
        // It was active a moment ago, and the bucket refuses a revoked image anyway.
        warn('release_recheck_failed', { deployment: id }, error);
      }
      if (current === null || current.status !== 'active') {
        await aws.cancelJob({ jobId: id, force: true, reasonCode: 'RELEASE_REVOKED', comment: actor.sub });
        throw conflict('release_revoked',
          `Release ${version.text} was revoked just now; the deployment was cancelled.`);
      }

      // The job exists from here on, so the answer is 201 even if it cannot be read
      // back right now: then it is described from what was just sent to AWS.
      let detail = null;
      try {
        detail = await detailOf(id, { fresh: true });
      } catch (error) {
        warn('deployment_unreadable', { deployment: id }, error);
      }
      if (detail === null) {
        const createdAt = now();
        const summary = summarizeJob({
          jobId: id, status: 'IN_PROGRESS', description, things, createdAt, lastUpdatedAt: createdAt,
          completedAt: null, counts: {},
        });
        const executions = things.map((thing) =>
          present(summary, queuedRow(thing, createdAt), unknownDevice(thing)));
        detail = { ...summary, counts: countExecutions(executions), executions };
      }
      return { status: 201, body: { deployment: detail } };
    },

    async cancel({ actor, params, json, entry }) {
      const job = requireJobId(params.id);
      entry.target = job.id;
      const force = requireBoolean(field(json(), 'force'), 'force', false);
      entry.detail.force = String(force);

      const summary = summarizeJob(await aws.describeJob(job.id));
      if (summary === null) throw unknownDeployment();
      if (summary.status === 'COMPLETED' || summary.status === 'DELETION_IN_PROGRESS') throw alreadyFinished();
      // A deployment cancelled without force can still have boards that had started.
      // Only a forced cancel reaches those.
      if (summary.status === 'CANCELED' && !(force && summary.counts.inProgress > 0)) throw alreadyFinished();

      const result = await aws.cancelJob({
        jobId: job.id, force, reasonCode: 'CONSOLE_CANCEL', comment: actor.sub,
      });
      forget(job.id);
      if (!result.ok) {
        if (result.reason === 'not_found') throw unknownDeployment();
        warn('cancel_refused', { deployment: job.id }, new Error(String(result.detail ?? '')));
        throw alreadyFinished();
      }

      // Cancelling is eventually consistent: answer with what AWS says after the call.
      let detail;
      try {
        detail = await detailOf(job.id, { fresh: true });
      } catch (error) {
        // The request fails, but the log entry says that the job was cancelled.
        entry.detail.cancelled = 'true';
        throw error;
      }
      if (detail === null) throw unknownDeployment();
      return { body: { deployment: detail } };
    },
  };
}
