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
  if (version.major > 0xff || version.minor > 0xff || version.revision > 0xffff || version.build > 0xffffffff) {
    return null;
  }
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

const SECTIONS = ['overview', 'devices', 'firmware', 'deployments', 'activity'];
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

/** "3 min ago". Empty if there is no time. */
export function timeAgo(iso, nowMs) {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const elapsed = nowMs - then;
  if (elapsed < 5 * SECOND) return 'just now';
  if (elapsed < MINUTE) return `${Math.floor(elapsed / SECOND)} s ago`;
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} min ago`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)} h ago`;
  if (elapsed < 14 * DAY) return `${Math.floor(elapsed / DAY)} d ago`;
  return new Date(then).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** The full local date and time, for a tooltip. */
export function exactTime(iso) {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  return new Date(then).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
}

/** "Today", "Yesterday" or a date: the heading a log entry is filed under. */
export function dayLabel(iso, nowMs) {
  const then = new Date(Date.parse(iso));
  if (Number.isNaN(then.getTime())) return 'Undated';
  const startOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((startOfDay(new Date(nowMs)) - startOfDay(then)) / DAY);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return then.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
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
    return { ok: false, message: 'This is not an MCUboot image. Choose the *.signed.bin file from the build.' };
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

/** Free text as the API takes it: on one line, without control characters. */
export function singleLine(text) {
  return String(text ?? '').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim();
}

/** The name recorded for an upload: the file's name in the characters the API accepts. */
export function recordedFilename(name) {
  const cleaned = String(name ?? '').replace(/[^A-Za-z0-9._-]/g, '_').slice(-64);
  return cleaned || 'image.signed.bin';
}

/**
 * What can be said about a chosen file before it is uploaded. `blocked` is set only
 * when sending it would be pointless; everything else is left for the server to decide.
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

  const version = parseVersion(header.version);
  const releases = firmware?.releases ?? [];
  const same = releases.find((release) => release.sha256 === digest);
  const taken = releases.find((release) => release.version === header.version);
  const highest = releases.reduce((top, release) => {
    const parsed = parseVersion(release.version);
    return parsed && (!top || compareVersions(parsed, top) > 0) ? parsed : top;
  }, null);

  if (!version || header.version === '0.0.0+0') {
    notes.push({ tone: 'warn', text: 'Version 0.0.0+0 is never accepted. Give the build a version first.' });
  } else if (same) {
    notes.push({ tone: 'warn', text: `This exact file is already registered as ${same.version}.` });
  } else if (taken) {
    notes.push({ tone: 'warn', text: `${taken.version} is already registered with different contents. A version can be used once.` });
  } else if (highest && compareVersions(version, highest) <= 0) {
    notes.push({
      tone: 'warn',
      text: `Not newer than ${formatVersion(highest)}, the highest version registered so far. The server will refuse it.`,
    });
  } else if (highest) {
    notes.push({ tone: 'good', text: `Newer than every registered release (highest so far: ${formatVersion(highest)}).` });
  } else {
    notes.push({ tone: 'good', text: 'This will be the first release.' });
  }
  return { blocked, notes };
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
    certificates: list(reply.certificates).filter((id) => typeof id === 'string').map((id) => boardText(id, 64)),
    executions: list(reply.executions).map(readExecutionSummary),
  };
}

function readRelease(raw) {
  const item = record(raw);
  const revoked = item.revoked && typeof item.revoked === 'object'
    ? { by: person(item.revoked.by), at: instant(item.revoked.at), reason: text(item.revoked.reason, 200) }
    : null;
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
    things: Array.isArray(item.things) ? item.things.filter((thing) => typeof thing === 'string').map((thing) => text(thing, 64)) : [],
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
    running: versionOrNull(item.running),
    online: item.online === true,
    queuedAt: instant(item.queuedAt),
    startedAt: instant(item.startedAt),
    lastUpdatedAt: instant(item.lastUpdatedAt),
    secondsLeft: whole(item.secondsLeft, 0, 10 ** 7),
  };
}

function readDeployment(raw) {
  const summary = readDeploymentSummary(raw);
  return { ...summary, executions: list(raw.executions).map(readExecution).filter((execution) => execution.thing !== '') };
}

function readDeployments(body) {
  return list(record(body).deployments).map(readDeploymentSummary).filter((deployment) => deployment.id !== '');
}

function readAuditEntry(raw) {
  const item = record(raw);
  const detail = [];
  if (item.detail && typeof item.detail === 'object' && !Array.isArray(item.detail)) {
    for (const [key, value] of Object.entries(item.detail).slice(0, 8)) {
      if (typeof value === 'string' || typeof value === 'number') detail.push([text(key, 24), text(String(value), 120)]);
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
    groups: Array.isArray(reply.groups) ? reply.groups.filter((group) => typeof group === 'string').map((group) => text(group, 64)) : [],
    canWrite: reply.canWrite === true,
  };
}

/** Boards the server named when it refused a deployment because they are busy. */
export function busyBoards(error) {
  if (!(error instanceof ApiError) || !Array.isArray(error.details)) return [];
  return error.details
    .filter((entry) => entry && isThing(entry.thing))
    .map((entry) => ({ thing: entry.thing, deployment: isDeploymentId(entry.deployment) ? entry.deployment : null }));
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
  if (!/^https?:\/\/[^/?#\s]+$/.test(config.loginOrigin) || !/^https?:\/\/[^?#\s]+$/.test(config.redirectUri)) {
    return null;
  }
  return config;
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
export function createAuth({ config, storage, location, history, fetch, crypto, now = () => Date.now() }) {
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
        return { status: 'signed-out', reason: 'login-error', message: OAUTH_ERROR.test(failure) ? failure : '' };
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

  /** Forget the session here, then end it at the login pages too. */
  function signOut() {
    storage.clear();
    storage.setItem(SIGNED_OUT_KEY, '1');
    location.assign(`${config.loginOrigin}/logout?${form({
      client_id: config.clientId,
      logout_uri: config.redirectUri,
    })}`);
  }

  return {
    resume,
    signIn,
    signOut,
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
        throw error?.name === 'TimeoutError'
          ? new ApiError(0, 'timeout', 'The server did not answer in time.')
          : new ApiError(0, 'network', 'The server could not be reached. Check the connection.');
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
        if (event.lengthComputable && event.total > 0) onProgress({ stage: 'sending', sent: event.loaded / event.total });
      };
      xhr.upload.onload = () => onProgress({ stage: 'checking', sent: 1 });
      xhr.onload = () => resolve({ status: xhr.status, text: xhr.responseText, date: xhr.getResponseHeader('date') });
      xhr.onerror = () => reject(new ApiError(0, 'network', 'The server could not be reached. Check the connection.'));
      xhr.ontimeout = () => reject(new ApiError(0, 'timeout', 'The server did not answer in time.'));
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
      const body = { version: checked(isVersion, version), things: things.map((thing) => checked(isThing, thing)) };
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
// and every 10 s while one is still waiting, and not at all once nothing is in flight.

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

/** The execution status a deployment summary amounts to, for pollInterval. */
export function summaryActivity(deployment) {
  if (deployment.counts.inProgress > 0) return 'IN_PROGRESS';
  return deployment.counts.queued > 0 ? 'QUEUED' : null;
}

/** The same for a board, judged by what it last reported. An offline board is not waited on. */
export function deviceActivity(device) {
  if (!device.online || !device.ota || device.ota.state === 'idle') return null;
  return device.ota.state === 'awaiting_user' ? 'QUEUED' : 'IN_PROGRESS';
}

export function isUnfinished(status) {
  return status === 'QUEUED' || status === 'IN_PROGRESS';
}

// Words. What a board is doing, said the way one would say it to a teammate. Each
// description also names a tone (wait, live, good, warn, bad, idle) and an icon, so
// that no state is told apart by colour alone.

export const STEPS = ['Offered', 'Approved on the board', 'Downloading', 'Verified', 'Restarting', 'Testing', 'Confirmed'];

const REFUSALS = {
  not_newer: 'the board already runs this version or a newer one',
  too_large: 'the image is larger than the board’s update slot',
  bad_document: 'the board could not read the update instructions',
  unsupported: 'the board does not support this kind of update',
  url_not_allowed: 'the download address is not one the board accepts',
};

// `at` is the step that failed, where the board says enough to tell.
const FAILURES = {
  download_failed: { at: 2, title: 'The download failed', text: 'The board could not download the image.' },
  digest_mismatch: {
    at: 3,
    title: 'The download was damaged',
    text: 'What the board downloaded did not match the SHA-256 digest of the release, so the board discarded it.',
  },
  header_mismatch: {
    at: 3,
    title: 'Not the announced version',
    text: 'The image the board downloaded does not carry the version that was announced, so the board discarded it.',
  },
  flash_error: { at: null, title: 'The board could not store the update', text: 'Writing to the board’s flash memory failed.' },
  interrupted: { at: null, title: 'Interrupted', text: 'The board restarted before the update was complete.' },
  not_installed: {
    at: 4,
    title: 'Not installed',
    text: 'The board restarted, but the bootloader did not start the new image. It turns away an image with a wrong signature or an older version.',
  },
};

function steps(done, { current = null, failed = null, ended = false } = {}) {
  return STEPS.map((label, index) => {
    let state = 'upcoming';
    if (index < done) state = 'done';
    else if (index === failed) state = 'failed';
    else if (index === current) state = 'current';
    else if (ended) state = 'skipped';
    return { label, state };
  });
}

function firstSentence(text) {
  const end = text.indexOf('. ');
  return end === -1 ? text : text.slice(0, end + 1);
}

/**
 * Describe one board's part in a deployment.
 *
 * @returns {{tone: string, icon: string, title: string, text: string, brief: string,
 *   steps: Array, progress: number|null, code: string|null}} `brief` is the first
 *   sentence of `text`; `code` is the board's own reason when the console has no words
 *   for it.
 */
export function describeExecution(execution) {
  const { phase, reason, running, online, progress, startedAt } = execution;
  const reports = running ? ` The board reports that it runs ${running}.` : '';
  const kept = ' It keeps running the firmware it had.';
  const describe = (tone, icon, title, text, timeline, extra = {}) =>
    ({ tone, icon, title, text, brief: firstSentence(text), steps: timeline, progress: null, code: null, ...extra });

  switch (phase) {
    case 'waiting_for_device':
      return online
        ? describe('wait', 'clock', 'Not picked up yet',
          'The board is online but has not picked up the offer yet. That normally takes a few seconds.',
          steps(0, { current: 0 }))
        : describe('wait', 'offline', 'Board offline',
          'The board is offline; it will see this update when it reconnects.',
          steps(0, { current: 0 }));
    case 'waiting_for_button':
      return describe('wait', 'press', 'Waiting for Button 1',
        'Waiting for someone to press Button 1 on the board. LED1 blinks quickly while the offer is open, and Button 2 declines it.',
        steps(1, { current: 1 }));
    case 'downloading':
      return describe('live', 'download', progress === null ? 'Downloading' : `Downloading ${progress}%`,
        'The board is downloading the image into its spare flash slot. The firmware it runs is not touched yet.',
        steps(2, { current: 2 }), { progress: progress ?? 0 });
    case 'verifying':
      return describe('live', 'shield', 'Checking the download',
        'The board is checking the size, the SHA-256 digest and the version in the signed header before it installs anything.',
        steps(3, { current: 3 }));
    case 'rebooting':
      return describe('live', 'restart', 'Restarting',
        'The board is restarting. The bootloader checks the signature before it starts the new firmware.',
        steps(4, { current: 4 }));
    case 'testing':
      return describe('live', 'pulse', 'On trial',
        'The new firmware is running on trial. It is kept once the board has reconnected to AWS IoT; if it cannot, the bootloader puts the previous firmware back.',
        steps(5, { current: 5 }));
    case 'succeeded':
      return describe('good', 'check-circle', 'Installed and confirmed',
        running ? `The board runs ${running} and has confirmed it.` : 'The board has confirmed the new firmware.',
        steps(STEPS.length));
    case 'rolled_back':
      return describe('bad', 'undo', 'Rolled back',
        `The bootloader put the previous firmware back. The new firmware started but did not reconnect to AWS IoT, so it was never confirmed.${reports}`,
        steps(5, { failed: 5, ended: true }));
    case 'declined':
      return describe('warn', 'minus-circle', 'Declined on the board',
        `Someone pressed Button 2 on the board to decline this update. Nothing was installed.${reports}`,
        steps(1, { failed: 1, ended: true }));
    case 'refused': {
      const why = REFUSALS[reason];
      return describe('warn', 'ban', 'Refused by the board',
        `${why ? `Refused: ${why}.` : 'The board refused this update before installing anything.'}${reports}`,
        steps(1, { failed: 1, ended: true }), { code: why ? null : reason });
    }
    case 'failed': {
      const failure = FAILURES[reason];
      if (failure) {
        const done = failure.at ?? 2;
        return describe('bad', 'x-circle', failure.title, `${failure.text}${kept}${reports}`,
          steps(done, { failed: failure.at, ended: true }));
      }
      const why = REFUSALS[reason];
      return describe('bad', 'x-circle', 'Failed',
        `${why ? `The board stopped: ${why}.` : 'The board reported that the update failed.'}${kept}${reports}`,
        steps(2, { ended: true }), { code: why ? null : reason });
    }
    case 'cancelled':
      return startedAt
        ? describe('idle', 'stop', 'Cancelled',
          `Cancelled after the board had started. A board asks AWS before it installs, so a cancelled update is not installed.${reports}`,
          steps(2, { ended: true }))
        : describe('idle', 'stop', 'Cancelled', `Cancelled before the board started. Nothing was installed.${reports}`,
          steps(0, { ended: true }));
    case 'timed_out':
      return describe('bad', 'hourglass', 'Timed out',
        `The board started but did not report a result before the time limit.${reports}`,
        steps(2, { ended: true }));
    case 'removed':
      return describe('idle', 'minus', 'Removed', 'This board was taken out of the deployment.', steps(0, { ended: true }));
    default:
      return describe('idle', 'minus', 'Unknown state', 'The server reported a state this console does not know.',
        steps(0), { code: phase || null });
  }
}

/** The words for an execution status alone, where no phase is known (a board's history). */
export function describeStatus(status) {
  switch (status) {
    case 'QUEUED': return { tone: 'wait', icon: 'clock', label: 'Waiting' };
    case 'IN_PROGRESS': return { tone: 'live', icon: 'restart', label: 'Installing' };
    case 'SUCCEEDED': return { tone: 'good', icon: 'check-circle', label: 'Installed' };
    case 'FAILED': return { tone: 'bad', icon: 'x-circle', label: 'Failed' };
    case 'TIMED_OUT': return { tone: 'bad', icon: 'hourglass', label: 'Timed out' };
    case 'REJECTED': return { tone: 'warn', icon: 'ban', label: 'Refused or declined' };
    case 'REMOVED': return { tone: 'idle', icon: 'minus', label: 'Removed' };
    case 'CANCELED': return { tone: 'idle', icon: 'stop', label: 'Cancelled' };
    default: return { tone: 'idle', icon: 'minus', label: 'Unknown' };
  }
}

const LAST_UPDATE = {
  none: { tone: 'idle', icon: 'minus', title: 'No update in progress' },
  succeeded: { tone: 'good', icon: 'check-circle', title: 'Last update succeeded' },
  failed: { tone: 'bad', icon: 'x-circle', title: 'Last update failed' },
  rolled_back: { tone: 'bad', icon: 'undo', title: 'Last update was rolled back' },
  declined: { tone: 'warn', icon: 'minus-circle', title: 'Last update was declined on the board' },
  refused: { tone: 'warn', icon: 'ban', title: 'Last update was refused by the board' },
  cancelled: { tone: 'idle', icon: 'stop', title: 'Last update was cancelled' },
};

/**
 * Describe what a board last said about updates. `deployment` and `version` name the
 * update it is working on, if any. An offline board's words are old news, and say so.
 */
export function describeUpdate(device) {
  const { ota, online } = device;
  if (!ota) return { tone: 'idle', icon: 'minus', title: 'Nothing reported', text: '', progress: null, deployment: null };

  const version = versionOfDeployment(ota.job);
  const target = version ?? 'an update';
  const live = (tone, icon, title, text, progress = null) => ({
    tone: online ? tone : 'idle',
    icon,
    title: online ? title : `Was ${title.charAt(0).toLowerCase()}${title.slice(1)} when last seen`,
    text: online ? text : '',
    progress: online ? progress : null,
    deployment: ota.job,
  });

  switch (ota.state) {
    case 'idle': {
      const last = LAST_UPDATE[ota.last] ?? LAST_UPDATE.none;
      const known = FAILURES[ota.error]?.title ?? (REFUSALS[ota.error] ? `Because ${REFUSALS[ota.error]}.` : '');
      const noted = ota.last === 'failed' || ota.last === 'refused' ? known : '';
      return { ...last, text: noted, progress: null, deployment: null };
    }
    case 'awaiting_user':
      return live('wait', 'press', 'Waiting for Button 1',
        `${version ?? 'An update'} is on offer. Button 1 on the board installs it, Button 2 declines.`);
    case 'downloading':
      return live('live', 'download', `Downloading ${target}`, '', ota.progress);
    case 'verifying':
      return live('live', 'shield', `Checking the download of ${target}`, '');
    case 'rebooting':
      return live('live', 'restart', `Restarting into ${target}`, '');
    case 'testing':
      return live('live', 'pulse', `Testing ${target}`, 'On trial until the board has reconnected.');
    default:
      return live('live', 'restart', 'Updating', '');
  }
}

/** The badge for a deployment as a whole. */
export function describeDeployment(deployment) {
  const { status, counts, things } = deployment;
  const total = things.length || COUNTS.reduce((sum, name) => sum + counts[name], 0);
  switch (status) {
    case 'IN_PROGRESS':
      return counts.inProgress > 0
        ? { tone: 'live', icon: 'restart', label: 'Installing' }
        : { tone: 'wait', icon: 'clock', label: 'Waiting for boards' };
    case 'COMPLETED':
      if (total > 0 && counts.succeeded === total) return { tone: 'good', icon: 'check-circle', label: 'Succeeded' };
      if (counts.succeeded > 0) return { tone: 'warn', icon: 'alert', label: 'Partly succeeded' };
      if (counts.failed + counts.timedOut > 0) return { tone: 'bad', icon: 'x-circle', label: 'Failed' };
      return { tone: 'idle', icon: 'minus-circle', label: 'Not installed' };
    case 'CANCELED': return { tone: 'idle', icon: 'stop', label: 'Cancelled' };
    case 'SCHEDULED': return { tone: 'wait', icon: 'clock', label: 'Scheduled' };
    case 'DELETION_IN_PROGRESS': return { tone: 'idle', icon: 'minus', label: 'Being deleted' };
    default: return { tone: 'idle', icon: 'minus', label: 'Unknown' };
  }
}

const COUNT_WORDS = [
  ['succeeded', 'succeeded', 'good', 'check-circle'],
  ['inProgress', 'installing', 'live', 'restart'],
  ['queued', 'waiting', 'wait', 'clock'],
  ['failed', 'failed', 'bad', 'x-circle'],
  ['timedOut', 'timed out', 'bad', 'hourglass'],
  ['rejected', 'refused or declined', 'warn', 'ban'],
  ['canceled', 'cancelled', 'idle', 'stop'],
  ['removed', 'removed', 'idle', 'minus'],
];

/** The non-zero board counts of a deployment, in a fixed order, with their words. */
export function describeCounts(counts) {
  return COUNT_WORDS
    .filter(([name]) => counts[name] > 0)
    .map(([name, label, tone, icon]) => ({ name, count: counts[name], label, tone, icon }));
}

const AUDIT_ACTIONS = {
  'firmware.upload': { done: 'uploaded firmware', tried: 'tried to upload', icon: 'upload' },
  'firmware.revoke': { done: 'revoked firmware', tried: 'tried to revoke firmware', icon: 'ban' },
  'deployment.create': { done: 'started deployment', tried: 'tried to deploy', icon: 'send' },
  'deployment.cancel': { done: 'cancelled deployment', tried: 'tried to cancel deployment', icon: 'stop' },
};

const AUDIT_OUTCOMES = {
  rejected: { tone: 'warn', icon: 'ban', label: 'Refused' },
  denied: { tone: 'bad', icon: 'lock', label: 'Not allowed' },
  error: { tone: 'bad', icon: 'alert', label: 'Server error' },
};

/** One line of the activity log: what was done, and how it ended if not well. */
export function describeAudit(entry) {
  const action = AUDIT_ACTIONS[entry.action];
  const ok = entry.outcome === 'ok';
  return {
    icon: action?.icon ?? 'list',
    verb: action ? (ok ? action.done : action.tried) : entry.action || 'did something',
    outcome: ok ? null : AUDIT_OUTCOMES[entry.outcome] ?? { tone: 'idle', icon: 'minus', label: entry.outcome || 'Unknown' },
    href: deploymentHref(entry.target) ?? (isVersion(entry.target) ? '#/firmware' : null),
  };
}
