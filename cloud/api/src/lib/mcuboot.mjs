/**
 * Validation of MCUboot firmware images.
 *
 * The console never signs anything. It holds the project's signing PUBLIC key and
 * accepts an upload only if it is a well-formed MCUboot image whose SHA-256 and ECDSA
 * P-256 signature check out against that key. The device's bootloader repeats the
 * signature check before it runs the image; this check exists so that a wrong or
 * tampered file is refused before it can ever be offered to a device.
 *
 * Image layout (all fields little endian), from MCUboot's bootutil/image.h:
 *
 *   image_header (32 bytes) ... padding up to ih_hdr_size
 *   payload (ih_img_size bytes)
 *   optional protected TLV area (ih_protect_tlv_size bytes, magic 0x6908)
 *   TLV area (magic 0x6907): SHA256, KEYHASH, ECDSA signature
 *
 * The hash and the signature cover everything before the unprotected TLV area.
 *
 * No dependencies: only node:crypto.
 */

import { createHash, createPublicKey, timingSafeEqual, verify } from 'node:crypto';

const IMAGE_MAGIC = 0x96f3b83d;
const TLV_INFO_MAGIC = 0x6907;
const TLV_PROT_INFO_MAGIC = 0x6908;
const HEADER_SIZE = 32;
const TLV_INFO_SIZE = 4;
const TLV_HEADER_SIZE = 4;

const TLV_KEYHASH = 0x01;
const TLV_SHA256 = 0x10;
const TLV_ECDSA_SIG = 0x22;

export const IMAGE_F_ROM_FIXED = 0x00000100;

const FLAG_NAMES = new Map([
  [0x00000001, 'PIC'],
  [0x00000004, 'ENCRYPTED_AES128'],
  [0x00000008, 'ENCRYPTED_AES256'],
  [0x00000010, 'NON_BOOTABLE'],
  [0x00000020, 'RAM_LOAD'],
  [0x00000100, 'ROM_FIXED'],
  [0x00000200, 'COMPRESSED_LZMA1'],
  [0x00000400, 'COMPRESSED_LZMA2'],
  [0x00000800, 'COMPRESSED_ARM_THUMB_FLT'],
]);

/** A reason an image was refused. `code` is stable and safe to show to a user. */
export class ImageError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ImageError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ImageError(code, message);
}

function hex(buffer) {
  return Buffer.from(buffer).toString('hex');
}

/** "major.minor.revision+build", always with the build number. */
export function formatVersion({ major, minor, revision, build }) {
  return `${major}.${minor}.${revision}+${build}`;
}

/**
 * Parse "major.minor.revision" with an optional "+build", exactly as the firmware
 * does. Returns null for anything else.
 */
export function parseVersion(text) {
  if (typeof text !== 'string') return null;
  const match = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,4})(?:\+(0|[1-9]\d{0,9}))?$/.exec(text);
  if (!match) return null;
  const version = {
    major: Number(match[1]),
    minor: Number(match[2]),
    revision: Number(match[3]),
    build: match[4] === undefined ? 0 : Number(match[4]),
  };
  if (version.major > 0xff || version.minor > 0xff || version.revision > 0xffff || version.build > 0xffffffff) {
    return null;
  }
  return version;
}

/** Negative, zero or positive as a is older than, equal to or newer than b. */
export function compareVersions(a, b) {
  for (const field of ['major', 'minor', 'revision', 'build']) {
    if (a[field] !== b[field]) return a[field] < b[field] ? -1 : 1;
  }
  return 0;
}

/**
 * Load the signing public key and return it with the hash MCUboot stores in the
 * image (SHA-256 of the DER SubjectPublicKeyInfo).
 */
export function loadSigningKey(pem) {
  let key;
  try {
    key = createPublicKey(pem);
  } catch {
    fail('bad_signing_key', 'The configured signing public key cannot be read');
  }
  if (key.type !== 'public' || key.asymmetricKeyType !== 'ec' ||
      key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    fail('bad_signing_key', 'The configured signing key is not an ECDSA P-256 public key');
  }
  const der = key.export({ type: 'spki', format: 'der' });
  return { key, keyHash: createHash('sha256').update(der).digest() };
}

