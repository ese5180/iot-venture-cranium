/**
 * Deployments as AWS IoT jobs.
 *
 * A deployment is one snapshot job. Nothing about it is stored anywhere else: the job
 * id carries the version, the job description carries who created it and why, and the
 * job document is what the board acts on:
 *
 *   { "op": "fw_update", "v": 1,
 *     "fw": { "version": "1.1.0+7", "size": 815284, "sha256": "<64 hex>",
 *             "url": "${aws:iot:s3-presigned-url-v2:https://s3.<region>.amazonaws.com/<bucket>/firmware/<sha256>.bin}" } }
 *
 * AWS IoT replaces the placeholder with a short-lived download URL each time a board
 * asks for the document. This module never sees such a URL.
 */

import { isThing, parseJobId, strictVersion } from './validate.mjs';

export const URL_EXPIRES_SEC = 600;
export const IN_PROGRESS_TIMEOUT_MIN = 30;
export const MAX_IN_FLIGHT = 5;

// The board parses the document in a small buffer, before the URL is substituted.
const DOCUMENT_LIMIT = 512;
// Limits of AWS IoT for a job description.
const DESCRIPTION_LIMIT = 2028;

export const JOB_STATUSES = Object.freeze(
  ['IN_PROGRESS', 'COMPLETED', 'CANCELED', 'SCHEDULED', 'DELETION_IN_PROGRESS']);

const COUNT_NAMES = Object.freeze({
  QUEUED: 'queued',
  IN_PROGRESS: 'inProgress',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  REJECTED: 'rejected',
  CANCELED: 'canceled',
  TIMED_OUT: 'timedOut',
  REMOVED: 'removed',
});

export const EXECUTION_STATUSES = Object.freeze(Object.keys(COUNT_NAMES));

/** An execution that can still change: the board has not finished with it. */
export function isActiveExecution(status) {
  return status === 'QUEUED' || status === 'IN_PROGRESS';
}

export function emptyCounts() {
  return { queued: 0, inProgress: 0, succeeded: 0, failed: 0, rejected: 0, canceled: 0, timedOut: 0, removed: 0 };
}

export function countExecutions(executions) {
  const counts = emptyCounts();
  for (const { status } of executions) {
    if (Object.hasOwn(COUNT_NAMES, status)) counts[COUNT_NAMES[status]] += 1;
  }
  return counts;
}

/** ISO 8601 for epoch milliseconds, or null when there is no usable time. */
export function isoTime(ms) {
  return Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString() : null;
}

/**
 * The id of a new deployment of the given version:
 * cranium-<major>-<minor>-<revision>-b<build>-<yyyymmddThhmmssZ>-<4 random hex>.
 * At most 55 characters, so it always fits the 64 that AWS IoT allows.
 */
export function buildJobId(parts, nowMs, suffix) {
  if (typeof suffix !== 'string' || !/^[0-9a-f]{4}$/.test(suffix)) {
    throw new TypeError('The job id suffix must be 4 lowercase hex digits');
  }
  const stamp = new Date(nowMs).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const id = `cranium-${parts.major}-${parts.minor}-${parts.revision}-b${parts.build}-${stamp}-${suffix}`;
  if (parseJobId(id) === null) throw new TypeError('The version or the time does not make a job id');
  return id;
}

/** When the id says the deployment was created, in epoch milliseconds, or null. */
function timeInJobId(id) {
  const match = /-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-[0-9a-f]{4}$/.exec(id);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The job document for a release. Throws when a value does not fit the contract or
 * the document would not fit the board's buffer.
 */
export function buildJobDocument({ version, size, sha256, region, bucket }) {
  if (strictVersion(version)?.text !== version) throw new TypeError('The version is not canonical');
  if (!Number.isInteger(size) || size <= 0) throw new TypeError('The size is not a positive integer');
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) throw new TypeError('The digest is not SHA-256 hex');
  if (typeof region !== 'string' || !/^[a-z0-9-]{1,32}$/.test(region)) throw new TypeError('The region is not usable');
  if (typeof bucket !== 'string' || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw new TypeError('The bucket name is not usable');
  }
  const url = `\${aws:iot:s3-presigned-url-v2:https://s3.${region}.amazonaws.com/${bucket}/firmware/${sha256}.bin}`;
  const document = JSON.stringify({ op: 'fw_update', v: 1, fw: { version, size, sha256, url } });
  if (Buffer.byteLength(document) >= DOCUMENT_LIMIT) {
    throw new RangeError(`The job document is ${Buffer.byteLength(document)} bytes; the board accepts fewer than ${DOCUMENT_LIMIT}`);
  }
  return document;
}

