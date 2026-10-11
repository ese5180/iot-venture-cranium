/**
 * Boards: GET /api/devices and GET /api/devices/{thing}.
 *
 * The boards of this project are the members of one thing group. What a board says
 * about itself comes from its shadow and is display data only (lib/shadow.mjs).
 * Shadows are cached for a few seconds in this module's memory, because several views
 * and every poll of a running deployment read the same ones.
 */

import { describeError, notFound } from '../http.mjs';
import { EXECUTION_STATUSES, isoTime } from '../lib/jobs.mjs';
import { deviceFromShadow, unknownDevice } from '../lib/shadow.mjs';
import { isThing, parseJobId, requireThing } from '../lib/validate.mjs';

const SHADOW_CACHE_MS = 5000;
const MAX_CACHED_SHADOWS = 512;
const MAX_HISTORY = 20;

const CERTIFICATE_ARN = /^arn:[a-z0-9-]+:iot:[a-z0-9-]+:\d{12}:cert\/([0-9a-f]{64})$/;
const ANY_JOB_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The first 16 hex digits of each certificate attached to a thing. */
function certificateIds(principals) {
  const ids = new Set();
  for (const principal of principals) {
    const match = typeof principal === 'string' ? CERTIFICATE_ARN.exec(principal) : null;
    if (match) ids.add(match[1].slice(0, 16));
  }
  return [...ids].sort();
}

/** The newest executions of a thing as ExecutionSummary records. */
function history(executions) {
  const rows = [];
  for (const execution of executions) {
    if (typeof execution.jobId !== 'string' || !ANY_JOB_ID.test(execution.jobId)) continue;
    if (!EXECUTION_STATUSES.includes(execution.status)) continue;
    const queuedAt = isoTime(execution.queuedAt) ?? isoTime(execution.lastUpdatedAt);
    if (queuedAt === null) continue;
    rows.push({
      deployment: execution.jobId,
      // Null for a job that some other tool created on this thing.
      version: parseJobId(execution.jobId)?.version ?? null,
      status: execution.status,
      queuedAt,
      startedAt: isoTime(execution.startedAt),
      lastUpdatedAt: isoTime(execution.lastUpdatedAt) ?? queuedAt,
    });
  }
  rows.sort((a, b) => (a.queuedAt < b.queuedAt ? 1 : a.queuedAt > b.queuedAt ? -1 :
    a.deployment < b.deployment ? 1 : -1));
  return rows.slice(0, MAX_HISTORY);
}

export function createDeviceHandlers({ aws, now, log }) {
  const shadows = new Map();

  async function readShadow(thing, maxAgeMs) {
    const cached = shadows.get(thing);
    if (cached !== undefined && now() - cached.at < maxAgeMs) return cached.shadow;
    const shadow = await aws.getShadow(thing);
    if (shadows.size >= MAX_CACHED_SHADOWS) shadows.clear();
    shadows.set(thing, { shadow, at: now() });
    return shadow;
  }

  /**
   * The Device for each of the given things, in the same order. A shadow that cannot
   * be read leaves its board looking as if it never reported; it never fails the rest.
   */
  async function loadDevices(things, maxAgeMs = SHADOW_CACHE_MS) {
    const settled = await Promise.allSettled(things.map((thing) => readShadow(thing, maxAgeMs)));
    return things.map((thing, index) => {
      const result = settled[index];
      if (result.status === 'rejected') {
        log({ level: 'warn', event: 'shadow_unreadable', thing, error: describeError(result.reason).message });
        return unknownDevice(thing);
      }
      return deviceFromShadow(thing, result.value, now());
    });
  }

  /** The names of the project's boards, each once, sorted. */
  async function groupThings() {
    return [...new Set((await aws.listGroupThings()).filter(isThing))].sort();
  }

  return {
    loadDevices,
    groupThings,

    async list() {
      const devices = await loadDevices(await groupThings());
      return { body: { devices, generatedAt: new Date(now()).toISOString() } };
    },

    async get({ params }) {
      const thing = requireThing(params.thing);
      if (!(await groupThings()).includes(thing)) {
        throw notFound('unknown_device', 'No board with that name is registered.');
      }
      const [[device], principals, executions] = await Promise.all([
        loadDevices([thing]),
        aws.listThingPrincipals(thing),
        aws.listJobExecutionsForThing(thing),
      ]);
      return {
        body: { device, certificates: certificateIds(principals), executions: history(executions) },
      };
    },
  };
}
