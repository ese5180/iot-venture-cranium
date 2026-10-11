/**
 * The activity log.
 *
 * Every request that tries to change something leaves exactly one entry, whatever
 * happened to it: who asked (the token's sub, with the e-mail address as it was at
 * that moment), what they asked for, and how it ended. The table is append-only for
 * the API: its role may put and query items, nothing else.
 *
 * Item: pk = "AUD", sk = "<ISO time>#<request id>". Newest first is descending sk.
 * A page cursor is the last sk of the page, base64url encoded.
 */

export const ACTIONS = Object.freeze(
  ['firmware.upload', 'firmware.revoke', 'deployment.create', 'deployment.cancel']);
export const OUTCOMES = Object.freeze(['ok', 'rejected', 'denied', 'error']);

export const REQUEST_ID = /^[A-Za-z0-9+/=_.:-]{1,128}$/;
const SORT_KEY = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z#[A-Za-z0-9+/=_.:-]{1,128}$/;
const DETAIL_KEY = /^[a-z][A-Za-z0-9_]{0,23}$/;
const UNSAFE = /[\p{C}\p{Zl}\p{Zp}]/gu;

const MAX_DETAILS = 8;
const MAX_VALUE = 200;
const MAX_CURSOR = 400;

/** One line of text, at most `max` characters, whatever was passed in. */
function line(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(UNSAFE, '').slice(0, max);
}

function cleanDetail(detail) {
  const clean = {};
  if (detail === null || typeof detail !== 'object' || Array.isArray(detail)) return clean;
  for (const [key, value] of Object.entries(detail)) {
    if (Object.keys(clean).length === MAX_DETAILS) break;
    if (!DETAIL_KEY.test(key)) continue;
    if (typeof value === 'string') clean[key] = line(value, MAX_VALUE);
    else if (typeof value === 'number' || typeof value === 'boolean') clean[key] = String(value);
  }
  return clean;
}

/**
 * Build the item to store for one request.
 *
 * @param {object} entry
 * @param {number} entry.at           epoch milliseconds
 * @param {string} entry.requestId
 * @param {{sub: string, email: string}} entry.actor
 * @param {string} entry.action       one of ACTIONS
 * @param {string} entry.target       version, deployment id or file name
 * @param {string} entry.outcome      one of OUTCOMES
 * @param {object} entry.detail       short keys with short values
 */
export function auditItem({ at, requestId, actor, action, target, outcome, detail }) {
  if (!ACTIONS.includes(action)) throw new TypeError(`Unknown audit action ${String(action)}`);
  if (!OUTCOMES.includes(outcome)) throw new TypeError(`Unknown audit outcome ${String(outcome)}`);
  if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) throw new TypeError('Unusable request id');
  const time = new Date(at).toISOString();
  return {
    sk: `${time}#${requestId}`,
    at: time,
    requestId,
    actor: { sub: line(actor?.sub, 128), email: line(actor?.email, 320) },
    action,
    target: line(target, 128),
    outcome,
    detail: cleanDetail(detail),
  };
}

/** Turn a stored item into an AuditEntry, or null if it is not one. */
export function entryFromItem(item) {
  if (item === null || typeof item !== 'object') return null;
  if (typeof item.sk !== 'string' || !SORT_KEY.test(item.sk)) return null;
  if (!ACTIONS.includes(item.action) || !OUTCOMES.includes(item.outcome)) return null;
  const separator = item.sk.indexOf('#');
  return {
    at: item.sk.slice(0, separator),
    actor: { sub: line(item.actor?.sub, 128), email: line(item.actor?.email, 320) },
    action: item.action,
    target: line(item.target, 128),
    outcome: item.outcome,
    detail: cleanDetail(item.detail),
    requestId: item.sk.slice(separator + 1),
  };
}

export function encodeCursor(sortKey) {
  return Buffer.from(sortKey, 'utf8').toString('base64url');
}

/** The sort key inside a cursor, or null if the text is not a cursor this API made. */
export function decodeCursor(text) {
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_CURSOR) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  const bytes = Buffer.from(text, 'base64url');
  if (bytes.toString('base64url') !== text) return null;
  const sortKey = bytes.toString('utf8');
  return SORT_KEY.test(sortKey) ? sortKey : null;
}
