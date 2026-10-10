/**
 * Firmware releases: list, upload, look up and revoke.
 *
 * A release exists only for an image that this server has verified itself: a
 * well-formed MCUboot image, built for this product's flash layout, whose SHA-256 and
 * ECDSA P-256 signature check out against the project's public key. The version is
 * read from the signed header and from nowhere else.
 *
 * Releases are stored under pk "REL" with the version as a zero-padded sort key
 * (MMM.mmm.rrrrr.bbbbbbbbbb), so that string order is version order. A pointer item
 * remembers the highest version ever registered. A new release must be newer than
 * that, including releases that were revoked since: versions only go up, which is what
 * lets a board refuse anything that is not newer than what it runs.
 *
 * The image itself is stored once, under the SHA-256 of the file, and never
 * overwritten. Revoking a release tags that object; the bucket policy then refuses
 * every download of it, including through URLs that were already handed out.
 */

import { HttpError, conflict, describeError, field, notFound, unprocessable } from '../http.mjs';
import { ImageError, compareVersions, formatVersion, validateImage } from '../lib/mcuboot.mjs';
import {
  MAX_NOTES, MAX_REASON, requireBase64, requireFilename, requireText, requireVersion, strictVersion,
} from '../lib/validate.mjs';

// Enough for an image that fills the slot, base64 encoded, with its notes.
export const UPLOAD_BODY_LIMIT = 1_400_000;

const HEX64 = /^[0-9a-f]{64}$/;
const SORT_KEY = /^(\d{3})\.(\d{3})\.(\d{5})\.(\d{10})$/;

/** The sort key of a version: fixed-width fields, so that text order is version order. */
export function releaseKey(parts) {
  const pad = (value, width) => String(value).padStart(width, '0');
  return `${pad(parts.major, 3)}.${pad(parts.minor, 3)}.${pad(parts.revision, 5)}.${pad(parts.build, 10)}`;
}

/** The version a sort key stands for, or null. */
export function versionOfKey(sortKey) {
  const match = typeof sortKey === 'string' ? SORT_KEY.exec(sortKey) : null;
  if (!match) return null;
  return formatVersion({
    major: Number(match[1]), minor: Number(match[2]), revision: Number(match[3]), build: Number(match[4]),
  });
}

/** The S3 key of an image, from the SHA-256 of the file. */
export function objectKey(sha256) {
  if (typeof sha256 !== 'string' || !HEX64.test(sha256)) throw new TypeError('Not a SHA-256 digest');
  return `firmware/${sha256}.bin`;
}

/**
 * The version named in a path. A "+" in a URL is read as a space by anything that
 * decodes it the way a form is decoded; a version has no other use for a space, so
 * one is taken for the plus sign it stood for. The result is validated like any other.
 */
function versionInPath(segment) {
  return requireVersion(typeof segment === 'string' ? segment.replaceAll(' ', '+') : segment);
}

function text(value, max) {
  return typeof value === 'string' && value.length <= max ? value : '';
}

