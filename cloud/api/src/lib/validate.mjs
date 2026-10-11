/**
 * The input grammar of the console API.
 *
 * Everything that arrives in a path, a query string or a body passes through one of
 * these functions before it is used. A value that does not match is refused with 400;
 * a value that matches is rebuilt from its parsed parts, so that only one spelling of
 * it ever reaches AWS or the database.
 */

import { badRequest } from '../http.mjs';
import { formatVersion, parseVersion } from './mcuboot.mjs';

// "major.minor.revision+build", the build number always present.
const VERSION = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,4})\+(0|[1-9]\d{0,9})$/;
const THING = /^cranium-[0-9a-f]{16}$/;
const JOB_ID = /^cranium-(\d{1,3})-(\d{1,3})-(\d{1,5})-b(\d{1,10})-(\d{8}T\d{6}Z)-[0-9a-f]{4}$/;
const FILENAME = /^[A-Za-z0-9._-]{1,64}$/;

// Control and format characters, unpaired surrogates, private-use and unassigned code
// points, and the two Unicode line separators. None of them belongs in a one-line note.
const CONTROL = /[\p{C}\p{Zl}\p{Zp}]/u;

export const MAX_THINGS = 25;
export const MAX_NOTES = 500;
export const MAX_NOTE = 200;
export const MAX_REASON = 200;
export const MAX_AUDIT_PAGE = 100;
export const DEFAULT_AUDIT_PAGE = 50;

/**
 * Parse a version in the strict form of the API. Returns { text, parts } with the
 * canonical text, or null.
 */
export function strictVersion(value) {
  if (typeof value !== 'string' || !VERSION.test(value)) return null;
  const parts = parseVersion(value);
  if (parts === null) return null;
  return { text: formatVersion(parts), parts };
}

export function isThing(value) {
  return typeof value === 'string' && THING.test(value);
}

/**
 * Parse a deployment (job) id. Returns the version it names, or null when the text is
 * not a deployment id of this console.
 */
export function parseJobId(value) {
  if (typeof value !== 'string') return null;
  const match = JOB_ID.exec(value);
  if (!match) return null;
  const parts = {
    major: Number(match[1]),
    minor: Number(match[2]),
    revision: Number(match[3]),
    build: Number(match[4]),
  };
  if (parts.major > 0xff || parts.minor > 0xff || parts.revision > 0xffff || parts.build > 0xffffffff) {
    return null;
  }
  return { id: value, version: formatVersion(parts), parts };
}

export function requireVersion(value) {
  const version = strictVersion(value);
  if (version === null) {
    throw badRequest('invalid_version', 'A version looks like 1.2.3+4: major.minor.revision+build.');
  }
  return version;
}

export function requireThing(value) {
  if (!isThing(value)) {
    throw badRequest('invalid_thing', 'A board name is "cranium-" followed by 16 lowercase hex digits.');
  }
  return value;
}

export function requireJobId(value) {
  const job = parseJobId(value);
  if (job === null) throw badRequest('invalid_deployment', 'That is not a deployment id.');
  return job;
}

export function requireFilename(value) {
  if (typeof value !== 'string' || !FILENAME.test(value)) {
    throw badRequest('invalid_filename',
      'The file name may contain letters, digits, dots, dashes and underscores, 64 characters at most.');
  }
  return value;
}

/**
 * A line of free text: a string, trimmed, without control characters, between min and
 * max characters long. An absent optional field is the empty string.
 */
export function requireText(value, name, { min = 0, max }) {
  if (value === undefined && min === 0) return '';
  if (typeof value !== 'string') {
    throw badRequest(`invalid_${name}`, `"${name}" must be text.`);
  }
  const text = value.trim();
  if (CONTROL.test(text)) {
    throw badRequest(`invalid_${name}`, `"${name}" must be one line of plain text without control characters.`);
  }
  if (text.length < min) {
    throw badRequest(`invalid_${name}`, `"${name}" is required.`);
  }
  if (text.length > max) {
    throw badRequest(`invalid_${name}`, `"${name}" may be at most ${max} characters long.`);
  }
  return text;
}

/** 1 to 25 board names, no name twice. Returned sorted. */
export function requireThings(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_THINGS) {
    throw badRequest('invalid_things', `Choose between 1 and ${MAX_THINGS} boards.`);
  }
  const seen = new Set();
  for (const thing of value) {
    if (!isThing(thing)) {
      throw badRequest('invalid_things', 'A board name is "cranium-" followed by 16 lowercase hex digits.');
    }
    if (seen.has(thing)) {
      throw badRequest('invalid_things', `${thing} is listed twice.`);
    }
    seen.add(thing);
  }
  return [...seen].sort();
}

export function requireBoolean(value, name, fallback) {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'boolean') {
    throw badRequest(`invalid_${name}`, `"${name}" must be true or false.`);
  }
  return value;
}

/**
 * Decode base64 that must be canonical: the bytes encode back to exactly the text that
 * was sent, so there is one accepted spelling of every upload.
 */
export function requireBase64(value, name) {
  if (typeof value !== 'string' || value === '') {
    throw badRequest(`invalid_${name}`, `"${name}" must be the file, base64 encoded.`);
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) {
    throw badRequest(`invalid_${name}`, `"${name}" is not valid base64.`);
  }
  return bytes;
}

/** The page size of the activity log: 1 to 100, 50 when absent. */
export function requirePageSize(value) {
  if (value === undefined) return DEFAULT_AUDIT_PAGE;
  if (typeof value !== 'string' || !/^[1-9]\d{0,2}$/.test(value) || Number(value) > MAX_AUDIT_PAGE) {
    throw badRequest('invalid_limit', `"limit" must be a number from 1 to ${MAX_AUDIT_PAGE}.`);
  }
  return Number(value);
}
