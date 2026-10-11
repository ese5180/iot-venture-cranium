/**
 * A small fleet for the tests of the console, as the API describes one: boards,
 * releases, deployments and log entries in the shapes of the API's replies, and the
 * replies themselves by request path. The tests hand these to the console's own client,
 * so that what a view or the page draws from is made the way the browser makes it.
 *
 * Everything here exists only in these tests. Nothing here is a test; the file only
 * has exports.
 */

import { CORE } from './page.mjs';

const core = await import(CORE);

export const NOW = Date.parse('2026-10-10T12:00:00Z');
export const ago = (seconds) => new Date(NOW - seconds * 1000).toISOString();

// A reserved domain that can never receive mail. The addresses exist only here.
const MAIL_DOMAIN = 'example.invalid';
export const MANAGER = { sub: '0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d', email: `manager@${MAIL_DOMAIN}` };
// Another account that shows the very same address.
export const LOOKALIKE = { sub: 'f9e8d7c6-b5a4-4321-9876-543210fedcba', email: MANAGER.email };
export const NAMELESS = { sub: '7a7a7a7a-1111-4222-8333-444455556666', email: '' };

export const WAITING = 'cranium-00000000000000aa';
export const INSTALLING = 'cranium-00000000000000bb';
export const NEVER = 'cranium-00000000000000cc';
export const FINGERPRINT = 'f'.repeat(64);
export const OFFERED = 'cranium-1-2-3-b5-20261010T115400Z-0a0a';
export const WITHDRAWN = 'cranium-1-2-4-b0-20261010T114000Z-0b0b';
export const FINISHED = 'cranium-1-2-3-b4-20261009T100000Z-0c0c';
export const REASON = 'Pads stop responding after a few minutes of use.';
export const SLOT_SIZE = 933888;

export function device(thing, changes = {}) {
  return {
    thing,
    online: true,
    lastSeen: ago(20),
    fw: { version: '1.2.3+4', confirmed: true },
    ota: { state: 'idle', job: null, progress: 0, last: 'none', error: '' },
    rssi: -52,
    uptime: 10800,
    ...changes,
  };
}

export function release(version, changes = {}) {
  return {
    version,
    size: 1264,
    sha256: version.replace(/\D/g, '').padEnd(64, 'a'),
    imageHash: 'b'.repeat(64),
    keyHash: FINGERPRINT,
    payloadSize: 600,
    headerSize: 512,
    loadAddress: 196608,
    filename: 'zephyr.signed.bin',
    notes: '',
    uploadedBy: MANAGER,
    uploadedAt: ago(7200),
    status: 'active',
    revoked: null,
    ...changes,
  };
}

/**
 * The record of a revocation made 33 minutes ago. `completion` is {} for a server that
 * does not record when the revocation was completed, or { enforcedAt } for one that does.
 */
export function revoked(completion = {}) {
  return { by: MANAGER, at: ago(1980), reason: REASON, ...completion };
}

export function execution(thing, phase, changes = {}) {
  return {
    thing,
    status: 'QUEUED',
    phase,
    progress: null,
    reason: null,
    detail: null,
    running: '1.2.3+4',
    online: true,
    queuedAt: ago(360),
    startedAt: null,
    lastUpdatedAt: ago(360),
    secondsLeft: null,
    ...changes,
  };
}

const COUNT_NAMES = {
  QUEUED: 'queued', IN_PROGRESS: 'inProgress', SUCCEEDED: 'succeeded', FAILED: 'failed',
  REJECTED: 'rejected', CANCELED: 'canceled', TIMED_OUT: 'timedOut', REMOVED: 'removed',
};

/** A deployment with its executions; the counts and the boards follow from those. */
export function deployment(id, changes = {}) {
  const executions = changes.executions ?? [];
  const counts = Object.fromEntries(Object.values(COUNT_NAMES).map((name) => [name, 0]));
  for (const { status } of executions) counts[COUNT_NAMES[status]] += 1;
  return {
    id,
    version: core.versionOfDeployment(id),
    status: 'IN_PROGRESS',
    createdAt: ago(360),
    completedAt: null,
    createdBy: MANAGER,
    note: '',
    things: executions.map((item) => item.thing),
    counts,
    ...changes,
    executions,
  };
}