function walkTlvs(image, start, end, what) {
  const entries = [];
  let offset = start;
  while (offset < end) {
    if (offset + TLV_HEADER_SIZE > end) {
      fail('malformed_tlv', `The ${what} area ends inside an entry header`);
    }
    const type = image.readUInt16LE(offset);
    const length = image.readUInt16LE(offset + 2);
    const dataStart = offset + TLV_HEADER_SIZE;
    if (dataStart + length > end) {
      fail('malformed_tlv', `An entry in the ${what} area is longer than the area`);
    }
    entries.push({ type, data: image.subarray(dataStart, dataStart + length) });
    offset = dataStart + length;
  }
  return entries;
}

/**
 * MCUboot stores the ECDSA signature as ASN.1 DER. Older imgtool versions padded it
 * with zero bytes to a fixed length; accept that padding and nothing else.
 */
function derSignature(data) {
  if (data.length < 8 || data[0] !== 0x30 || data[1] >= 0x80) {
    fail('bad_signature_encoding', 'The signature is not a DER-encoded ECDSA signature');
  }
  const length = 2 + data[1];
  if (length > data.length) {
    fail('bad_signature_encoding', 'The signature is truncated');
  }
  for (let i = length; i < data.length; i++) {
    if (data[i] !== 0) {
      fail('bad_signature_encoding', 'The signature is followed by unexpected data');
    }
  }
  return data.subarray(0, length);
}

/**
 * Validate an image and return what the console records about it.
 *
 * @param {Buffer} image          the uploaded file, complete
 * @param {{key: import('node:crypto').KeyObject, keyHash: Buffer}} signingKey
 * @param {object} options
 * @param {number} options.maxSize        size of the device's image slot in bytes
 * @param {number} [options.loadAddress]  if given, the image must be built for this
 *                                        address, which ties it to this product's layout
 * @throws {ImageError}
 */
