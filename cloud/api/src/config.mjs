/**
 * Configuration of the console API, read from the environment once at cold start.
 *
 * Every value is set by the CloudFormation stack (AWS_REGION by Lambda itself). A
 * missing or malformed value stops the function from starting, which is the safe
 * outcome: nothing here has a default that could quietly weaken a check.
 *
 * The only key material is the firmware signing PUBLIC key. The console verifies
 * signatures with it and can never produce one.
 */

import { loadSigningKey } from './lib/mcuboot.mjs';

const PATTERNS = Object.freeze({
  AWS_REGION: /^[a-z]{2}(?:-[a-z]+)+-\d{1,2}$/,
  STATE_TABLE: /^[A-Za-z0-9_.-]{3,255}$/,
  AUDIT_TABLE: /^[A-Za-z0-9_.-]{3,255}$/,
  FIRMWARE_BUCKET: /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/,
  THING_GROUP: /^[A-Za-z0-9:_-]{1,128}$/,
  PRESIGN_ROLE_ARN: /^arn:[a-z0-9-]+:iam::\d{12}:role\/[\w+=,.@/-]{1,576}$/,
  USER_POOL_ID: /^[\w-]+_[0-9A-Za-z]+$/,
  USER_POOL_CLIENT_ID: /^[\w+]{1,128}$/,
  SIGNING_PUBLIC_KEY_B64: /^[A-Za-z0-9+/]+={0,2}$/,
  SLOT_SIZE: /^[1-9]\d{0,9}$/,
  LOAD_ADDRESS: /^(?:0|[1-9]\d{0,9})$/,
});

function read(env, name) {
  const value = env[name];
  if (typeof value !== 'string' || !PATTERNS[name].test(value)) {
    // The value itself is not put in the message: messages end up in logs.
    throw new Error(`Environment variable ${name} is missing or malformed`);
  }
  return value;
}

/** PEM text for a DER SubjectPublicKeyInfo given as base64. */
function publicKeyPem(base64) {
  const der = Buffer.from(base64, 'base64');
  if (der.length === 0 || der.toString('base64') !== base64) {
    throw new Error('Environment variable SIGNING_PUBLIC_KEY_B64 is missing or malformed');
  }
  const lines = base64.match(/.{1,64}/g).join('\n');
  return `-----BEGIN PUBLIC KEY-----\n${lines}\n-----END PUBLIC KEY-----\n`;
}

/**
 * @param {Record<string, string|undefined>} [env]
 * @returns the frozen configuration the handlers use
 */
export function loadConfig(env = process.env) {
  const signingKey = loadSigningKey(publicKeyPem(read(env, 'SIGNING_PUBLIC_KEY_B64')));
  const slotSize = Number(read(env, 'SLOT_SIZE'));
  const loadAddress = Number(read(env, 'LOAD_ADDRESS'));
  if (slotSize > 0xffffffff || loadAddress > 0xffffffff) {
    throw new Error('SLOT_SIZE and LOAD_ADDRESS must fit 32 bits');
  }
  return Object.freeze({
    region: read(env, 'AWS_REGION'),
    stateTable: read(env, 'STATE_TABLE'),
    auditTable: read(env, 'AUDIT_TABLE'),
    firmwareBucket: read(env, 'FIRMWARE_BUCKET'),
    thingGroup: read(env, 'THING_GROUP'),
    presignRoleArn: read(env, 'PRESIGN_ROLE_ARN'),
    userPoolId: read(env, 'USER_POOL_ID'),
    userPoolClientId: read(env, 'USER_POOL_CLIENT_ID'),
    // { key, keyHash }: the public key and the SHA-256 of its DER encoding.
    signingKey,
    signingKeyFingerprint: signingKey.keyHash.toString('hex'),
    slotSize,
    loadAddress,
  });
}
