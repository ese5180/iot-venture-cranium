/**
 * The parts of the console that do not touch the page: the grammar of versions, board
 * names and deployment ids, the sign-in flow, the API client, and the words used for
 * what a board is doing during an update.
 *
 * Whatever arrives from the API is reduced to known shapes on the way in. Text that a
 * board reported is additionally cut down to printable ASCII, because nothing a board
 * says can be trusted. The views only see the reduced form and only ever write it to
 * the page as text.
 *
 * Nothing in this file reads the document, so the unit tests load it as it is.
 * No dependencies.
 */

// Grammar. The same patterns the API enforces; a value that does not match is never
// put into a request path or a link.

const VERSION = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,4})\+(0|[1-9]\d{0,9})$/;
const THING = /^cranium-[0-9a-f]{16}$/;
const DEPLOYMENT = /^cranium-(\d{1,3})-(\d{1,3})-(\d{1,5})-b(\d{1,10})-\d{8}T\d{6}Z-[0-9a-f]{4}$/;
const CURSOR = /^[A-Za-z0-9_-]{1,512}$/;

/** Parse "major.minor.revision+build"; null for anything else. */
export function parseVersion(text) {
  const match = typeof text === 'string' ? VERSION.exec(text) : null;
  if (!match) return null;
  const version = {
    major: Number(match[1]),
    minor: Number(match[2]),
    revision: Number(match[3]),
    build: Number(match[4]),
  };
  const { major, minor, revision, build } = version;
  if (major > 0xff || minor > 0xff || revision > 0xffff || build > 0xffffffff) return null;
  return version;
}

export function formatVersion({ major, minor, revision, build }) {
  return `${major}.${minor}.${revision}+${build}`;
}

/** Negative, zero or positive as a is older than, equal to or newer than b. */
export function compareVersions(a, b) {
  for (const field of ['major', 'minor', 'revision', 'build']) {
    if (a[field] !== b[field]) return a[field] < b[field] ? -1 : 1;
  }
  return 0;
}

export function isVersion(text) {
  return parseVersion(text) !== null;
}

export function isThing(text) {
  return typeof text === 'string' && THING.test(text);
}

export function isDeploymentId(text) {
  return typeof text === 'string' && DEPLOYMENT.test(text);
}

/** The firmware version a deployment installs, recovered from its id. */
export function versionOfDeployment(id) {
  const match = typeof id === 'string' ? DEPLOYMENT.exec(id) : null;
  if (!match) return null;
  const version = `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}+${Number(match[4])}`;
  return isVersion(version) ? version : null;
}

// Routes. The console has exactly these; anything else in the address bar is ignored.

const SECTIONS = ['overview', 'devices', 'firmware', 'deployments', 'activity', 'serial', 'history'];
const ROUTE = /^#\/([a-z]+)(?:\/([A-Za-z0-9-]+))?$/;

/** Turn a location hash into a route, or null if it is not one of the console's. */
export function parseRoute(hash) {
  const match = typeof hash === 'string' ? ROUTE.exec(hash) : null;
  if (!match) return null;
  const [, section, item] = match;
  if (item === undefined) return SECTIONS.includes(section) ? { view: section } : null;
  if (section === 'devices' && isThing(item)) return { view: 'device', thing: item };
  if (section === 'deployments' && isDeploymentId(item)) return { view: 'deployment', id: item };
  return null;
}

/** The canonical hash for a route. Built from checked values only. */
export function routeHash(route) {
  if (route?.view === 'device' && isThing(route.thing)) return `#/devices/${route.thing}`;
  if (route?.view === 'deployment' && isDeploymentId(route.id)) return `#/deployments/${route.id}`;
  if (SECTIONS.includes(route?.view)) return `#/${route.view}`;
  return '#/overview';
}

/** Link to a board or a deployment, or null if the name is not a valid one. */
export function deviceHref(thing) {
  return isThing(thing) ? `#/devices/${thing}` : null;
}

export function deploymentHref(id) {
  return isDeploymentId(id) ? `#/deployments/${id}` : null;
}

// Numbers and times as people read them.

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// From this age on a time is told by its date, not by how long ago it was.
const DATED_FROM = 14 * DAY;

/** "3 min ago". Empty if there is no time. */
export function timeAgo(iso, nowMs) {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const elapsed = nowMs - then;
  if (elapsed < 5 * SECOND) return 'just now';
  if (elapsed < MINUTE) return `${Math.floor(elapsed / SECOND)} s ago`;
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} min ago`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)} h ago`;
  if (elapsed < DATED_FROM) return `${Math.floor(elapsed / DAY)} d ago`;
  return new Date(then).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** True for a time that timeAgo() tells by its date. */
export function toldByDate(iso, nowMs) {
  const then = Date.parse(iso);
  return !Number.isNaN(then) && nowMs - then >= DATED_FROM;
}

/** The full local date and time, for a tooltip. */
export function exactTime(iso) {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  return new Date(then).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
}

/**
 * The time of day to write next to a relative time where the exact moment matters. A
 * tooltip cannot be reached with a keyboard or on a touch screen. Another day's time
 * says the day as well.
 */
export function clockTime(iso, nowMs) {
  const then = new Date(Date.parse(iso));
  if (Number.isNaN(then.getTime())) return '';
  const time = { hour: '2-digit', minute: '2-digit' };
  return then.toDateString() === new Date(nowMs).toDateString()
    ? then.toLocaleTimeString(undefined, time)
    : then.toLocaleString(undefined, { day: 'numeric', month: 'short', ...time });
}

