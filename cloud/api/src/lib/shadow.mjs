/**
 * Reading a board's shadow.
 *
 * The board writes its state under state.reported:
 *
 *   { "fw":   { "version": "1.0.0+3", "confirmed": true },
 *     "ota":  { "state": "idle", "job": null, "progress": 0, "last": "none", "error": "" },
 *     "wifi": { "rssi": -52 },
 *     "uptime": 1234 }
 *
 * All of it comes from outside the trust boundary. Each field is checked on its own
 * and dropped if it is not exactly what the contract allows; nothing is repaired and
 * nothing is passed through. What the console shows from here is for display only: no
 * decision of the server depends on it.
 *
 * A board is online if AWS IoT received its uptime less than 150 s ago. That time is
 * set by AWS (metadata.reported.uptime.timestamp, in epoch seconds), not by the board.
 */

import { parseJobId, strictVersion } from './validate.mjs';

export const ONLINE_WINDOW_MS = 150_000;

const OTA_STATES = Object.freeze(
  ['idle', 'awaiting_user', 'downloading', 'verifying', 'rebooting', 'testing']);
const OTA_RESULTS = Object.freeze(
  ['none', 'succeeded', 'failed', 'rolled_back', 'declined', 'refused', 'cancelled']);
const SHORT_ASCII = /^[\x20-\x7e]{0,64}$/;
// Later than any real timestamp, small enough to stay a valid date in milliseconds.
const MAX_EPOCH_SEC = 99_999_999_999;

/** An own property of a plain object, or undefined. */
function own(value, key) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, key)
    ? value[key]
    : undefined;
}

function integerIn(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max ? value : null;
}

function oneOf(value, allowed) {
  return typeof value === 'string' && allowed.includes(value) ? value : null;
}

/** The Device for a thing that has never reported. */
export function unknownDevice(thing) {
  return { thing, online: false, lastSeen: null, fw: null, ota: null, rssi: null, uptime: null };
}

/**
 * Turn a raw shadow document into a Device.
 *
 * @param {string} thing    the thing name, already validated
 * @param {unknown} shadow  the document from GetThingShadow, or null if there is none
 * @param {number} nowMs    the current time in epoch milliseconds
 */
export function deviceFromShadow(thing, shadow, nowMs) {
  const device = unknownDevice(thing);
  const reported = own(own(shadow, 'state'), 'reported');
  if (reported === undefined) return device;

  const seenSec = own(own(own(own(shadow, 'metadata'), 'reported'), 'uptime'), 'timestamp');
  if (Number.isInteger(seenSec) && seenSec > 0 && seenSec <= MAX_EPOCH_SEC) {
    const seenMs = seenSec * 1000;
    device.lastSeen = new Date(seenMs).toISOString();
    device.online = nowMs - seenMs < ONLINE_WINDOW_MS;
  }

  const fw = own(reported, 'fw');
  const version = strictVersion(own(fw, 'version'));
  if (version !== null) {
    device.fw = { version: version.text, confirmed: own(fw, 'confirmed') === true };
  }

  const ota = own(reported, 'ota');
  const state = oneOf(own(ota, 'state'), OTA_STATES);
  if (state !== null) {
    const error = own(ota, 'error');
    device.ota = {
      state,
      // AWS deletes a key whose value is null, so no job is the usual case.
      job: parseJobId(own(ota, 'job'))?.id ?? null,
      progress: integerIn(own(ota, 'progress'), 0, 100) ?? 0,
      last: oneOf(own(ota, 'last'), OTA_RESULTS) ?? 'none',
      error: typeof error === 'string' && SHORT_ASCII.test(error) ? error : '',
    };
  }

  device.rssi = integerIn(own(own(reported, 'wifi'), 'rssi'), -127, 0);
  device.uptime = integerIn(own(reported, 'uptime'), 0, 2 ** 32);
  return device;
}
