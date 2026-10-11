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
 *
 * Cancelling is asked of AWS and then read back. AWS applies a cancellation a few
 * seconds after it accepted it, and a job that was cancelled without force keeps the
 * boards that had started. So nothing here says that a deployment is over because the
 * job is cancelled: that is read from its executions.
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
// The states of a job in which AWS rolls out nothing more.
const OVER = Object.freeze(['COMPLETED', 'CANCELED', 'DELETION_IN_PROGRESS']);
// AWS stops the boards of a job a few seconds after it accepted a forced cancellation
// (5 to 15 s were measured). For this long after one, a board that is still listed as
// waiting or at work is taken to be on its way out. After that it was not stopped.
const STOPPING_MS = 120_000;

function unknownDeployment() {
  return notFound('unknown_deployment', 'There is no deployment with that id.');
}

function alreadyFinished() {
  return conflict('already_finished', 'This deployment has already finished; there is nothing left to cancel.');
}

/** "1 board is" or "3 boards are". */
function boardsAre(count) {
  return count === 1 ? '1 board is' : `${count} boards are`;
}

const running = (executions) => executions.filter((execution) => execution.status === 'IN_PROGRESS').length;

/**
 * A cancellation of a deployment that is cancelled already and still has `executions`
 * open, where there is nothing to send to AWS. Says why they are open:
 *
 * @param {object[]} executions  the executions that are queued or in progress
 * @param {boolean} forced       the deployment was cancelled with force
 * @param {boolean} stopping     and AWS accepted that so recently that it is still at it
 */
function alreadyCancelled(executions, { forced, stopping }) {
  const atWork = running(executions);
  let rest;
  if (stopping) {
    rest = `AWS takes a few seconds to stop its boards: ${boardsAre(executions.length)} still listed as unfinished.`;
  } else if (atWork === 0) {
    rest = `AWS takes a few seconds to withdraw the offer: ${boardsAre(executions.length)} still listed as waiting.`;
  } else if (forced) {
    rest = `${boardsAre(atWork)} still at work on it all the same. Cancel with force to try again.`;
  } else {
    rest = `${boardsAre(atWork)} still at work on it, because a cancellation without force leaves boards ` +
      'that had started alone. Cancel with force to stop them.';
  }
  return conflict('already_cancelled',
    `This deployment is already cancelled${forced ? ' with force' : ''}. ${rest}`);
}

/** AWS refused a cancellation, and the deployment is not over: `executions` are still open. */
function cancelRefused(executions) {
  const atWork = running(executions);
  if (atWork > 0) {
    return conflict('cancel_refused', 'AWS did not accept the cancellation, and ' +
      `${boardsAre(atWork)} still at work on this deployment. A board that is not stopped carries ` +
      `on until it finishes or its ${IN_PROGRESS_TIMEOUT_MIN} minutes are over.`);
  }
  return conflict('cancel_refused', executions.length > 0
    ? `AWS did not accept the cancellation, and ${boardsAre(executions.length)} still offered this ` +
      'update. Try again in a moment.'
    : 'AWS did not accept the cancellation, and the deployment is still open. Try again in a moment.');
}

function deviceBusy(busy, withdrawn = false) {
  const names = [...new Set(busy.map((item) => item.thing))];
  if (withdrawn) {
    const who = names.length === 1 ? `${names[0]} was` : `${names.length} boards were`;
    return conflict('device_busy', `${who} given another update at the same moment, so this deployment ` +
      'was withdrawn. Wait for the other update or cancel it first.', busy);
  }
  const who = names.length === 1 ? `${names[0]} still has` : `${names.length} boards still have`;
  return conflict('device_busy', `${who} an update that is not finished. Wait for it or cancel it first.`, busy);
}

/** True if deployment `a` was created before `b`. Both are summaries; ids break a tie. */
function createdBefore(a, b) {
  return a.createdAt < b.createdAt || (a.createdAt === b.createdAt && a.id < b.id);
}