export function entry(action, target, changes = {}) {
  return {
    at: ago(600), actor: MANAGER, action, target, outcome: 'ok', detail: {}, requestId: 'req-1', ...changes,
  };
}

/**
 * Something of everything: a board that waits for its button, one that is still
 * downloading in a deployment that was cancelled without force, one that never
 * connected; a release whose revocation is not finished; a log with a refusal in it.
 */
export const WORLD = Object.freeze({
  devices: [
    device(WAITING, { ota: { state: 'awaiting_user', job: OFFERED, progress: 0, last: 'none', error: '' } }),
    device(INSTALLING, {
      ota: { state: 'downloading', job: WITHDRAWN, progress: 40, last: 'none', error: '' },
    }),
    device(NEVER, { online: false, lastSeen: null, fw: null, ota: null, rssi: null, uptime: null }),
  ],
  releases: [
    release('2.0.0+0', { status: 'revoked', revoked: revoked({ enforcedAt: null }), uploadedAt: ago(2400) }),
    release('1.2.4+0'),
    release('1.2.3+5'),
    release('1.2.3+4', { uploadedBy: NAMELESS }),
  ],
  deployments: [
    deployment(OFFERED, { executions: [execution(WAITING, 'waiting_for_button')] }),
    deployment(WITHDRAWN, {
      status: 'CANCELED',
      createdAt: ago(1200),
      executions: [execution(INSTALLING, 'downloading', {
        status: 'IN_PROGRESS', progress: 40, startedAt: ago(100), lastUpdatedAt: ago(20), secondsLeft: 1700,
      })],
    }),
    deployment(FINISHED, {
      status: 'COMPLETED',
      createdAt: ago(93600),
      completedAt: ago(93000),
      executions: [execution(WAITING, 'succeeded', { status: 'SUCCEEDED', startedAt: ago(93300) })],
    }),
  ],
  entries: [
    entry('firmware.revoke', '2.0.0+0', { at: ago(1980), detail: { reason: REASON, cancelled: '1' } }),
    entry('deployment.cancel', WITHDRAWN, { at: ago(900), actor: LOOKALIKE, detail: { force: 'false' } }),
    entry('deployment.create', OFFERED, { at: ago(360), detail: { version: '1.2.3+5', things: '1' } }),
    entry('firmware.upload', 'zephyr.signed.bin', {
      at: ago(7300),
      actor: NAMELESS,
      outcome: 'rejected',
      detail: { filename: 'zephyr.signed.bin', sha256: 'c'.repeat(64), size: '1264', code: 'wrong_key' },
    }),
  ],
});

export const EMPTY = Object.freeze({ devices: [], releases: [], deployments: [], entries: [] });

/** What the API answers for a world, by request path: every GET the console makes. */
export function repliesFor(world, { viewer = false } = {}) {
  const replies = new Map([
    ['/api/me', {
      ...MANAGER,
      groups: [viewer ? 'viewers' : 'release-managers'],
      canWrite: !viewer,
      expiresAt: NOW / 1000 + 3000,
    }],
    ['/api/devices', { devices: world.devices, generatedAt: ago(0) }],
    ['/api/firmware', {
      releases: world.releases, signingKey: { fingerprint: FINGERPRINT }, slotSize: SLOT_SIZE,
    }],
    ['/api/deployments', { deployments: world.deployments.map(({ executions, ...summary }) => summary) }],
    ['/api/audit?limit=50', { entries: world.entries, next: null }],
    ['/api/audit?limit=6', { entries: world.entries.slice(0, 6), next: null }],
  ]);
  for (const item of world.deployments) replies.set(`/api/deployments/${item.id}`, { deployment: item });
  for (const item of world.devices) {
    replies.set(`/api/devices/${item.thing}`, {
      device: item,
      certificates: ['a727ba33b1f43e3b'],
      executions: world.deployments
        .filter((candidate) => candidate.things.includes(item.thing))
        .map((candidate) => {
          const own = candidate.executions.find((part) => part.thing === item.thing);
          return {
            deployment: candidate.id, version: candidate.version, status: own.status,
            queuedAt: own.queuedAt, startedAt: own.startedAt, lastUpdatedAt: own.lastUpdatedAt,
          };
        }),
    });
  }
  return replies;
}