function count(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function person(value) {
  return { sub: text(value?.sub, 128), email: text(value?.email, 320) };
}

/**
 * Turn a stored item into a Release, or null if it is not one. A release whose status
 * is not exactly "active" is treated as revoked.
 */
export function releaseFromItem(item) {
  if (item === null || typeof item !== 'object') return null;
  const version = strictVersion(item.version);
  if (version === null || typeof item.sha256 !== 'string' || !HEX64.test(item.sha256)) return null;
  if (!Number.isInteger(item.size) || item.size <= 0) return null;
  const uploadedAt = text(item.uploadedAt, 40);
  const active = item.status === 'active';
  return {
    version: version.text,
    size: item.size,
    sha256: item.sha256,
    imageHash: text(item.imageHash, 64),
    keyHash: text(item.keyHash, 64),
    payloadSize: count(item.payloadSize),
    headerSize: count(item.headerSize),
    loadAddress: count(item.loadAddress),
    filename: text(item.filename, 64),
    notes: text(item.notes, MAX_NOTES),
    uploadedBy: person(item.uploadedBy),
    uploadedAt,
    status: active ? 'active' : 'revoked',
    revoked: active ? null : {
      by: person(item.revoked?.by),
      at: text(item.revoked?.at, 40) || uploadedAt,
      reason: text(item.revoked?.reason, MAX_REASON),
    },
  };
}

export function createFirmwareHandlers({ aws, config, now, log }, { deployments }) {
  async function findRelease(version) {
    return releaseFromItem(await aws.getRelease(releaseKey(version.parts)));
  }

  return {
    async list() {
      const releases = (await aws.listReleases())
        .map(releaseFromItem)
        .filter((release) => release !== null)
        .sort((a, b) => compareVersions(strictVersion(b.version).parts, strictVersion(a.version).parts));
      return {
        body: {
          releases,
          signingKey: { fingerprint: config.signingKeyFingerprint },
          slotSize: config.slotSize,
        },
      };
    },

    async get({ params }) {
      const version = versionInPath(params.version);
      const release = await findRelease(version);
      if (release === null) throw notFound('unknown_version', `There is no release ${version.text}.`);
      return { body: { release } };
    },

    async upload({ actor, json, entry }) {
      const body = json();
      const filename = requireFilename(field(body, 'filename'));
      entry.target = filename;
      entry.detail.filename = filename;
      const notes = requireText(field(body, 'notes'), 'notes', { max: MAX_NOTES });
      const image = requireBase64(field(body, 'data'), 'data');

      let info;
      try {
        info = validateImage(image, config.signingKey,
          { maxSize: config.slotSize, loadAddress: config.loadAddress });
      } catch (error) {
        if (error instanceof ImageError) throw unprocessable(error.code, error.message);
        throw error;
      }
      // From here on the version is known, and it comes from the signed header only.
      entry.target = info.version;
      entry.detail.sha256 = info.sha256;
      entry.detail.size = String(info.size);
      if (info.version === '0.0.0+0') {
        throw unprocessable('version_zero',
          'The image has version 0.0.0+0. Set a version when you build the firmware.');
      }

      // Stored under its own digest and never replaced. If the key is taken, the same
      // bytes are already there.
      await aws.putFirmwareObject({
        key: objectKey(info.sha256),
        body: image,
        sha256Base64: Buffer.from(info.sha256, 'hex').toString('base64'),
      });

      const release = {
        version: info.version,
        size: info.size,
        sha256: info.sha256,
        imageHash: info.imageHash,
        keyHash: info.keyHash,
        payloadSize: info.payloadSize,
        headerSize: info.headerSize,
        loadAddress: info.loadAddress,
        filename,
        notes,
        uploadedBy: { sub: actor.sub, email: actor.email },
        uploadedAt: new Date(now()).toISOString(),
        status: 'active',
        revoked: null,
      };
      const registered = await aws.registerRelease({ sk: releaseKey(info.versionParts), release });
      if (!registered.ok) {
        if (registered.reason === 'exists') {
          throw conflict('version_exists',
            `Release ${info.version} already exists. A version is registered once and never replaced.`);
        }
        if (registered.reason === 'not_newer') {
          const highest = versionOfKey(registered.highest);
          throw unprocessable('version_not_newer', highest === null
            ? `Version ${info.version} is not newer than the releases that already exist.`
            : `Version ${info.version} is not newer than ${highest}, the highest version ever registered. ` +
              'Versions only go up, revoked releases included.');
        }
        throw conflict('upload_conflict', 'Another upload was being registered at the same moment. Try again.');
      }
      return { status: 201, body: { release } };
    },

    async revoke({ actor, params, json, entry }) {
      const version = versionInPath(params.version);
      entry.target = version.text;
      const reason = requireText(field(json(), 'reason'), 'reason', { min: 1, max: MAX_REASON });

      const existing = await findRelease(version);
      if (existing === null) throw notFound('unknown_version', `There is no release ${version.text}.`);

      // 1. The record: from here on no new deployment of this release can be created.
      const revoked = { by: { sub: actor.sub, email: actor.email }, at: new Date(now()).toISOString(), reason };
      const marked = await aws.markReleaseRevoked({ sk: releaseKey(version.parts), revoked });
      if (marked.ok) entry.detail.reason = reason;

      // 2. and 3. are repeated even if the record was revoked before, so that a
      // revocation that was interrupted half way can be completed by asking again.
      const incomplete = [];

      // 2. The image: the bucket refuses to serve a tagged object, whatever URL is used.
      try {
        const tagged = await aws.tagFirmwareRevoked(objectKey(existing.sha256));
        if (!tagged.ok) log({ level: 'warn', event: 'revoked_image_missing', version: version.text });
      } catch (error) {
        incomplete.push('tag');
        log({ level: 'error', event: 'revoke_tag_failed', version: version.text, error: describeError(error) });
      }

      // 3. The deployments: boards that have not installed it yet stop before they do.
      let cancelled = [];
      try {
        const result = await deployments.cancelUnfinished(version.text, actor.sub);
        cancelled = result.cancelled;
        if (result.failed.length > 0) incomplete.push('cancel');
      } catch (error) {
        incomplete.push('cancel');
        log({ level: 'error', event: 'revoke_cancel_failed', version: version.text, error: describeError(error) });
      }
      entry.detail.cancelled = String(cancelled.length);

      if (incomplete.length > 0) {
        throw new HttpError(500, 'revoke_incomplete',
          `Release ${version.text} is marked revoked, but not every step after that completed. Revoke it again to finish.`);
      }
      if (!marked.ok) {
        throw conflict('already_revoked', `Release ${version.text} is already revoked.`);
      }
      const release = releaseFromItem(marked.release) ?? { ...existing, status: 'revoked', revoked };
      return { body: { release, cancelled } };
    },
  };
}