/** True if two lists name the same boards, in whatever order. */
function sameThings(a, b) {
  const others = new Set(b);
  return a.length === others.size && a.every((thing) => others.has(thing));
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
   * The executions of a job that have not ended: boards still waiting or at work. Read
   * from the executions themselves; the counts AWS keeps with a job lag behind them.
   */
  async function openExecutions(id) {
    return (await aws.listJobExecutionsForJob(id)).filter((execution) => isActiveExecution(execution.status));
  }

  /**
   * True if AWS accepted a forced cancellation of this job a moment ago, so that it is
   * still stopping the job's boards. `job` is a job as the adapter describes it.
   */
  function beingStopped(job) {
    return job !== null && job.status === 'CANCELED' && job.forceCanceled === true &&
      Number.isFinite(job.lastUpdatedAt) && now() - job.lastUpdatedAt < STOPPING_MS;
  }

  /**
   * The unfinished updates on these boards, as [{ thing, deployment }], leaving out the
   * deployment `except`. Decided by what AWS holds, never by what a board reports:
   *
   *   - every execution of a board that is queued or in progress, whichever tool
   *     created its job, and
   *   - every deployment of this console that is not over and names the board but has
   *     no execution for it yet. AWS creates the executions of a job shortly after the
   *     job; until then the board is queued by definition, and a check of the
   *     executions alone would miss a deployment made a moment ago.
   */
  async function unfinishedOn(things, except = null) {
    const listed = await mapLimit(things, MAX_IN_FLIGHT, (thing) => aws.listJobExecutionsForThing(thing));
    const busy = [];
    const rolledOut = new Set();   // "job thing" for every execution that exists
    things.forEach((thing, index) => {
      for (const execution of listed[index]) {
        if (typeof execution.jobId !== 'string' || !ANY_JOB_ID.test(execution.jobId)) continue;
        rolledOut.add(`${execution.jobId} ${thing}`);
        if (execution.jobId !== except && isActiveExecution(execution.status)) {
          busy.push({ thing, deployment: execution.jobId });
        }
      }
    });
    const open = (await listedJobs({ fresh: true })).filter((job) =>
      job.jobId !== except && (job.status === 'IN_PROGRESS' || job.status === 'SCHEDULED'));
    const summaries = await mapLimit(open, MAX_IN_FLIGHT, (job) => summaryOf(job.jobId));
    for (const summary of summaries) {
      if (summary === null) continue;
      for (const thing of things) {
        if (summary.things.includes(thing) && !rolledOut.has(`${summary.id} ${thing}`)) {
          busy.push({ thing, deployment: summary.id });
        }
      }
    }
    return busy.sort((a, b) => (a.thing === b.thing
      ? (a.deployment < b.deployment ? -1 : 1)
      : (a.thing < b.thing ? -1 : 1)));
  }

  /**
   * Of the unfinished updates on these boards, those that the deployment `id`, which
   * was created a moment ago, has to give way to.
   *
   * Two requests for the same board at the same moment both find it free, and each
   * creates its job before it can see the other's. Each therefore looks again once its
   * job exists, and of two deployments the one AWS created later gives way: it was
   * created when the other existed, so it is the one that is sure to see both. A job
   * of another tool does not look out for this console, so a deployment always gives
   * way to it.
   */
  async function rivalsOf(id, things) {
    const others = await unfinishedOn(things, id);
    if (others.length === 0) return [];
    const own = await summaryOf(id);
    const first = new Map();   // deployment -> whether it comes before this one
    for (const deployment of new Set(others.map((item) => item.deployment))) {
      if (parseJobId(deployment) === null || own === null) {
        first.set(deployment, true);
      } else {
        const other = await summaryOf(deployment);
        // Gone in the meantime: nothing to give way to.
        first.set(deployment, other !== null && createdBefore(other, own));
      }
    }
    return others.filter((item) => first.get(item.deployment));
  }

  /**
   * Cancel, with force, every deployment of a version that is not over. Used when a
   * release is revoked. One job that cannot be cancelled does not stop the others.
   *
   * Returns { cancelled, failed }: the deployments this call cancelled, and those
   * with a board that could not be confirmed as stopped.
   *
   * AWS documents what a forced cancellation does to a job that is in progress: its
   * boards are stopped, a few seconds later, and a board looks at its job once more
   * before it installs. So a job that was in progress counts as cancelled when AWS
   * accepted the call.
   *
   * AWS does not document what a second cancellation does to a job that is cancelled
   * already and still has a board waiting or at work. Measured in October 2026, it
   * accepts a forced one and stops the board 5 to 15 seconds later; it could also
   * refuse it, or accept it and change nothing. For such a job, and whenever AWS
   * refuses, only the executions say whether the boards were stopped, so they are
   * read again after the call. A job
   * with a board that is still open then counts as failed, never as cancelled. That
   * also holds for a job that someone cancelled with force a few seconds ago and
   * that AWS is still stopping: it cannot be told apart, and asking again later
   * settles it.
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
        const cancelledBefore = job.status === 'CANCELED';
        if (cancelledBefore && (await openExecutions(job.jobId)).length === 0) return;

        const result = await aws.cancelJob({
          jobId: job.jobId, force: true, reasonCode: 'RELEASE_REVOKED', comment,
        });
        forget(job.jobId);
        if (!result.ok && result.reason === 'not_found') return;
        if (result.ok && !cancelledBefore) {
          cancelled.push(job.jobId);
          return;
        }
        const [after, left] = await Promise.all([aws.describeJob(job.jobId), openExecutions(job.jobId)]);
        if ((after === null || OVER.includes(after.status)) && left.length === 0) {
          if (result.ok) cancelled.push(job.jobId);
          return;
        }
        failed.push(job.jobId);
        log({
          level: 'error', event: 'cancel_unconfirmed', deployment: job.jobId, accepted: result.ok,
          open: left.length, atWork: running(left),
        });
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

      const busy = await unfinishedOn(things);
      if (busy.length > 0) throw deviceBusy(busy);

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
        } else {
          // The id is taken. Either by another job, and another id is drawn; or by
          // this very request: a call whose answer got lost is sent again, and the
          // second attempt then finds the job that the first one made.
          const taken = await aws.describeJob(candidate);
          if (taken !== null && taken.description === description && sameThings(taken.things ?? [], things)) {
            id = candidate;
          }
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
        forget(id);
        throw conflict('release_revoked',
          `Release ${version.text} was revoked just now; the deployment was cancelled.`);
      }

      // Another deployment to one of these boards may have been created in the same
      // moment: neither request could see the other's job when it checked. Look again
      // now that this job exists, and withdraw it if it is the one to give way.
      let rivals = [];
      try {
        rivals = await rivalsOf(id, things);
      } catch (error) {
        // The boards were free a moment ago; this second look only narrows a race.
        warn('busy_recheck_failed', { deployment: id }, error);
      }
      // The lists were read for a decision; the next reader gets fresh ones.
      forget(id);
      if (rivals.length > 0) {
        await aws.cancelJob({ jobId: id, force: true, reasonCode: 'DEVICE_BUSY', comment: actor.sub });
        forget(id);
        throw deviceBusy(rivals, true);
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

      const described = await aws.describeJob(job.id);
      const summary = summarizeJob(described);
      if (summary === null) throw unknownDeployment();
      if (summary.status === 'COMPLETED' || summary.status === 'DELETION_IN_PROGRESS') throw alreadyFinished();
      if (summary.status === 'CANCELED') {
        // Whether anything is left of a cancelled deployment is read from its
        // executions. What can be left: boards that AWS has yet to take the offer
        // from or to stop, which it does a few seconds after a cancellation, and
        // boards that had started when the deployment was cancelled without force.
        // Only for the last is there something to ask of AWS, and only with force.
        const open = await openExecutions(job.id);
        if (open.length === 0) throw alreadyFinished();
        const stopping = beingStopped(described);
        if (stopping || running(open) === 0 || !force) {
          throw alreadyCancelled(open, { forced: described.forceCanceled === true, stopping });
        }
      }

      const result = await aws.cancelJob({
        jobId: job.id, force, reasonCode: 'CONSOLE_CANCEL', comment: actor.sub,
      });
      forget(job.id);
      if (!result.ok) {
        if (result.reason === 'not_found') throw unknownDeployment();
        warn('cancel_refused', { deployment: job.id }, new Error(String(result.detail ?? '')));
        // AWS has the last word. What it left behind is said as it is: a refusal only
        // means that there was nothing to cancel if the job is over and no board is
        // waiting or at work.
        const [after, left] = await Promise.all([aws.describeJob(job.id), openExecutions(job.id)]);
        if (after === null) throw unknownDeployment();
        if (OVER.includes(after.status) && left.length === 0) throw alreadyFinished();
        // Somebody else cancelled it with force in this very moment.
        if (summary.status !== 'CANCELED' && beingStopped(after)) {
          throw alreadyCancelled(left, { forced: true, stopping: true });
        }
        throw cancelRefused(left);
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
      if (summary.status === 'CANCELED' && detail.counts.inProgress > 0) {
        // AWS accepted a second cancellation, which is where it documents nothing, and
        // the board is still listed as at work. It may be stopped in a few seconds or
        // not at all; the answer shows it as it is, and the log keeps the case.
        log({
          level: 'warn', event: 'cancel_unconfirmed', deployment: job.id, accepted: true,
          atWork: detail.counts.inProgress,
        });
      }
      return { body: { deployment: detail } };
    },
  };
}