export function validateImage(image, signingKey, { maxSize, loadAddress } = {}) {
  if (!Buffer.isBuffer(image)) {
    fail('not_an_image', 'No image data');
  }
  if (!Number.isInteger(maxSize) || maxSize <= 0) {
    throw new TypeError('maxSize is required');
  }
  if (image.length < HEADER_SIZE + TLV_INFO_SIZE) {
    fail('too_small', 'The file is too small to be a firmware image');
  }
  if (image.length > maxSize) {
    fail('too_large', `The image is ${image.length} bytes; the device slot holds ${maxSize}`);
  }

  if (image.readUInt32LE(0) !== IMAGE_MAGIC) {
    fail('bad_magic', 'This is not an MCUboot image (upload the *.signed.bin file)');
  }

  const header = {
    loadAddress: image.readUInt32LE(4),
    headerSize: image.readUInt16LE(8),
    protectedTlvSize: image.readUInt16LE(10),
    imageSize: image.readUInt32LE(12),
    flags: image.readUInt32LE(16),
    version: {
      major: image.readUInt8(20),
      minor: image.readUInt8(21),
      revision: image.readUInt16LE(22),
      build: image.readUInt32LE(24),
    },
  };

  if (header.headerSize < HEADER_SIZE || header.headerSize > image.length) {
    fail('bad_header', 'The image header size is not plausible');
  }
  if (header.imageSize === 0) {
    fail('bad_header', 'The image is empty');
  }

  // Sum in plain numbers: every term is below 2^32, so nothing can wrap.
  const protectedStart = header.headerSize + header.imageSize;
  const tlvStart = protectedStart + header.protectedTlvSize;
  if (tlvStart + TLV_INFO_SIZE > image.length) {
    fail('truncated', 'The file is shorter than its header says');
  }

  const unknownFlags = [];
  const flagNames = [];
  for (let bit = 0; bit < 32; bit++) {
    const mask = (1 << bit) >>> 0;
    if ((header.flags & mask) >>> 0 === 0) continue;
    const name = FLAG_NAMES.get(mask);
    if (name) flagNames.push(name); else unknownFlags.push(`0x${mask.toString(16)}`);
  }
  if (unknownFlags.length || (header.flags & ~IMAGE_F_ROM_FIXED) >>> 0 !== 0) {
    const refused = flagNames.filter((name) => name !== 'ROM_FIXED').concat(unknownFlags);
    fail('unsupported_flags', `Image flags not accepted by this product: ${refused.join(', ')}`);
  }

  if (loadAddress !== undefined) {
    if ((header.flags & IMAGE_F_ROM_FIXED) === 0 || header.loadAddress !== loadAddress) {
      fail('wrong_target', 'The image was not built for this product\'s flash layout');
    }
  }

  if (header.protectedTlvSize !== 0) {
    if (header.protectedTlvSize < TLV_INFO_SIZE ||
        image.readUInt16LE(protectedStart) !== TLV_PROT_INFO_MAGIC ||
        image.readUInt16LE(protectedStart + 2) !== header.protectedTlvSize) {
      fail('malformed_tlv', 'The protected TLV area is malformed');
    }
    walkTlvs(image, protectedStart + TLV_INFO_SIZE, tlvStart, 'protected TLV');
  }

  if (image.readUInt16LE(tlvStart) !== TLV_INFO_MAGIC) {
    fail('unsigned', 'The image has no signature area: it is not signed');
  }
  const tlvTotal = image.readUInt16LE(tlvStart + 2);
  const tlvEnd = tlvStart + tlvTotal;
  if (tlvTotal < TLV_INFO_SIZE || tlvEnd > image.length) {
    fail('malformed_tlv', 'The TLV area is malformed');
  }
  if (tlvEnd !== image.length) {
    // A padded or pre-confirmed image carries a trailer here. Installing one would
    // make the update permanent with no trial and no way back.
    fail('trailing_data', 'The file has data after the signature. Upload the plain ' +
      '*.signed.bin, not a padded or confirmed image');
  }

  let imageHash;
  let keyHash;
  let signature;
  for (const { type, data } of walkTlvs(image, tlvStart + TLV_INFO_SIZE, tlvEnd, 'TLV')) {
    if (type === TLV_SHA256 && imageHash === undefined && data.length === 32) {
      imageHash = data;
    } else if (type === TLV_KEYHASH && keyHash === undefined && data.length === 32) {
      keyHash = data;
    } else if (type === TLV_ECDSA_SIG && signature === undefined) {
      signature = data;
    } else {
      fail('unexpected_tlv', `Unexpected or repeated TLV entry of type 0x${type.toString(16)}`);
    }
  }
  if (!imageHash || !keyHash || !signature) {
    fail('unsigned', 'The image is not signed with an ECDSA key');
  }

  const signed = image.subarray(0, tlvStart);
  const computed = createHash('sha256').update(signed).digest();
  if (!timingSafeEqual(computed, imageHash)) {
    fail('hash_mismatch', 'The image does not match its own SHA-256: the file is damaged');
  }

  if (!timingSafeEqual(keyHash, signingKey.keyHash)) {
    fail('wrong_key', 'The image is signed with a different key than this project\'s');
  }

  let valid = false;
  try {
    valid = verify('sha256', signed, { key: signingKey.key, dsaEncoding: 'der' },
      derSignature(signature));
  } catch (error) {
    if (error instanceof ImageError) throw error;
    valid = false;
  }
  if (!valid) {
    fail('bad_signature', 'The signature on the image is not valid');
  }

  return {
    version: formatVersion(header.version),
    versionParts: header.version,
    size: image.length,
    // Digest of the whole file: what the device checks after downloading.
    sha256: hex(createHash('sha256').update(image).digest()),
    // Digest MCUboot verifies: header, payload and protected TLVs.
    imageHash: hex(imageHash),
    keyHash: hex(keyHash),
    loadAddress: header.loadAddress,
    headerSize: header.headerSize,
    payloadSize: header.imageSize,
    flags: flagNames,
  };
}