/** JSON in printable ASCII only, which every AWS text field accepts. */
function asciiJson(value) {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g,
    (unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/**
 * The job description: who created the deployment and their note, as compact JSON.
 * The e-mail address is display data and is left out if the text would not fit.
 */
export function buildJobDescription({ email, sub, note }) {
  const text = asciiJson({ by: email, sub, note });
  return text.length <= DESCRIPTION_LIMIT ? text : asciiJson({ by: '', sub, note });
}

const UNSAFE = /[\p{C}\p{Zl}\p{Zp}]/u;

function line(value, max) {
  return typeof value === 'string' && value.length <= max && !UNSAFE.test(value) ? value : '';
}

/** Read a job description back. Anyone with AWS access can write one: trust nothing. */
export function parseJobDescription(text) {
  const unknown = { createdBy: null, note: '' };
  if (typeof text !== 'string' || text.length > DESCRIPTION_LIMIT) return unknown;
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return unknown;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return unknown;
  const sub = Object.hasOwn(value, 'sub') ? line(value.sub, 128) : '';
  const email = Object.hasOwn(value, 'by') ? line(value.by, 320) : '';
  const note = Object.hasOwn(value, 'note') ? line(value.note, 200) : '';
  return { createdBy: sub === '' ? null : { sub, email }, note };
}

/**
 * Turn a job as the adapter describes it into a DeploymentSummary. Returns null for a
 * job that is not a deployment of this console.
 */
export function summarizeJob(job) {
  const parsed = parseJobId(job?.jobId);
  if (parsed === null || !JOB_STATUSES.includes(job.status)) return null;
  const createdAt = isoTime(job.createdAt) ?? isoTime(timeInJobId(parsed.id));
  if (createdAt === null) return null;

  const things = [...new Set((Array.isArray(job.things) ? job.things : []).filter(isThing))].sort();
  const counts = emptyCounts();
  let counted = 0;
  for (const name of Object.keys(counts)) {
    const value = job.counts?.[name];
    if (Number.isInteger(value) && value > 0) {
      counts[name] = value;
      counted += value;
    }
  }
  // AWS creates the executions shortly after the job. Until it has, a board the job
  // names is queued by definition.
  if (job.status === 'IN_PROGRESS' && counted < things.length) {
    counts.queued += things.length - counted;
  }
  const { createdBy, note } = parseJobDescription(job.description);
  return {
    id: parsed.id,
    version: parsed.version,
    status: job.status,
    createdAt,
    completedAt: isoTime(job.completedAt),
    createdBy,
    note,
    things,
    counts,
  };
}

/**
 * A deployment whose summary can no longer change: the job is over, no board is still
 * queued or at work, and every board is accounted for. The last two matter because a
 * cancelled job keeps the boards that had started, and because AWS updates the counts
 * a moment after the status.
 */
export function isSettled(summary) {
  if (summary.status !== 'COMPLETED' && summary.status !== 'CANCELED') return false;
  const counted = Object.values(summary.counts).reduce((sum, value) => sum + value, 0);
  return summary.counts.queued === 0 && summary.counts.inProgress === 0 && counted >= summary.things.length;
}

const REASON = /^[a-z][a-z0-9_]{0,31}$/;
const DETAIL = /^[\x20-\x7e]{1,200}$/;

/**
 * What a board wrote into the statusDetails of its execution, reduced to the keys of
 * the device contract. Every key is optional and every value is checked: a board is
 * outside the trust boundary.
 */
export function executionDetails(statusDetails) {
  const read = (name) => (statusDetails !== null && typeof statusDetails === 'object' &&
    !Array.isArray(statusDetails) && Object.hasOwn(statusDetails, name) ? statusDetails[name] : undefined);
  const reason = read('reason');
  const detail = read('detail');
  const step = read('step');
  return {
    reason: typeof reason === 'string' && REASON.test(reason) ? reason : null,
    detail: typeof detail === 'string' && DETAIL.test(detail) ? detail : null,
    step: step === 'downloading' || step === 'rebooting' ? step : null,
    running: strictVersion(read('running'))?.text ?? null,
  };
}

/** Run a task for every item, at most `limit` at a time. Results keep the order. */
export async function mapLimit(items, limit, task) {
  const results = new Array(items.length);
  let next = 0;
  let failed = false;
  async function worker() {
    while (!failed && next < items.length) {
      const index = next;
      next += 1;
      try {
        results[index] = await task(items[index], index);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