/** The date and the time of day, for a time so old that "ago" says nothing. */
export function dateAndTime(iso) {
  const then = new Date(Date.parse(iso));
  if (Number.isNaN(then.getTime())) return '';
  return then.toLocaleString(undefined, {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/** The time of day alone, for an entry under a heading that already names its day. */
export function timeOfDay(iso) {
  const then = new Date(Date.parse(iso));
  if (Number.isNaN(then.getTime())) return '';
  return then.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** "Today", "Yesterday" or a date: the heading a log entry is filed under. */
export function dayLabel(iso, nowMs) {
  const then = new Date(Date.parse(iso));
  if (Number.isNaN(then.getTime())) return 'Undated';
  const startOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((startOfDay(new Date(nowMs)) - startOfDay(then)) / DAY);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return then.toLocaleDateString(undefined,
    { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}

/** A length of time: "42 s", "5 min", "2 h 14 min", "3 d 4 h". */
export function duration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  const total = Math.floor(seconds);
  if (total < 60) return `${total} s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days} d ${hours % 24} h` : `${days} d`;
}

/** A size in the binary units the flash layout is described in. */
export function fileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

export function exactBytes(bytes) {
  return Number.isFinite(bytes) ? `${bytes.toLocaleString('en-US')} bytes` : '';
}

/** Wi-Fi signal strength in words and as a number of bars out of four. */
export function signalQuality(rssi) {
  if (!Number.isFinite(rssi)) return null;
  if (rssi >= -55) return { bars: 4, label: 'Excellent' };
  if (rssi >= -67) return { bars: 3, label: 'Good' };
  if (rssi >= -75) return { bars: 2, label: 'Fair' };
  return { bars: 1, label: 'Weak' };
}

export function plural(count, one, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

// Firmware images, as far as the browser looks at them.

const IMAGE_MAGIC = 0x96f3b83d;
const IMAGE_HEADER_SIZE = 32;

/**
 * Read the fixed MCUboot image header (all fields little endian): magic at 0, header
 * size at 8, payload size at 12, version at 20. This is a preview, so that a wrong
 * file is noticed before it is sent. The signature is checked by the server.
 */
export function readImageHeader(data) {
  const view = ArrayBuffer.isView(data)
    ? new DataView(data.buffer, data.byteOffset, data.byteLength)
    : new DataView(data);
  if (view.byteLength < IMAGE_HEADER_SIZE) {
    return { ok: false, message: 'The file is too small to be a firmware image.' };
  }
  if (view.getUint32(0, true) !== IMAGE_MAGIC) {
    return {
      ok: false,
      message: 'This is not an MCUboot image. Choose the *.signed.bin file from the build.',
    };
  }
  return {
    ok: true,
    headerSize: view.getUint16(8, true),
    payloadSize: view.getUint32(12, true),
    version: formatVersion({
      major: view.getUint8(20),
      minor: view.getUint8(21),
      revision: view.getUint16(22, true),
      build: view.getUint32(24, true),
    }),
  };
}

function hexOf(bytes) {
  let text = '';
  for (const byte of bytes) text += byte.toString(16).padStart(2, '0');
  return text;
}

/** SHA-256 of a file, as lowercase hex. */
export async function sha256Hex(data, subtle = globalThis.crypto.subtle) {
  return hexOf(new Uint8Array(await subtle.digest('SHA-256', data)));
}

/** Standard base64 with padding: the form the upload endpoint requires. */
export function toBase64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function toBase64Url(bytes) {
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Free text as the API takes it: on one line, without control characters. A line break
 * or another control character becomes a space. Characters that cannot be seen, such
 * as the zero-width ones that come along with pasted text, are left out: the API
 * refuses a text that holds one.
 */
export function singleLine(text) {
  return String(text ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .replace(/\p{C}/gu, '')
    .trim();
}

/** The name recorded for an upload: the file's name in the characters the API accepts. */
export function recordedFilename(name) {
  const cleaned = String(name ?? '').replace(/[^A-Za-z0-9._-]/g, '_').slice(-64);
  return cleaned || 'image.signed.bin';
}

/**
 * What can be said about a chosen file before it is uploaded. `blocked` is set when the
 * file cannot be firmware for the board. `doomed` is set when the server is certain to
 * refuse it because of what is registered already, which only ever grows: the way on
 * is then another file. Everything else is left for the server to decide.
 */
export function reviewImage({ header, size, digest }, firmware) {
  const notes = [];
  if (!header.ok) return { blocked: true, notes: [{ tone: 'bad', text: header.message }] };

  const slot = firmware?.slotSize ?? null;
  let blocked = false;
  if (slot !== null && size > slot) {
    blocked = true;
    notes.push({ tone: 'bad', text: `Too large: the board’s slot holds ${exactBytes(slot)}.` });
  } else if (slot !== null) {
    notes.push({ tone: 'good', text: `Fits the board’s ${fileSize(slot)} slot.` });
  }

  if (header.version === '0.0.0+0') {
    notes.push({ tone: 'warn', text: 'Version 0.0.0+0 is never accepted. Give the build a version first.' });
    return { blocked, doomed: true, notes };
  }
  // Nothing is said about other releases until the list of them has arrived.
  if (!firmware) return { blocked, notes };

  const version = parseVersion(header.version);
  const same = firmware.releases.find((release) => release.sha256 === digest);
  const taken = firmware.releases.find((release) => release.version === header.version);
  const highest = firmware.releases.reduce((top, release) => {
    const parsed = parseVersion(release.version);
    return parsed && (!top || compareVersions(parsed, top) > 0) ? parsed : top;
  }, null);

  const top = highest ? formatVersion(highest) : '';
  const doomed = Boolean(same || taken || (highest && compareVersions(version, highest) <= 0));
  if (same) {
    notes.push({ tone: 'warn', text: `This exact file is already registered as ${same.version}.` });
  } else if (taken) {
    notes.push({
      tone: 'warn',
      text: `${taken.version} is already registered with different contents. A version can be used once.`,
    });
  } else if (highest && compareVersions(version, highest) <= 0) {
    notes.push({
      tone: 'warn',
      text: `Not newer than ${top}, the highest version registered so far. The server will refuse it.`,
    });
  } else if (highest) {
    notes.push({ tone: 'good', text: `Newer than every registered release (highest so far: ${top}).` });
  } else {
    notes.push({ tone: 'good', text: 'This will be the first release.' });
  }
  return { blocked, doomed, notes };
}

// Reading API replies. Every reply is rebuilt field by field; a reply whose outline is
// wrong is an error, a single odd value becomes null or a harmless default.

/** A failed request. `message` is the server's own wording whenever it sent one. */
export class ApiError extends Error {
  constructor(status, code, message, { requestId = null, details = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.details = details;
  }
}

function unreadable() {
  return new ApiError(0, 'bad_response', 'The server sent a reply the console could not read.');
}

function unreachable() {
  return new ApiError(0, 'network', 'The server could not be reached. Check the connection.');
}

function tooSlow() {
  return new ApiError(0, 'timeout', 'The server did not answer in time.');
}

function record(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw unreadable();
  return value;
}

function list(value) {
  if (!Array.isArray(value)) throw unreadable();
  return value;
}

function text(value, limit = 200) {
  return typeof value === 'string' ? value.slice(0, limit) : '';
}

function optionalText(value, limit = 200) {
  return typeof value === 'string' && value !== '' ? value.slice(0, limit) : null;
}

/** Text that originates on a board: printable ASCII only, and short. */
function boardText(value, limit = 96) {
  return typeof value === 'string' ? value.replace(/[^\x20-\x7e]/g, '?').slice(0, limit) : '';
}

function whole(value, least, most) {
  return Number.isInteger(value) && value >= least && value <= most ? value : null;
}

function instant(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : null;
}

function versionOrNull(value) {
  return isVersion(value) ? value : null;
}

/** The strings in a list, each cut to a sensible length; anything else in it is left out. */
function texts(value, limit = 64) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === 'string').map((item) => item.slice(0, limit));
}

function person(value) {
  if (value === null || typeof value !== 'object') return null;
  return { sub: text(value.sub, 64), email: text(value.email, 254) };
}

function readDevice(raw) {
  const item = record(raw);
  const fw = item.fw && typeof item.fw === 'object' && isVersion(item.fw.version)
    ? { version: item.fw.version, confirmed: item.fw.confirmed === true }
    : null;
  const ota = item.ota && typeof item.ota === 'object'
    ? {
      state: boardText(item.ota.state, 24) || 'idle',
      job: isDeploymentId(item.ota.job) ? item.ota.job : null,
      progress: whole(item.ota.progress, 0, 100) ?? 0,
      last: boardText(item.ota.last, 24) || 'none',
      error: boardText(item.ota.error, 64),
    }
    : null;
  return {
    thing: text(item.thing, 64),
    online: item.online === true,
    lastSeen: instant(item.lastSeen),
    fw,
    ota,
    rssi: whole(item.rssi, -127, 0),
    uptime: whole(item.uptime, 0, 2 ** 32),
  };
}

function readDevices(body) {
  const reply = record(body);
  return {
    devices: list(reply.devices).map(readDevice).filter((device) => device.thing !== ''),
    generatedAt: instant(reply.generatedAt),
  };
}

function readExecutionSummary(raw) {
  const item = record(raw);
  return {
    deployment: text(item.deployment, 64),
    version: versionOrNull(item.version),
    status: text(item.status, 24),
    queuedAt: instant(item.queuedAt),
    startedAt: instant(item.startedAt),
    lastUpdatedAt: instant(item.lastUpdatedAt),
  };
}

function readDeviceDetail(body) {
  const reply = record(body);
  return {
    device: readDevice(reply.device),
    certificates: texts(list(reply.certificates)).map((id) => boardText(id)),
    executions: list(reply.executions).map(readExecutionSummary),
    // How many older updates the server left out of `executions`.
    olderExecutions: whole(reply.olderExecutions, 0, 2 ** 32) ?? 0,
  };
}

function readRelease(raw) {
  const item = record(raw);
  let revoked = null;
  if (item.revoked && typeof item.revoked === 'object') {
    revoked = {
      by: person(item.revoked.by), at: instant(item.revoked.at), reason: text(item.revoked.reason, 200),
    };
    // When the server finished what follows the mark: the image refused, the open
    // deployments cancelled. Null until then. A server that does not record it leaves
    // the field out, and so does this.
    if (Object.hasOwn(item.revoked, 'enforcedAt')) revoked.enforcedAt = instant(item.revoked.enforcedAt);
  }
  return {
    version: text(item.version, 32),
    size: whole(item.size, 0, 2 ** 32),
    sha256: text(item.sha256, 64),
    imageHash: text(item.imageHash, 64),
    keyHash: text(item.keyHash, 64),
    payloadSize: whole(item.payloadSize, 0, 2 ** 32),
    headerSize: whole(item.headerSize, 0, 0xffff),
    loadAddress: whole(item.loadAddress, 0, 2 ** 32),
    filename: text(item.filename, 64),
    notes: text(item.notes, 500),
    uploadedBy: person(item.uploadedBy),
    uploadedAt: instant(item.uploadedAt),
    status: item.status === 'active' ? 'active' : 'revoked',
    revoked,
  };
}

function readFirmware(body) {
  const reply = record(body);
  return {
    releases: list(reply.releases).map(readRelease),
    fingerprint: text(reply.signingKey?.fingerprint, 64),
    slotSize: whole(reply.slotSize, 1, 2 ** 32),
  };
}

const COUNTS = ['queued', 'inProgress', 'succeeded', 'failed', 'rejected', 'canceled', 'timedOut', 'removed'];

function readDeploymentSummary(raw) {
  const item = record(raw);
  const counts = {};
  for (const name of COUNTS) counts[name] = whole(item.counts?.[name], 0, 1000) ?? 0;
  return {
    id: text(item.id, 64),
    version: versionOrNull(item.version),
    status: text(item.status, 32),
    createdAt: instant(item.createdAt),
    completedAt: instant(item.completedAt),
    createdBy: person(item.createdBy),
    note: text(item.note, 200),
    things: texts(item.things),
    counts,
  };
}

function readExecution(raw) {
  const item = record(raw);
  return {
    thing: text(item.thing, 64),
    status: text(item.status, 24),
    phase: text(item.phase, 32),
    progress: whole(item.progress, 0, 100),
    reason: boardText(item.reason, 48) || null,
    detail: boardText(item.detail, 96) || null,
    // What the job recorded when the board finished the update: history. See firmwareOf in
    // the API. Never the same thing as `reported`, the board's latest word, which an
    // execution that the board did not finish has instead.
    ranAtEnd: versionOrNull(item.ranAtEnd),
    reported: versionOrNull(item.reported),
    online: item.online === true,
    queuedAt: instant(item.queuedAt),
    startedAt: instant(item.startedAt),
    lastUpdatedAt: instant(item.lastUpdatedAt),
    secondsLeft: whole(item.secondsLeft, 0, 10 ** 7),
  };
}

function readDeployment(raw) {
  const executions = list(raw.executions).map(readExecution).filter((execution) => execution.thing !== '');
  return { ...readDeploymentSummary(raw), executions };
}

function readDeployments(body) {
  const deployments = list(record(body).deployments).map(readDeploymentSummary);
  return deployments.filter((deployment) => deployment.id !== '');
}

function readAuditEntry(raw) {
  const item = record(raw);
  const detail = [];
  if (item.detail && typeof item.detail === 'object' && !Array.isArray(item.detail)) {
    for (const [key, value] of Object.entries(item.detail).slice(0, 8)) {
      if (typeof value === 'string' || typeof value === 'number') {
        // As long as the API stores a value: a reason is kept whole.
        detail.push([text(key, 24), text(String(value), 200)]);
      }
    }
  }
  return {
    at: instant(item.at),
    actor: person(item.actor),
    action: text(item.action, 48),
    target: text(item.target, 96),
    outcome: text(item.outcome, 24),
    detail,
    requestId: text(item.requestId, 64),
  };
}

function readAudit(body) {
  const reply = record(body);
  return {
    entries: list(reply.entries).map(readAuditEntry),
    next: typeof reply.next === 'string' && CURSOR.test(reply.next) ? reply.next : null,
  };
}

function readMe(body) {
  const reply = record(body);
  return {
    sub: text(reply.sub, 64),
    email: text(reply.email, 254),
    groups: texts(reply.groups),
    canWrite: reply.canWrite === true,
  };
}

/** Boards the server named when it refused a deployment because they are busy. */
export function busyBoards(error) {
  if (!(error instanceof ApiError) || !Array.isArray(error.details)) return [];
  return error.details
    .filter((entry) => entry && isThing(entry.thing))
    .map(({ thing, deployment }) => ({ thing, deployment: isDeploymentId(deployment) ? deployment : null }));
}

// What a failed request means for what happens next.

/**
 * True for a refusal: the server understood the request and said no (a 4xx reply), so
 * nothing was changed. After any other failure the change may have been made.
 */
export function isRefusal(error) {
  return error.status >= 400 && error.status < 500;
}

/**
 * Whether the page has to be read again after a change failed. A refusal changed
 * nothing, but a conflict (409) says that what the page shows is out of date; after a
 * failure that is not a refusal the change may have gone through.
 */
export function staleAfter(error) {
  return !isRefusal(error) || error.status === 409;
}

/**
 * Whether sending the same file once more could end differently. A refusal of the
 * image cannot; being throttled, or meeting another upload at the same moment, can.
 */
export function canRetryUpload(error) {
  return !isRefusal(error) || error.status === 429 || error.code === 'upload_conflict';
}

/**
 * What the server checks before it stores an image, in the order it does so
 * (cloud/api/src/lib/mcuboot.mjs and handlers/firmware.mjs). It answers 201 only when
 * all of them passed, and otherwise names the first that did not, by its code.
 */
export const IMAGE_CHECKS = Object.freeze([
  {
    name: 'Image format',
    passed: 'It is an MCUboot image, and it fits the board’s update slot.',
    codes: ['not_an_image', 'too_small', 'too_large', 'bad_magic', 'bad_header', 'truncated'],
  },
  {
    name: 'Flash layout',
    passed: 'It was built for this product’s flash layout.',
    codes: ['unsupported_flags', 'wrong_target'],
  },
  {
    name: 'Signature area',
    passed: 'Its signature area is well formed, with nothing after it.',
    codes: ['malformed_tlv', 'unexpected_tlv', 'trailing_data', 'unsigned'],
  },
  {
    name: 'Image hash',
    passed: 'The image matches its own SHA-256 hash, so the file is not damaged.',
    codes: ['hash_mismatch'],
  },
  { name: 'Signing key', passed: 'It is signed with this project’s key.', codes: ['wrong_key'] },
  {
    name: 'Signature',
    passed: 'Its ECDSA P-256 signature is valid.',
    codes: ['bad_signature', 'bad_signature_encoding'],
  },
  {
    name: 'Version',
    passed: 'Its version is newer than every release before it.',
    passedFirst: 'Its version has a number, and no release came before it.',
    codes: ['version_zero', 'version_exists', 'version_not_newer'],
  },
]);

/** The name of the check that an image failed, from the code of the server's refusal. Null if it names none. */
export function failedCheck(code) {
  return IMAGE_CHECKS.find((check) => check.codes.includes(code))?.name ?? null;
}

/** A message as a sentence: some of the server's come without their full stop. */
export function sentence(message) {
  const words = String(message ?? '').trim();
  return words === '' || /[.!?…]$/.test(words) ? words : `${words}.`;
}

// What the signature check says when an image is laid out differently from what it
// expects: true, but in terms of the file format. A person who signed with the wrong
// kind of key has to be told what to change.
const SIGNED_WRONGLY = 'This image is not signed the way this project requires: an ECDSA P-256 ' +
  'signature, with a hash of the public key. Sign it with the project’s imgtool settings.';
const PLAIN_WORDS = {
  unexpected_tlv: SIGNED_WRONGLY,
  malformed_tlv: 'The signature area of this image cannot be read. Build and sign it again.',
  bad_signature_encoding: 'The signature in this image cannot be read. Build and sign it again.',
};

/** What to say about a failed request: the server's wording, unless it is written in jargon. */
export function plainMessage(error) {
  return entryOf(PLAIN_WORDS, error.code) ?? error.message;
}

/**
 * What to say once a deployment has been cancelled. `withdrawn`: it was cancelled before,
 * so that stopping the boards is all this did. What a cancellation does to a board takes
 * effect later, so it is told as what was asked for, not as what has happened.
 */
export function cancelNotice({ force, withdrawn, started }) {
  if (withdrawn) return 'Stop requested. Boards that had started have been asked to stop.';
  if (force) {
    return started > 0
      ? 'Cancelled. Boards that had started have been asked to stop.'
      : 'Cancelled. Boards that had not started are no longer offered this update.';
  }
  return started > 0
    ? `Cancelled. ${plural(started, 'board that had started carries', 'boards that had started carry')} on.`
    : 'Cancelled. Boards that had not started are no longer offered this update.';
}

// Revoking. Marking a release revoked is the first of three steps. Refusing its image
// and cancelling its deployments follow, and the server records when they are done. A
// request that fails or is cut off in between leaves a release that reads "revoked"
// with work outstanding; revoking it again completes that work.

/**
 * Where the revocation of a release stands; null for a release that is not revoked:
 * 'complete' with the server's record of completion, 'incomplete' without it, and
 * 'unknown' for a server that keeps no such record.
 */
export function revocationState(release) {
  if (release.status === 'active') return null;
  const mark = release.revoked;
  if (mark?.enforcedAt) return 'complete';
  return mark && Object.hasOwn(mark, 'enforcedAt') ? 'incomplete' : 'unknown';
}

/**
 * True for the reply to a revocation that found the release revoked already. The
 * server goes through the steps after the mark before it answers so; the reply
 * therefore says that the image is refused and that no deployment of the release is
 * open, which is what was asked for.
 */
export function revocationInPlace(error) {
  return error instanceof ApiError && error.status === 409 && error.code === 'already_revoked';
}

/**
 * That boards report a release that was just revoked. What an offline board runs is only
 * what it last reported, and may no longer be so.
 *
 * @param {{thing: string, online: boolean}[]} boards
 */
export function stillRunning(boards) {
  const heard = boards.filter((board) => board.online).length;
  const quiet = boards.length - heard;
  const who = boards.length === 1
    ? `${boards[0].thing} ${heard === 1 ? 'still runs it' : 'last reported running it'}`
    : [
      heard > 0 ? plural(heard, 'board still runs it', 'boards still run it') : null,
      quiet > 0 ? `${plural(quiet, 'board')} last reported running it` : null,
    ].filter(Boolean).join(' and ');
  return `${who}; to replace it there, upload a newer version and deploy that.`;
}

/**
 * What to say once a revocation has gone through.
 *
 * @param {string} version
 * @param {object} result
 * @param {string[]|null} result.cancelled  the deployments it cancelled; null when the
 *                                          server only said that all is in place
 * @param {boolean} result.again            the release was revoked before this request
 * @param {{thing: string, online: boolean}[]} [result.running]  the boards that report it
 */
export function revocationNotice(version, { cancelled, again, running = [] }) {
  const still = running.length > 0 ? ` ${stillRunning(running)}` : '';
  if (cancelled === null) {
    return `${again
      ? `The revocation of ${version} is in place: its image is refused and no deployment of it is open.`
      : `${version} was revoked already, and that revocation is in place.`}${still}`;
  }
  const lead = again ? `The revocation of ${version} is in place.` : `Revoked ${version}.`;
  if (cancelled.length === 0) return `${lead} No deployment of it was still open.${still}`;
  const stopped = plural(cancelled.length, 'unfinished deployment was', 'unfinished deployments were');
  return `${lead} ${stopped} cancelled.${still}`;
}

function errorFrom(status, payload) {
  const error = payload?.error;
  if (error && typeof error === 'object' && typeof error.message === 'string' && error.message !== '') {
    return new ApiError(status, text(error.code, 64) || 'error', text(error.message, 400), {
      requestId: optionalText(error.requestId, 64),
      details: Array.isArray(error.details) ? error.details.slice(0, 25) : null,
    });
  }
  // API Gateway answers some requests itself, as { "message": "..." }.
  if (typeof payload?.message === 'string' && payload.message !== '') {
    return new ApiError(status, 'gateway', `${text(payload.message, 200)} (HTTP ${status}).`);
  }
  return new ApiError(status, 'http', `The server answered with HTTP ${status}.`);
}

function parseJson(body) {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

// Time. Relative times compare a server timestamp with "now", so a wrong clock on this
// computer would make a board look offline or a session look expired. The Date header
// of API replies is used to notice a clock that is off by more than a few seconds.

const CLOCK_TOLERANCE_MS = 5000;

export function createClock(read = () => Date.now()) {
  let offset = 0;
  return {
    now: () => read() + offset,
    observe(dateHeader) {
      const server = Date.parse(dateHeader ?? '');
      if (Number.isNaN(server)) return;
      const difference = server - read();
      offset = Math.abs(difference) > CLOCK_TOLERANCE_MS ? difference : 0;
    },
  };
}

// Sign-in: OAuth 2.0 authorization code with PKCE against the managed login pages.
//
// One sign-in keeps its state and its PKCE verifier in sessionStorage until the login
// page sends the browser back; both are used once. After that the only thing kept is
// the access token and when it ends. The refresh token that comes with it is not
// wanted: it is never stored and is revoked straight away.

const FLOW_KEY = 'cranium.signin';
const SESSION_KEY = 'cranium.session';
const SIGNED_OUT_KEY = 'cranium.signedout';
const RANDOM_BYTES = 32;
const RENEW_BEFORE_S = 60;
const LOGIN_TIMEOUT_MS = 15000;
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const OAUTH_ERROR = /^[a-z_]{1,40}$/;

/** The sign-in settings the server put in the page. Null if they are unusable. */
export function readConfig(json) {
  const value = parseJson(json ?? '');
  if (value === null || typeof value !== 'object') return null;
  const config = {};
  for (const field of ['clientId', 'loginOrigin', 'scope', 'redirectUri']) {
    if (typeof value[field] !== 'string' || value[field] === '') return null;
    config[field] = value[field];
  }
  const origin = /^https?:\/\/[^/?#\s]+$/;
  const address = /^https?:\/\/[^?#\s]+$/;
  return origin.test(config.loginOrigin) && address.test(config.redirectUri) ? config : null;
}

function form(fields) {
  return new URLSearchParams(fields).toString();
}

/**
 * The pieces of the browser the flow uses are passed in, so that the tests can stand
 * in for them: storage (sessionStorage), location, history, fetch and crypto.
 *
 * The session is timed with this computer's own clock from start to end (`now`), so a
 * clock that is wrong changes nothing: the token's lifetime is a length of time.
 */
export function createAuth({
  config, storage, location, history, fetch, crypto, now = () => Date.now(), tellOtherTabs = () => {},
}) {
  const seconds = () => Math.floor(now() / 1000);

  function randomToken() {
    return toBase64Url(crypto.getRandomValues(new Uint8Array(RANDOM_BYTES)));
  }

  // When this page load completed a sign-in, in seconds; kept in memory only.
  let signedInAt = null;

  function readSession() {
    const session = parseJson(storage.getItem(SESSION_KEY) ?? '');
    if (session === null || typeof session !== 'object') return null;
    if (typeof session.accessToken !== 'string' || session.accessToken === '') return null;
    if (!Number.isFinite(session.expiresAt)) return null;
    return session;
  }

  function secondsLeft() {
    const session = readSession();
    return session ? session.expiresAt - seconds() : 0;
  }

  /** Start a sign-in. `route` is where to return to; only a route of the console is kept. */
  async function signIn(route) {
    const state = randomToken();
    const verifier = randomToken();
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    storage.removeItem(SESSION_KEY);
    storage.removeItem(SIGNED_OUT_KEY);
    storage.setItem(FLOW_KEY, JSON.stringify({ state, verifier, route: routeHash(parseRoute(route)) }));
    location.assign(`${config.loginOrigin}/oauth2/authorize?${form({
      response_type: 'code',
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      scope: config.scope,
      state,
      code_challenge: toBase64Url(new Uint8Array(digest)),
      code_challenge_method: 'S256',
      // Every sign-in asks for the password and the code, also while the login page's own
      // cookie is still valid: a closed tab, or one left open, does not sign in by itself.
      prompt: 'login',
    })}`);
  }

  /** Take the pending sign-in out of storage. It can be used for one reply only. */
  function takeFlow() {
    const flow = parseJson(storage.getItem(FLOW_KEY) ?? '');
    storage.removeItem(FLOW_KEY);
    if (flow === null || typeof flow !== 'object') return null;
    if (typeof flow.state !== 'string' || flow.state === '' || typeof flow.verifier !== 'string') return null;
    return flow;
  }

  async function revoke(refreshToken) {
    const url = `${config.loginOrigin}/oauth2/revoke`;
    const request = {
      method: 'POST',
      headers: FORM,
      body: form({ token: refreshToken, client_id: config.clientId }),
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      keepalive: true,
    };
    try {
      const response = await fetch(url, request);
      return response.ok ? 'revoked' : 'refused';
    } catch {
      // Either the request never left, or it did and the reply may not be read from
      // this origin. Sending it again without asking to read the reply tells which.
      try {
        await fetch(url, { ...request, mode: 'no-cors' });
        return 'sent';
      } catch {
        return 'failed';
      }
    }
  }

  let revocation = Promise.resolve('none');

  async function redeem(code, verifier) {
    let response;
    try {
      response = await fetch(`${config.loginOrigin}/oauth2/token`, {
        method: 'POST',
        headers: FORM,
        body: form({
          grant_type: 'authorization_code',
          client_id: config.clientId,
          code,
          redirect_uri: config.redirectUri,
          code_verifier: verifier,
        }),
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        signal: AbortSignal.timeout(LOGIN_TIMEOUT_MS),
      });
    } catch {
      throw new Error('The sign-in service could not be reached.');
    }
    let reply;
    try {
      reply = parseJson(await response.text());
    } catch {
      throw new Error('The sign-in service could not be reached.');
    }
    if (!response.ok) {
      const reason = OAUTH_ERROR.test(reply?.error ?? '') ? ` (${reply.error})` : '';
      throw new Error(`The sign-in service refused to issue a token${reason}.`);
    }
    if (typeof reply?.access_token !== 'string' || reply.access_token === '' ||
        !Number.isFinite(reply.expires_in) || reply.expires_in <= 0 ||
        String(reply.token_type).toLowerCase() !== 'bearer') {
      throw new Error('The sign-in service sent a reply the console could not read.');
    }

    // The refresh token goes nowhere but back to the service that issued it.
    if (typeof reply.refresh_token === 'string' && reply.refresh_token !== '') {
      revocation = revoke(reply.refresh_token);
    }
    signedInAt = seconds();
    storage.setItem(SESSION_KEY, JSON.stringify({
      accessToken: reply.access_token,
      expiresAt: signedInAt + Math.floor(reply.expires_in),
    }));
  }

  /**
   * Work out where the browser stands when the page loads: back from the login page,
   * already signed in, just signed out, or in need of signing in (which then starts).
   *
   * @param {string} currentHash  the route to come back to if sign-in has to start
   * @returns {Promise<{status: 'signed-in', route: string|null} | {status: 'redirecting'} |
   *   {status: 'signed-out', reason: string, message?: string}>}
   */
  async function resume(currentHash) {
    const query = new URLSearchParams(location.search);
    const code = query.get('code');
    const state = query.get('state');
    const failure = query.get('error');

    // Before anything else is requested: the code must not stay in the address bar,
    // in the history or in a Referer header.
    if (location.search !== '') {
      history.replaceState(null, '', location.pathname + location.hash);
    }

    if (code !== null || failure !== null) {
      const flow = takeFlow();
      if (!flow || state !== flow.state) {
        // Not the answer to a sign-in started in this tab. The code is dropped unused.
        return readSession() && secondsLeft() > RENEW_BEFORE_S
          ? { status: 'signed-in', route: null }
          : { status: 'signed-out', reason: 'unknown-reply' };
      }
      if (failure !== null) {
        const message = OAUTH_ERROR.test(failure) ? failure : '';
        return { status: 'signed-out', reason: 'login-error', message };
      }
      try {
        await redeem(code, flow.verifier);
      } catch (error) {
        return { status: 'signed-out', reason: 'no-token', message: error.message };
      }
      return { status: 'signed-in', route: routeHash(parseRoute(flow.route)) };
    }

    if (storage.getItem(SIGNED_OUT_KEY) !== null) {
      storage.removeItem(SIGNED_OUT_KEY);
      return { status: 'signed-out', reason: 'signed-out' };
    }
    if (readSession() && secondsLeft() > RENEW_BEFORE_S) {
      return { status: 'signed-in', route: null };
    }
    await signIn(currentHash);
    return { status: 'redirecting' };
  }

  /** Forget everything of this session in this tab. A reload then finds it signed out. */
  function forgetSession() {
    storage.clear();
    storage.setItem(SIGNED_OUT_KEY, '1');
  }

  /** Forget the session here and in the tabs next to this one, then end it at the login pages too. */
  function signOut() {
    forgetSession();
    tellOtherTabs();
    location.assign(`${config.loginOrigin}/logout?${form({
      client_id: config.clientId,
      logout_uri: config.redirectUri,
    })}`);
  }

  return {
    resume,
    signIn,
    signOut,
    /** Another tab was signed out: the same here, without going to the login pages. */
    signedOutElsewhere: forgetSession,
    /** The server has turned the token down, so it is worth nothing any more. */
    tokenRefused() {
      storage.removeItem(SESSION_KEY);
    },
    secondsLeft,
    /** The access token, or null once it has expired. */
    accessToken() {
      const session = readSession();
      return session && session.expiresAt > seconds() ? session.accessToken : null;
    },
    /** True when the token is about to expire and sign-in should start again. */
    needsRenewal: () => secondsLeft() <= RENEW_BEFORE_S,
    /** True if this page load completed a sign-in less than `window` seconds ago. */
    signedInWithin: (window) => signedInAt !== null && seconds() - signedInAt < window,
    /** How the revocation of the unwanted refresh token went: revoked, sent, refused, failed or none. */
    revocation: () => revocation,
  };
}

// What tabs of the same address say to each other. Only ever this one fixed word: no
// token, no address, nothing about who was signed in.
export const SESSION_CHANNEL = 'cranium.session';
export const SIGNED_OUT_SIGNAL = 'signed-out';

// The API client.

const MAX_TRIES = 3;
const RETRY_GET = new Set([429, 502, 503, 504]);
const RETRY_POST = new Set([429]);
const BACKOFF_MS = 400;
const REQUEST_TIMEOUT_MS = 25000;
const UPLOAD_TIMEOUT_MS = 60000;

function backoff(attempt, crypto) {
  // Jitter between half and one and a half times the step, which doubles each try.
  const unit = crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;
  return BACKOFF_MS * 2 ** (attempt - 1) * (0.5 + unit);
}

/**
 * @param {object} options
 * @param {object} options.auth            from createAuth
 * @param {Function} options.fetch
 * @param {Function} [options.XMLHttpRequest]  used for the firmware upload only, because
 *                                             it reports how much has been sent
 * @param {object} options.crypto
 * @param {object} options.clock
 * @param {Function} options.onUnauthorized    called when the API refuses the token
 * @param {Function} [options.pause]           waits the given milliseconds
 */
export function createApi({ auth, fetch, XMLHttpRequest, crypto, clock, onUnauthorized,
  pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  function unauthorized() {
    onUnauthorized();
    return new ApiError(401, 'unauthorized', 'Your session has ended. Sign in again to continue.');
  }

  async function request(method, path, body) {
    const retry = method === 'GET' ? RETRY_GET : RETRY_POST;
    for (let attempt = 1; ; attempt += 1) {
      const token = auth.accessToken();
      if (token === null) throw unauthorized();

      const headers = { authorization: `Bearer ${token}`, accept: 'application/json' };
      if (body !== undefined) headers['content-type'] = 'application/json';
      let response;
      try {
        response = await fetch(path, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          cache: 'no-store',
          credentials: 'omit',
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        throw error?.name === 'TimeoutError' ? tooSlow() : unreachable();
      }
      clock.observe(response.headers.get('date'));

      if (response.status === 401) throw unauthorized();
      if (retry.has(response.status) && attempt < MAX_TRIES) {
        await pause(backoff(attempt, crypto));
        continue;
      }
      let text;
      try {
        text = await response.text();
      } catch {
        throw new ApiError(0, 'network', 'The connection to the server broke off. Check the connection.');
      }
      const payload = parseJson(text);
      if (!response.ok) throw errorFrom(response.status, payload);
      if (payload === null) throw unreadable();
      return payload;
    }
  }

  /** One attempt at sending a firmware image, with progress. */
  function send(token, body, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/firmware');
      xhr.timeout = UPLOAD_TIMEOUT_MS;
      xhr.setRequestHeader('authorization', `Bearer ${token}`);
      xhr.setRequestHeader('accept', 'application/json');
      xhr.setRequestHeader('content-type', 'application/json');
      xhr.upload.onprogress = (event) => {
        if (!event.lengthComputable || event.total <= 0) return;
        onProgress({ stage: 'sending', sent: event.loaded / event.total });
      };
      xhr.upload.onload = () => onProgress({ stage: 'checking', sent: 1 });
      xhr.onload = () => resolve({
        status: xhr.status,
        text: xhr.responseText,
        date: xhr.getResponseHeader('date'),
      });
      xhr.onerror = () => reject(unreachable());
      xhr.ontimeout = () => reject(tooSlow());
      xhr.send(body);
    });
  }

  async function upload({ filename, notes, data }, onProgress = () => {}) {
    const fields = { filename, data };
    if (notes) fields.notes = notes;
    const body = JSON.stringify(fields);
    for (let attempt = 1; ; attempt += 1) {
      const token = auth.accessToken();
      if (token === null) throw unauthorized();
      onProgress({ stage: 'sending', sent: 0 });
      const reply = await send(token, body, onProgress);
      clock.observe(reply.date);
      if (reply.status === 401) throw unauthorized();
      if (RETRY_POST.has(reply.status) && attempt < MAX_TRIES) {
        await pause(backoff(attempt, crypto));
        continue;
      }
      const payload = parseJson(reply.text);
      if (reply.status < 200 || reply.status > 299) throw errorFrom(reply.status, payload);
      return readRelease(record(payload).release);
    }
  }

  function checked(test, value) {
    if (!test(value)) throw new ApiError(0, 'bad_request', 'That name is not valid.');
    return value;
  }

  const get = (path) => request('GET', path);
  const post = (path, body) => request('POST', path, body);

  return {
    me: async () => readMe(await get('/api/me')),
    devices: async () => readDevices(await get('/api/devices')),
    device: async (thing) => readDeviceDetail(await get(`/api/devices/${checked(isThing, thing)}`)),
    firmware: async () => readFirmware(await get('/api/firmware')),
    deployments: async () => readDeployments(await get('/api/deployments')),
    deployment: async (id) =>
      readDeployment(record(record(await get(`/api/deployments/${checked(isDeploymentId, id)}`)).deployment)),
    async audit({ limit = 50, before = null } = {}) {
      const query = { limit: String(limit) };
      if (before !== null) query.before = checked((cursor) => CURSOR.test(cursor), before);
      return readAudit(await get(`/api/audit?${form(query)}`));
    },
    upload,
    async revoke(version, reason) {
      const reply = record(await post(`/api/firmware/${checked(isVersion, version)}/revoke`, { reason }));
      return {
        release: readRelease(reply.release),
        cancelled: Array.isArray(reply.cancelled) ? reply.cancelled.filter(isDeploymentId) : [],
      };
    },
    async deploy({ version, things, note }) {
      const body = {
        version: checked(isVersion, version),
        things: things.map((thing) => checked(isThing, thing)),
      };
      if (note) body.note = note;
      return readDeployment(record(record(await post('/api/deployments', body)).deployment));
    },
    async cancel(id, force) {
      const path = `/api/deployments/${checked(isDeploymentId, id)}/cancel`;
      return readDeployment(record(record(await post(path, { force: force === true })).deployment));
    },
  };
}

// How often to ask again. A deployment is polled every 3 s while a board is installing
// or is online and may move at any moment, because someone stands at it to press its
// button. It is polled every 10 s while the only boards left are offline, and not at
// all once nothing is in flight.

export const POLL_INSTALLING_MS = 3000;
export const POLL_WAITING_MS = 10000;

/** The polling interval for a set of execution statuses; 0 means do not poll. */
export function pollInterval(statuses) {
  let waiting = false;
  for (const status of statuses) {
    if (status === 'IN_PROGRESS') return POLL_INSTALLING_MS;
    if (status === 'QUEUED') waiting = true;
  }
  return waiting ? POLL_WAITING_MS : 0;
}

/** The status an execution counts as for pollInterval: an online board that waits is watched closely. */
export function executionActivity(execution) {
  return execution.status === 'QUEUED' && execution.online ? 'IN_PROGRESS' : execution.status;
}

/**
 * The status a deployment summary amounts to, for pollInterval. `devices` is the board
 * list, where it has been read: the summary itself does not say which boards are online.
 */
export function summaryActivity(deployment, devices = []) {
  if (deployment.counts.inProgress > 0) return 'IN_PROGRESS';
  if (deployment.counts.queued === 0) return null;
  const online = devices.some((device) => device.online && deployment.things.includes(device.thing));
  return online ? 'IN_PROGRESS' : 'QUEUED';
}

/** The same for a board, judged by what it last reported. An offline board is not waited on. */
export function deviceActivity(device) {
  if (!device.online || !device.ota || device.ota.state === 'idle') return null;
  return 'IN_PROGRESS';
}

// A board that a forced cancellation found restarting cannot be stopped, and comes back
// on the new firmware or the old one a while later. AWS says nothing more about it, so
// for this long what the board itself reports is still followed.
const SETTLING_MS = 5 * MINUTE;

/**
 * True while a cancelled update may still change what a board runs: it had started,
 * and the board's last report still names this deployment.
 */
export function stillSettling(execution, board, deploymentId, nowMs) {
  if (execution.status !== 'CANCELED' || !execution.startedAt) return false;
  if (!board?.ota || board.ota.job !== deploymentId || board.ota.state === 'idle') return false;
  const since = Date.parse(execution.lastUpdatedAt);
  return !Number.isNaN(since) && nowMs - since < SETTLING_MS;
}

/**
 * True for a board that said that it is restarting and has not been written off yet. It
 * is off for that moment, whatever its connection still counts as.
 */
export function isRestarting(device) {
  return device.online && device.ota?.state === 'rebooting';
}

export function isUnfinished(status) {
  return status === 'QUEUED' || status === 'IN_PROGRESS';
}

/**
 * True while a board that a cancellation found restarting or on trial is still reporting
 * this deployment. AWS has written it off, and the board has not finished. It goes on
 * counting for as long as stillSettling() follows such a board.
 */
export function stillFinishing(deployment, devices, nowMs) {
  if (deployment.status !== 'CANCELED') return false;
  return (devices ?? []).some((device) => {
    if (device.ota?.job !== deployment.id) return false;
    if (device.ota.state !== 'rebooting' && device.ota.state !== 'testing') return false;
    if (device.online) return true;
    const since = Date.parse(device.lastSeen);
    return !Number.isNaN(since) && nowMs - since < SETTLING_MS;
  });
}

/**
 * Whether a deployment still has a board waiting or at work. The status of the job
 * does not say: a deployment cancelled without force keeps the boards that had started.
 */
export function isUnderWay(deployment) {
  return deployment.status === 'IN_PROGRESS' || deployment.counts.inProgress + deployment.counts.queued > 0;
}

// The decisions of the console's timers: when to read a page again and when to leave
// for the sign-in page. They are kept here so that they can be tested without a page.

export const RETRY_AFTER_ERROR_MS = 15000;
// From here on a page that holds unsent work says that the session is about to end.
export const SESSION_WARNING_S = 300;

/**
 * What the refresh timer does for a page that asks to be read every `interval` ms
 * (0 for never). `every` is how often the page is in fact read, which is what it tells
 * the user; `wait` is how long to wait now, 0 for not at all. A page that could not be
 * loaded is not asked for more often than every 15 s, and nothing is asked for while
 * the tab is in the background.
 */
export function refreshPlan({ interval, failed, visible }) {
  if (!(interval > 0)) return { every: 0, wait: 0 };
  const every = failed ? Math.max(interval, RETRY_AFTER_ERROR_MS) : interval;
  return { every, wait: visible ? every : 0 };
}

/** True while a chosen file is in hand: being read, waiting to be sent, on its way or refused. */
export function uploadInHand(stage) {
  return stage !== 'idle' && stage !== 'done';
}

/**
 * Whether to leave for the sign-in page now, shortly before the token ends. Not while
 * the tab is in the background or a message fills the page, and not while leaving would
 * throw work away: an open dialog, a chosen file, an upload on its way. If the token
 * then runs out, the next request says so.
 */
export function shouldRenew({ needsRenewal, visible, gate, dialogOpen, uploadStage }) {
  if (!needsRenewal || !visible || gate) return false;
  return !dialogOpen && !uploadInHand(uploadStage);
}

/**
 * What follows when the API refuses the token: as a rule 'sign-in' again; 'refused'
 * when the token is fresh, because signing in again would only repeat the refusal;
 * 'stay' when the page already shows a message about signing in, or when leaving would
 * throw work away (`holding`: an open dialog, a chosen file). The request that failed
 * then says so where the work is. `gate` is the message that fills the page, if any;
 * one that only says "loading" does not count.
 */
export function afterUnauthorized({ gate, fresh, holding = false }) {
  if ((gate && !gate.waiting) || holding) return 'stay';
  return fresh ? 'refused' : 'sign-in';
}

// Choosing boards for a deployment.

/** True if a board reports that it runs this version or a newer one: it will refuse the offer. */
export function alreadyRuns(device, version) {
  const target = parseVersion(version);
  const runs = device.fw ? parseVersion(device.fw.version) : null;
  return target !== null && runs !== null && compareVersions(runs, target) >= 0;
}

/**
 * True for a version that is not in the list of releases: it reached the board some other
 * way than a deployment of a release from this list. Nothing is said while the list has
 * not been read, or while it is empty and there is nothing to be registered among.
 */
export function isUnregistered(version, releases) {
  return Boolean(version) && Array.isArray(releases) && releases.length > 0 &&
    !releases.some((release) => release.version === version);
}

/**
 * The board to tick without being asked: the only one that has no unfinished update,
 * unless it would refuse the release anyway. Null when there is a choice to make.
 * `busy` holds the names of the boards that are not free.
 */
export function onlyChoice(devices, busy, version) {
  const free = devices.filter((device) => !busy.has(device.thing));
  if (free.length !== 1 || alreadyRuns(free[0], version)) return null;
  return free[0].thing;
}

// Words. What a board is doing, said the way one would say it to a teammate. Each
// description also names a tone (act, wait, live, good, warn, bad, idle) and an icon,
// so that no state is told apart by colour alone. "act" is the one state in which an
// update waits for a person.

// In a heading and in the name of a step, "Button 1" is held together by a no-break
// space: a line that ends on "Button" reads as if the number belonged to what follows.
const BUTTON_1 = 'Button\u00a01';

// The steps of an update, in order. `name` is what a step is called once it is done
// and while it is still ahead. Where that name would claim more than is true, `doing`
// is what the step is called while the board is at it, and `failed` what it is called
// when the update stopped there.
export const STEPS = [
  { name: 'Offered' },
  { name: 'Approved on the board', doing: `Waiting for ${BUTTON_1}`, failed: 'Not approved' },
  { name: 'Downloading', failed: 'Download failed' },
  // What the board checks here is the digest and the version. The signature is the
  // bootloader's to check, at the restart: this step must not read as that.
  { name: 'Download checked', doing: 'Checking the download', failed: 'Check failed' },
  { name: 'Restarting', failed: 'Did not start' },
  { name: 'On trial', failed: 'Rolled back' },
  { name: 'Confirmed' },
];
const APPROVED = 1;
const DOWNLOADED = 2;
const VERIFIED = 3;
const RESTARTED = 4;
const TESTED = 5;

// Told in the past: every one of these is about an update that is over, however long ago.
const REFUSALS = {
  not_newer: 'the board already ran this version or a newer one',
  too_large: 'the image was larger than the board’s update slot',
  bad_document: 'the board could not read the update instructions',
  unsupported: 'the board did not support this kind of update',
  url_not_allowed: 'the download address was not one the board accepts',
};

// `at` is the step that failed, where the board says enough to tell.
const FAILURES = {
  download_failed: {
    at: 2,
    title: 'The download failed',
    text: 'The board could not download the image.',
  },
  digest_mismatch: {
    at: 3,
    title: 'The download was damaged',
    text: 'What the board downloaded did not match the SHA-256 digest of the release, so the board ' +
      'discarded it.',
  },
  header_mismatch: {
    at: 3,
    title: 'Not the announced version',
    text: 'The image the board downloaded does not carry the version that was announced, so the board ' +
      'discarded it.',
  },
  flash_error: {
    at: null,
    title: 'The board could not store the update',
    text: 'Writing to the board’s flash memory failed.',
  },
  interrupted: {
    at: null,
    title: 'Interrupted',
    text: 'The board restarted before the update was complete.',
  },
  not_installed: {
    at: 4,
    title: 'Not installed',
    text: 'The board restarted, but the bootloader did not start the new image. It turns away an image ' +
      'with a wrong signature or an older version.',
  },
  trial_lost: {
    at: 5,
    title: 'Its trial was cut short',
    text: 'The board runs this image with nothing left to bring the old one back, because a restore of the ' +
      'golden image was interrupted right after it began. The image has proved nothing. Repeat the gesture ' +
      'at the board to finish the restore.',
    // This one did not keep the firmware it had.
    replaced: true,
  },
};

/**
 * Look a word up in one of the tables here. The word may come from a board, so names
 * that every object has, such as "constructor", must not count as entries.
 */
function entryOf(table, name) {
  return typeof name === 'string' && Object.hasOwn(table, name) ? table[name] : undefined;
}

/**
 * `failed` is the step at which the update went wrong, `stopped` the step the board had
 * reached when it was told to stop or went quiet: nothing went wrong there, and nothing
 * after it took place. `refusal` calls the failed step what it was when nobody turned
 * the update down by hand. `unknown` says that nothing can be told about the steps after
 * the ones that are done. `lastSeen` says that `stopped` is only where the board was when
 * it was last heard of, and `word` then says so instead of the word for a stop.
 */
function steps(done, {
  current = null, failed = null, stopped = null, ended = false, refusal = null, unknown = false, lastSeen = false,
} = {}) {
  return STEPS.map((step, index) => {
    let state = unknown ? 'unknown' : 'upcoming';
    if (index < done) state = 'done';
    else if (index === failed) state = 'failed';
    else if (index === stopped) state = 'stopped';
    else if (index === current) state = 'current';
    else if (ended) state = 'skipped';
    let label = step.name;
    if (state === 'current' || state === 'stopped') label = step.doing ?? step.name;
    else if (state === 'failed') label = refusal ?? step.failed ?? step.name;
    return lastSeen && state === 'stopped' ? { label, state, word: 'last seen here' } : { label, state };
  });
}

const mayHaveInstalled = (entry) => entry.status === 'SUCCEEDED' || entry.status === 'IN_PROGRESS';

/** The other deployment that put this version on a board, from the board's own list of updates. */
function otherInstall(history, deployment, version) {
  const other = (history ?? []).find((entry) => entry.deployment !== deployment &&
    (entry.version ?? versionOfDeployment(entry.deployment)) === version && mayHaveInstalled(entry));
  return other?.deployment ?? null;
}

/** True if a job that this console did not start, whose version it cannot know, may have put a version on a board. */
function outsideInstall(history) {
  return history.some((entry) => !(entry.version ?? versionOfDeployment(entry.deployment)) && mayHaveInstalled(entry));
}

/**
 * What became of a board after an update ended, where it reports something else than it
 * did then. How it got there is not on record, so that is not said.
 */
function movedSince(board, ranAtEnd) {
  const now = board?.fw?.version;
  if (!now || !ranAtEnd || now === ranAtEnd) return '';
  return board.online ? ` It has since moved to ${now}.` : ` When last seen, it had moved to ${now}.`;
}

function firstSentence(text) {
  const end = text.indexOf('. ');
  return end === -1 ? text : text.slice(0, end + 1);
}

function description(tone, icon, title, text, timeline, extra = {}) {
  return {
    tone,
    icon,
    title,
    text,
    brief: firstSentence(text),
    steps: timeline,
    progress: null,
    code: null,
    next: null,
    retry: false,
    ...extra,
  };
}

const STILL_OPEN = ' The update stays open until the board reports back or the time limit ends.';
const TRIAL_RULE = 'It is kept once the board has reconnected to AWS IoT; if it cannot, the bootloader puts the previous firmware back.';

/**
 * Describe one board's part in a deployment.
 *
 * @param {object} execution
 * @param {object} [known]
 * @param {object|null} [known.board]       the board as the board list has it, where that was read
 * @param {string|null} [known.deployment]  the id of the deployment
 * @param {string|null} [known.version]     the version the deployment installs
 * @param {Array|null} [known.history]      the board's own list of updates; null while it has
 *   not been read. A cancelled execution's `reported` is what the board reports now, so
 *   this is what tells whether another deployment is what put a version there.
 * @param {boolean} [known.historyCut]      that list leaves older updates out, so what it
 *   does not hold says nothing.
 * @param {boolean} [known.unread]          the board list has not been read yet, so that
 *   `board` being null does not mean that the board has nothing to say.
 * @returns {{tone: string, icon: string, title: string, text: string, brief: string,
 *   steps: Array, progress: number|null, code: string|null, next: string|null,
 *   retry: boolean}} `brief` is the first sentence of `text`; `progress` is the download
 *   in percent while the board reports it; `code` is the board's own reason when the
 *   console has no words for it; `next` is what to do about an update that ended short;
 *   `retry` says that offering the same release again makes sense. For a cancelled update
 *   `installed` says that it went through all the same, `installedBy` names the other
 *   deployment that installed this version, and `unsure` that this cannot be told yet.
 */
export function describeExecution(execution, {
  board = null, deployment = null, version = null, history = null, historyCut = false, unread = false,
} = {}) {
  const { phase, reason, ranAtEnd, reported, online, progress, startedAt } = execution;
  // An update that the board saw through to its end: `ranAtEnd` is what the board said then,
  // kept with the job. It stays as it was however long ago that was, so it is told in the
  // past. Where the job holds none, or could not be read, no version is named at all.
  const ranThen = ranAtEnd ? ` The board was running ${ranAtEnd} at the time.` : '';
  const kept = ranAtEnd ? ` It kept running the firmware it had, ${ranAtEnd}.` : ' It kept running the firmware it had.';
  const since = movedSince(board, ranAtEnd);
  // An update the board could not see through (cancelled, timed out): `reported` is the
  // board's own latest report. An offline board's is old news, and says so.
  let reports = '';
  if (reported) reports = online ? ` The board reports that it runs ${reported}.` : ` When last seen, the board reported ${reported}.`;
  // Offering this release again only makes sense if the board would not refuse it: the rule
  // of the deployment dialog. While the board list has not been read it cannot be told.
  const mayRetry = !unread && !(board && alreadyRuns(board, version));
  const again = (next = 'To try again, start a new deployment.') => (mayRetry ? { next, retry: true } : {});
  const target = version ?? 'an update';
  // A step of an update under way. A board that has gone offline can only say where it was
  // when it was last heard of, so that is what is said, and it is not drawn as moving.
  const underWay = (iconName, at, { title, text, extra }, { was, quiet }) => (online
    ? description('live', iconName, title, text, steps(at, { current: at }), extra)
    : description('idle', iconName, `Was ${was} when last seen`, quiet, steps(at, { stopped: at, unknown: true, lastSeen: true })));

  switch (phase) {
    case 'waiting_for_device':
      // A board the list knows and has never heard from: nothing to wait for by itself.
      if (!online && board && !board.lastSeen) {
        return description('wait', 'minus-circle', 'Never connected',
          'Power it up and check that it was provisioned; it will see this update when it first connects.',
          steps(0, { current: 0 }));
      }
      if (!online) {
        return description('wait', 'offline', 'Board offline',
          'The board is offline; it will see this update when it reconnects.',
          steps(0, { current: 0 }));
      }
      return description('wait', 'clock', 'Not picked up yet',
        'The board is online but has not picked up the offer yet. That normally takes a few seconds.',
        steps(0, { current: 0 }));
    case 'waiting_for_button':
      // The one moment in an update when everything waits for a person: said as an
      // instruction, in a tone of its own.
      return description('act', 'press', `Press ${BUTTON_1} on the board`,
        `The board has the offer and waits for someone to press ${BUTTON_1}. LED1 blinks quickly ` +
        'while the offer is open; Button 2 declines it.',
        steps(1, { current: 1 }));
    case 'downloading':
      return underWay('download', 2, {
        title: progress === null ? 'Downloading' : `Downloading ${progress}%`,
        text: 'The board is downloading the image into its spare flash slot. The firmware it runs is ' +
          'not touched yet.',
        extra: { progress, said: 'Downloading' },
      }, {
        was: `downloading ${target}`,
        quiet: `The board went offline ${progress === null ? 'during the download' : `with the download at ${progress}%`}.${STILL_OPEN}`,
      });
    case 'verifying':
      return underWay('shield', 3, {
        title: 'Checking the download',
        text: 'The board is checking the size, the SHA-256 digest and the version in the signed header ' +
          'before it installs anything.',
      }, {
        was: `checking the download of ${target}`,
        quiet: `The board went offline while it was checking the download.${STILL_OPEN}`,
      });
    case 'rebooting':
      return underWay('restart', 4, {
        title: 'Restarting',
        text: 'The board is restarting. The bootloader checks the signature before it starts the new firmware.',
      }, {
        was: `restarting into ${target}`,
        quiet: `The board went offline while it was restarting.${STILL_OPEN}`,
      });
    case 'testing':
      return underWay('pulse', 5, {
        title: 'On trial',
        text: `The new firmware is running on trial. ${TRIAL_RULE}`,
      }, {
        was: `on trial with ${target}`,
        quiet: `The board went offline with the new firmware on trial. ${TRIAL_RULE}`,
      });
    case 'succeeded': {
      // That it went through stays true. That the board runs it is for the board to say today.
      const holds = Boolean(ranAtEnd) && board?.online === true && board.fw?.version === ranAtEnd && board.fw.confirmed;
      let told = 'The board confirmed the new firmware.';
      if (holds) told = `The board runs ${ranAtEnd} and has confirmed it.`;
      else if (ranAtEnd) told = `The board confirmed ${ranAtEnd} when this update ended.${since}`;
      return description('good', 'check-circle', 'Installed and confirmed', told, steps(STEPS.length));
    }
    case 'rolled_back':
      return description('bad', 'undo', 'Rolled back',
        'The bootloader put the previous firmware back. The new firmware started but did not ' +
        `reconnect to AWS IoT, so it was never confirmed.${ranAtEnd ? ` That left the board on ${ranAtEnd}.` : ''}${since}`,
        steps(5, { failed: 5, ended: true }),
        // Old news once the board runs this version or a newer one.
        mayRetry ? { next: 'Fix the build, then upload a newer version and deploy that.' } : {});
    case 'declined':
      return description('warn', 'minus-circle', 'Declined on the board',
        `Someone pressed Button 2 on the board to decline this update. Nothing was installed.${ranThen}${since}`,
        steps(1, { failed: 1, ended: true }), again());
    case 'refused': {
      // No reason on record: the job holds none, or could not be read. So whether a person
      // pressed Button 2 or the board refused is not known either.
      if (!reason) {
        return description('warn', 'ban', 'Refused or declined',
          `This update was turned down on the board before anything was installed.${ranThen}${since}`,
          steps(1, { failed: 1, ended: true }), again());
      }
      const why = entryOf(REFUSALS, reason);
      const said = why ? `Refused: ${why}.` : 'The board refused this update before installing anything.';
      // Offered again, a board that already runs this version gives the same answer.
      const way = reason === 'not_newer'
        ? { next: 'To put something else on it, upload a newer version and deploy that.' }
        : again('Deal with that first, then start a new deployment.');
      return description('warn', 'ban', 'Refused by the board', `${said}${ranThen}${since}`,
        steps(1, { failed: 1, ended: true, refusal: 'Refused' }), { code: why ? null : reason, ...way });
    }
    case 'failed': {
      const failure = entryOf(FAILURES, reason);
      if (failure) {
        return description('bad', 'x-circle', failure.title, `${failure.text}${failure.replaced ? '' : kept}${since}`,
          steps(failure.at ?? DOWNLOADED,
            failure.at === null ? { stopped: DOWNLOADED, ended: true } : { failed: failure.at, ended: true }),
          again());
      }
      // A refusal reported once the update was under way arrives as a failure.
      const why = entryOf(REFUSALS, reason);
      const said = why ? `The board stopped: ${why}.` : 'The board reported that the update failed.';
      // With no reason on record, where it stopped is not on record either.
      return description('bad', 'x-circle', 'Failed', `${said}${kept}${since}`,
        steps(DOWNLOADED, reason ? { stopped: DOWNLOADED, ended: true } : { unknown: true }), { code: why ? null : reason, ...again() });
    }
    case 'cancelled': {
      // What the board runs now, against what this deployment offered. `reported` is what it
      // says today, which can be long after this deployment ended. How it got there, and
      // when, is not on record: a deployment, a USB cable or a serial port, before or after.
      const [now, offered] = [reported, version].map((text) => (text ? parseVersion(text) : null));
      const movedOn = Boolean(now && offered) && compareVersions(now, offered) > 0;
      const runsIt = Boolean(reported) && reported === version;
      if (!startedAt) {
        // The offer was made, and withdrawn before the board acted on it. If the board runs
        // this version or a newer one all the same, this deployment is not what put it there,
        // and offering this one again would only be refused.
        if (runsIt || movedOn) {
          const installedBy = runsIt ? otherInstall(history, deployment, version) : null;
          return description('idle', 'stop', 'Cancelled',
            `Cancelled before the board started, so this deployment installed nothing.${reports}`,
            steps(APPROVED, { ended: true }), installedBy ? { installedBy } : {});
        }
        return description('idle', 'stop', 'Cancelled',
          `Cancelled before the board started. Nothing was installed.${reports}`,
          steps(APPROVED, { ended: true }), again());
      }
      // It stopped when it was told to, and a later deployment is what installed the version.
      const installedBy = runsIt ? otherInstall(history, deployment, version) : null;
      if (installedBy) {
        return description('idle', 'stop', 'Cancelled',
          `Cancelled after the board had started, and it stopped there. Another deployment installed ${reported}.`,
          steps(DOWNLOADED, { stopped: DOWNLOADED, ended: true }), { installedBy });
      }
      // A newer version came later. Whether this update had finished before that is not on
      // record: a board that AWS has cancelled can no longer report. Nothing is claimed, and
      // this version is not offered again, because the board would refuse it.
      if (movedOn) {
        return description('idle', 'stop', 'Cancelled',
          `Cancelled after the board had started.${reports} This page cannot tell how this update ended.`,
          steps(DOWNLOADED, { unknown: true }), { unsure: true });
      }
      // A board that was past its last look at AWS when the cancellation came ends up on the
      // new firmware all the same, and AWS has no more to say about it. So does one flashed
      // with this version by other means, so this takes the board's own word that its last
      // update went through, and a whole list of updates with no other job that can have done it.
      const wentThrough = runsIt && board?.fw?.confirmed && board.ota?.last === 'succeeded' &&
        Array.isArray(history) && !historyCut && !outsideInstall(history);
      if (wentThrough) {
        return description('warn', 'alert', 'Installed despite the cancellation',
          'This deployment was cancelled, but the board had gone too far to be stopped. ' +
          `${online ? 'It now runs' : 'When last seen, it ran'} ${reported}.`,
          steps(STEPS.length),
          { next: 'To replace it, upload a newer version and deploy that.', installed: true });
      }
      const reached = board?.ota && board.ota.job === deployment ? board.ota.state : null;
      if (reached === 'rebooting' || reached === 'testing') {
        const at = reached === 'rebooting' ? RESTARTED : TESTED;
        if (!online) {
          return description('idle', 'restart',
            `Was ${reached === 'rebooting' ? `restarting into ${target}` : `on trial with ${target}`} when last seen`,
            'This deployment was cancelled, but the board was already restarting into the new firmware, and it ' +
            'has gone offline since. What it ends up running will show here.',
            steps(at, { stopped: at, unknown: true, lastSeen: true }));
        }
        return description('live', 'restart', 'Finishing despite the cancellation',
          'This deployment was cancelled, but the board was already restarting into the new firmware ' +
          'and cannot be stopped. What it ends up running will show here.',
          steps(at, { current: at, ended: true }));
      }
      // The board runs this version, and nothing says how it got there: nothing is claimed.
      if (runsIt) {
        return description('idle', 'stop', 'Cancelled',
          `Cancelled after the board had started. ${online ? 'The board now runs' : 'When last seen, the board ran'} ${reported}; ` +
          'how it got there is not on record.',
          steps(DOWNLOADED, { unknown: true }), { unsure: true });
      }
      // The board list decides between "it stopped" and "it is restarting and cannot be
      // stopped". Until it has been read, neither is said.
      if (unread) {
        return description('idle', 'stop', 'Cancelled',
          'Cancelled after the board had started. What the board did next is still being read.',
          steps(DOWNLOADED, { unknown: true }), { unsure: true });
      }
      return description('idle', 'stop', 'Cancelled',
        'Cancelled after the board had started. A board asks AWS before it installs, so it stops ' +
        `there and keeps the firmware it had.${reports}`,
        steps(reached === 'verifying' ? VERIFIED : DOWNLOADED,
          { stopped: reached === 'verifying' ? VERIFIED : DOWNLOADED, ended: true }),
        again());
    }
    case 'timed_out':
      return description('bad', 'hourglass', 'Timed out',
        `The board started but did not report a result before the time limit.${reports}`,
        steps(DOWNLOADED, { stopped: DOWNLOADED, ended: true }),
        again('Check that the board is powered and online, then start a new deployment.'));
    case 'removed':
      return description('idle', 'minus', 'Removed', 'This board was taken out of the deployment.',
        steps(0, { ended: true }));
    default:
      return description('idle', 'minus', 'Unknown state',
        'The server reported a state this console does not know.',
        steps(0), { code: phase || null });
  }
}

/** The words for an execution status alone, where no phase is known (a board's history). */
export function describeStatus(status) {
  switch (status) {
    case 'QUEUED': return { tone: 'wait', icon: 'clock', label: 'Waiting' };
    case 'IN_PROGRESS': return { tone: 'live', icon: 'restart', label: 'Updating' };
    case 'SUCCEEDED': return { tone: 'good', icon: 'check-circle', label: 'Installed' };
    case 'FAILED': return { tone: 'bad', icon: 'x-circle', label: 'Failed' };
    case 'TIMED_OUT': return { tone: 'bad', icon: 'hourglass', label: 'Timed out' };
    case 'REJECTED': return { tone: 'warn', icon: 'ban', label: 'Refused or declined' };
    case 'REMOVED': return { tone: 'idle', icon: 'minus', label: 'Removed' };
    case 'CANCELED': return { tone: 'idle', icon: 'stop', label: 'Cancelled' };
    default: return { tone: 'idle', icon: 'minus', label: 'Unknown' };
  }
}

// What the status alone cannot tell apart, and the board's last report can.
const OWN_WORDS = {
  FAILED: { rolled_back: { tone: 'bad', icon: 'undo', label: 'Rolled back' } },
  REJECTED: {
    declined: { tone: 'warn', icon: 'minus-circle', label: 'Declined on the board' },
    refused: { tone: 'warn', icon: 'ban', label: 'Refused by the board' },
  },
};

/**
 * The words for an entry of a board's history. `last` is how the board says its newest
 * update ended, for that entry; the others only have their status.
 */
export function describeHistory(status, last = null) {
  return entryOf(entryOf(OWN_WORDS, status) ?? {}, last) ?? describeStatus(status);
}

// `quiet` marks what is an absence of news, so that it is drawn as less than news.
const LAST_UPDATE = {
  none: { tone: 'idle', icon: 'minus', title: 'No update in progress', quiet: true },
  succeeded: { tone: 'good', icon: 'check-circle', title: 'Last update succeeded' },
  failed: { tone: 'bad', icon: 'x-circle', title: 'Last update failed' },
  rolled_back: { tone: 'bad', icon: 'undo', title: 'Last update was rolled back' },
  declined: { tone: 'warn', icon: 'minus-circle', title: 'Last update was declined on the board' },
  refused: { tone: 'warn', icon: 'ban', title: 'Last update was refused by the board' },
  cancelled: { tone: 'idle', icon: 'stop', title: 'Last update was cancelled' },
};

/**
 * Describe what a board last said about updates. `deployment` is the update it is
 * working on, if any. An offline board's words are old news, and say so.
 */
export function describeUpdate(device) {
  const { ota, online } = device;
  const settled = { text: '', progress: null, deployment: null };
  if (!ota) return { tone: 'idle', icon: 'minus', title: 'Nothing reported', quiet: true, ...settled };

  const version = versionOfDeployment(ota.job);
  const target = version ?? 'an update';
  // `was` is how the state reads for a board that has gone offline since, where the
  // title itself does not make a sentence after "Was".
  const live = (tone, icon, title, text, { progress = null, was = null } = {}) => ({
    tone: online ? tone : 'idle',
    icon,
    title: online ? title : `Was ${was ?? title.charAt(0).toLowerCase() + title.slice(1)} when last seen`,
    text: online ? text : '',
    progress: online ? progress : null,
    deployment: ota.job,
  });

  switch (ota.state) {
    case 'idle': {
      const last = entryOf(LAST_UPDATE, ota.last) ?? LAST_UPDATE.none;
      // The board's error is a reason code; say it in words where there are words for it.
      const refusal = entryOf(REFUSALS, ota.error);
      const why = entryOf(FAILURES, ota.error)?.title ?? (refusal ? `Because ${refusal}.` : '');
      const text = ota.last === 'failed' || ota.last === 'refused' ? why : '';
      const told = last === LAST_UPDATE.none && !online ? { title: 'No update in progress when last seen' } : null;
      return { ...last, ...told, ...settled, text };
    }
    case 'awaiting_user':
      return live('act', 'press', `Press ${BUTTON_1} on the board`,
        `${version ?? 'An update'} is on offer. Button 1 on the board installs it, Button 2 declines.`,
        { was: `waiting for ${BUTTON_1}` });
    case 'downloading':
      return live('live', 'download', `Downloading ${target}`, '', { progress: ota.progress });
    case 'verifying':
      return live('live', 'shield', `Checking the download of ${target}`, '');
    case 'rebooting':
      return live('live', 'restart', `Restarting into ${target}`, '');
    case 'testing':
      return live('live', 'pulse', `On trial: ${target}`, 'It is kept once the board has reconnected.',
        { was: `on trial with ${target}` });
    default:
      return live('live', 'restart', 'Updating', '');
  }
}

/**
 * Where the boards of a deployment that went through stand today. That it went through is
 * on record for good; that they still run it is for them to say.
 *
 *   'current'   every one of them is online, on this version, and has confirmed it
 *   'unheard'   nothing speaks against it, but not all of them can say so
 *   'moved'     `moved` holds the ones that report another version
 */
export function installStanding(deployment, devices) {
  const boards = (devices ?? []).filter((device) => deployment.things.includes(device.thing));
  const moved = deployment.version === null
    ? []
    : boards.filter((device) => device.fw && device.fw.version !== deployment.version);
  if (moved.length > 0) return { state: 'moved', boards, moved };
  const current = boards.length > 0 && boards.length === deployment.things.length && boards.every((device) =>
    device.online && device.fw?.version === deployment.version && device.fw.confirmed);
  return { state: current ? 'current' : 'unheard', boards, moved };
}

/**
 * The badge for a deployment as a whole. `said` is the sentence for one that is over and
 * has something to tell, good or bad, on a page that would otherwise only say that nothing
 * is going on. `devices` is the board list, where it has been read: without it, what a
 * deployment installed is only told as something that happened.
 */
export function describeDeployment(deployment, devices = null) {
  const { status, counts, things } = deployment;
  const total = things.length || COUNTS.reduce((sum, name) => sum + counts[name], 0);
  switch (status) {
    case 'IN_PROGRESS':
      return counts.inProgress > 0
        ? { tone: 'live', icon: 'restart', label: 'Updating' }
        : { tone: 'wait', icon: 'clock', label: 'Waiting for boards' };
    case 'COMPLETED':
      if (total > 0 && counts.succeeded === total) {
        const what = deployment.version ?? 'The update';
        const verb = installStanding(deployment, devices).state === 'current' ? 'is' : 'was';
        return {
          tone: 'good',
          icon: 'check-circle',
          label: 'Succeeded',
          said: `${what} ${verb} installed and confirmed${total === 1 ? '' : ` on ${total} boards`}.`,
        };
      }
      if (counts.succeeded > 0) {
        return {
          tone: 'warn', icon: 'alert', label: 'Partly succeeded', said: 'The last deployment partly succeeded.',
        };
      }
      if (counts.failed + counts.timedOut > 0) {
        return { tone: 'bad', icon: 'x-circle', label: 'Failed', said: 'The last deployment failed.' };
      }
      return { tone: 'idle', icon: 'minus-circle', label: 'Not installed' };
    case 'CANCELED':
      // Cancelling leaves boards that had started alone: the badge does not hide them.
      if (counts.inProgress > 0) {
        return { tone: 'live', icon: 'restart', label: `Cancelled, ${plural(counts.inProgress, 'board')} still working` };
      }
      if (counts.succeeded > 0) {
        return {
          tone: 'warn',
          icon: 'alert',
          label: `Cancelled, ${plural(counts.succeeded, 'board')} finished`,
          said: `The last deployment was cancelled, but ${plural(counts.succeeded, 'board')} finished it.`,
        };
      }
      return { tone: 'idle', icon: 'stop', label: 'Cancelled' };
    case 'SCHEDULED': return { tone: 'wait', icon: 'clock', label: 'Scheduled' };
    case 'DELETION_IN_PROGRESS': return { tone: 'idle', icon: 'minus', label: 'Being deleted' };
    default: return { tone: 'idle', icon: 'minus', label: 'Unknown' };
  }
}

const COUNT_WORDS = [
  ['succeeded', 'succeeded', 'good', 'check-circle'],
  ['inProgress', 'updating', 'live', 'restart'],
  ['queued', 'waiting', 'wait', 'clock'],
  ['failed', 'failed', 'bad', 'x-circle'],
  ['timedOut', 'timed out', 'bad', 'hourglass'],
  ['rejected', 'refused or declined', 'warn', 'ban'],
  ['canceled', 'cancelled', 'idle', 'stop'],
  ['removed', 'removed', 'idle', 'minus'],
];

/**
 * The non-zero board counts of a deployment, in a fixed order, with their words.
 * `atButton` of the waiting boards are waiting for a person, which is told apart where
 * the board list says so.
 */
export function describeCounts(counts, atButton = 0) {
  const pressing = Math.min(atButton, counts.queued);
  const lines = COUNT_WORDS
    .filter(([name]) => counts[name] > 0 && !(name === 'queued' && counts.queued === pressing))
    .map(([name, label, tone, icon]) => ({
      name, count: name === 'queued' ? counts.queued - pressing : counts[name], label, tone, icon,
    }));
  if (pressing > 0) {
    lines.unshift({
      name: 'atButton', count: pressing, label: `waiting for ${BUTTON_1}`, tone: 'act', icon: 'press',
    });
  }
  return lines;
}

/**
 * What to say to a screen reader about the boards in a list, compared with what they
 * were when `before` was made. Only a change of state is news, not every percent.
 * Returns the new record and the sentences. The first look at a board says nothing.
 */
export function boardChanges(before, devices) {
  const seen = new Map();
  const said = [];
  for (const device of devices) {
    const { title } = describeUpdate(device);
    seen.set(device.thing, title);
    if (before.has(device.thing) && before.get(device.thing) !== title) {
      said.push(`${device.thing.slice(0, 12)}…: ${title}.`);
    }
  }
  return { seen, said };
}

// People. An account is its id (the token's sub); the e-mail address is what it showed
// at the time and can be changed by its owner. Wherever a person is named, the id is
// within reach.

/** The start of an account id: enough to tell a handful of accounts apart at a glance. */
export function shortAccount(sub) {
  const id = typeof sub === 'string' ? sub : '';
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

/** What to call a person: the address, or failing that the start of the account id. */
export function nameOf(person) {
  if (person?.email) return person.email;
  return person?.sub ? `account ${shortAccount(person.sub)}` : 'an unknown account';
}

// A deployment is named by the version it installs: the words that end in "of" lose it
// when an entry has no target.
// `triedAlone` is the whole sentence for a request refused before it named anything.
const AUDIT_ACTIONS = {
  'firmware.upload': {
    done: 'uploaded firmware', tried: 'tried to upload', triedAlone: 'tried to upload a file', icon: 'upload',
  },
  'firmware.revoke': {
    done: 'revoked firmware', tried: 'tried to revoke firmware', triedAlone: 'tried to revoke a release', icon: 'ban',
  },
  'deployment.create': {
    done: 'started a deployment of', tried: 'tried to deploy', triedAlone: 'tried to start a deployment', icon: 'send',
  },
  'deployment.cancel': {
    done: 'cancelled the deployment of',
    tried: 'tried to cancel the deployment of',
    triedAlone: 'tried to cancel a deployment',
    icon: 'stop',
  },
};

// What scripts/ota.sh and the test bench call their requests. They invoke the API function
// directly, with AWS credentials and without API Gateway or a sign-in, in a person's name.
// API Gateway makes up the id of every request that comes through it, so nobody can put
// this on a request from a browser.
const SCRIPTED_REQUEST = 'bench-';

const AUDIT_OUTCOMES = {
  rejected: { tone: 'warn', icon: 'ban', label: 'Refused' },
  denied: { tone: 'bad', icon: 'lock', label: 'Not allowed' },
  error: { tone: 'bad', icon: 'alert', label: 'Server error' },
};

// Why the server refused a request or failed at it, in words, for a log line that only has
// the code. Every code the API can record is here: a test goes through its source for them.
export const REFUSAL_WORDS = {
  account_inactive: 'The account is not active',
  already_cancelled: 'That deployment was already cancelled',
  already_finished: 'That deployment had already finished',
  already_revoked: 'That release was already revoked',
  audit_failed: 'The change could not be written to this log',
  bad_header: 'The image header cannot be read',
  bad_signing_key: 'The server’s signing key cannot be read',
  cancel_refused: 'AWS IoT would not cancel it',
  forbidden: 'This account may not do that',
  internal_error: 'Something went wrong on the server',
  invalid_body: 'The request could not be read',
  invalid_deployment: 'Not a valid deployment ID',
  invalid_filename: 'The file name has characters the server does not accept, or is too long',
  invalid_json: 'The request could not be read',
  invalid_thing: 'Not a valid board name',
  invalid_things: 'The list of boards is not valid',
  invalid_version: 'Not a valid version number',
  not_found: 'There is nothing at that address',
  payload_too_large: 'The request was too large',
  release_manager_required: 'Only a release manager can do this',
  revoke_incomplete: 'The revocation did not finish',
  throttled: 'AWS asked the server to slow down',
  timeout: 'The server ran out of time',
  unauthorized: 'The sign-in was not accepted',
  unknown_deployment: 'There is no such deployment',
  unknown_device: 'A board is not registered',
  unknown_version: 'There is no such release',
  unsupported_flags: 'Uses image options this project does not',
  upload_conflict: 'Another upload was under way at that moment',
  wrong_key: 'Signed with a different key than this project’s',
  bad_signature: 'The signature is not valid',
  unsigned: 'Not signed',
  hash_mismatch: 'The file is damaged',
  bad_magic: 'Not an MCUboot image',
  not_an_image: 'Not an MCUboot image',
  too_small: 'Too small to be a firmware image',
  too_large: 'Too large for the board’s slot',
  truncated: 'Shorter than its header says',
  wrong_target: 'Not built for this product’s flash layout',
  trailing_data: 'Has data after the signature',
  unexpected_tlv: 'Not signed the way this project requires',
  malformed_tlv: 'The signature area cannot be read',
  bad_signature_encoding: 'The signature cannot be read',
  version_exists: 'That version is already registered',
  version_not_newer: 'Not newer than the highest version registered',
  version_zero: 'Version 0.0.0+0 is never accepted',
  device_busy: 'A board had an unfinished update',
  release_revoked: 'The release is revoked',
};

/** What a cancellation asked for, in the words of the dialog it is asked for in. */
function forceAsked(value) {
  if (value === 'true') return 'withdraw the offer and stop boards that had started';
  return value === 'false' ? 'withdraw the offer' : value;
}

/** Set when a request failed after AWS had cancelled the job: the entry says so all the same. */
function cancelledAnyway(value) {
  if (value === 'true') return 'all the same';
  return value === 'false' ? 'no' : value;
}

// The steps of a revocation after the mark, as the API names the ones it could not complete.
const REVOCATION_STEPS = {
  tag: 'refusing the image',
  cancel: 'cancelling the deployments',
  record: 'recording that it is done',
};

function stepsLeft(value) {
  return value.split(' ').filter(Boolean).map((step) => entryOf(REVOCATION_STEPS, step) ?? step).join(', ');
}

// What the API records with an entry, in the words of the console and in the order in
// which a line reads best. A label reads on into its value, like "Size 1,264 bytes";
// `sentence` marks a value in free words, which a colon sets off from its label. `code`
// marks a value that is an identifier and is set in the monospace face.
const AUDIT_DETAILS = {
  code: { label: 'Refused with', code: true },
  incomplete: { label: 'Left undone', say: stepsLeft, sentence: true },
  filename: { label: 'File', code: true },
  version: { label: 'Version', code: true },
  things: { label: 'Boards' },
  force: { label: 'Asked to', say: forceAsked },
  reason: { label: 'Reason', sentence: true },
  cancelled: { label: 'Cancelled', say: cancelledAnyway },
  size: { label: 'Size', say: (value) => exactBytes(Number(value)) || value },
  sha256: { label: 'SHA-256', code: true },
};

function auditFact(entry, key, value) {
  const known = entryOf(AUDIT_DETAILS, key);
  if (!known) return { key, label: key, value, code: false, phrase: false, words: null };
  let { label } = known;
  // A revocation counts the deployments it cancelled; a failure that is not a refusal
  // did not refuse anything.
  if (key === 'cancelled' && entry.action === 'firmware.revoke') label = 'Deployments cancelled';
  if (key === 'code' && entry.outcome === 'error') label = 'Failed with';
  return {
    key,
    label,
    value: known.say ? known.say(value) : value,
    code: known.code === true,
    phrase: known.sentence !== true,
    // A refusal is said in words where there are words for it, with its code after them.
    words: key === 'code' ? entryOf(REFUSAL_WORDS, value) ?? null : null,
  };
}

/**
 * One line of the activity log: what was done, to what, and how it ended if not well.
 * `label` is what to call the target. A deployment is called by its version; its id
 * goes to `facts`, which are the details of the entry in words.
 */
export function describeAudit(entry) {
  const action = entryOf(AUDIT_ACTIONS, entry.action);
  const ok = entry.outcome === 'ok';
  const other = { tone: 'idle', icon: 'minus', label: entry.outcome || 'Unknown' };
  const deployment = isDeploymentId(entry.target) ? entry.target : null;
  const label = deployment ? versionOfDeployment(deployment) ?? deployment : entry.target ?? '';
  const details = new Map(entry.detail ?? []);
  // A revocation that completed what an earlier request had begun.
  const resumed = entry.action === 'firmware.revoke' && ok && details.get('resumed') === 'true';
  let words = entry.action || 'did something';
  if (resumed) words = 'finished revoking firmware';
  else if (action && ok) words = action.done;
  else if (action) words = label ? action.tried : action.triedAlone;

  const order = [...Object.keys(AUDIT_DETAILS), ...details.keys()];
  const facts = [];
  for (const key of new Set(order)) {
    if (!details.has(key)) continue;
    // Said by the sentence already: the version of a deployment, and that a revocation was finished.
    if ((key === 'version' && details.get(key) === label) || (key === 'resumed' && resumed)) continue;
    // And the name of the file that an upload is told by.
    if (key === 'filename' && details.get(key) === label) continue;
    facts.push(auditFact(entry, key, details.get(key)));
  }
  if (deployment) {
    facts.push({ key: 'target', label: 'Deployment', value: deployment, code: true, phrase: true, words: null });
  }

  return {
    icon: action?.icon ?? 'list',
    verb: label ? words : words.replace(/ of$/, ''),
    label,
    outcome: ok ? null : entryOf(AUDIT_OUTCOMES, entry.outcome) ?? other,
    href: deploymentHref(entry.target) ?? (isVersion(entry.target) ? '#/firmware' : null),
    facts,
    scripted: String(entry.requestId ?? '').startsWith(SCRIPTED_REQUEST),
  };
}
