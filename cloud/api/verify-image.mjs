#!/usr/bin/env node
/**
 * Check a firmware image from the command line, with the check the console makes on an upload:
 * lib/mcuboot.mjs, with the slot size and load address that infra/template.yaml gives the console.
 *
 *   node cloud/api/verify-image.mjs [--key <public key>] <image>
 *
 * The key defaults to firmware/keys/fw_signing_pub.pem. It prints what the image says about
 * itself as one line of JSON and exits 0, or names the reason on stderr and exits 1. It is not
 * deployed. scripts/github-release.sh and scripts/verify-github-release.sh use it.
 *
 * No dependencies.
 */

import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ImageError, loadSigningKey, validateImage } from './src/lib/mcuboot.mjs';

const TEMPLATE = fileURLToPath(new URL('../infra/template.yaml', import.meta.url));
const DEFAULT_KEY = fileURLToPath(new URL('../../firmware/keys/fw_signing_pub.pem', import.meta.url));

/** A parameter's default in the console's template. This file takes no YAML library. */
export function templateDefault(template, name) {
  const match = new RegExp(`^  ${name}:\\n(?:    .*\\n)*?    Default: (\\d+)$`, 'm').exec(template);
  if (!match) throw new Error(`The template has no default for ${name}`);
  return Number(match[1]);
}

function main(args) {
  let key = DEFAULT_KEY;
  const at = args.indexOf('--key');
  if (at >= 0) {
    key = args[at + 1];
    args.splice(at, 2);
  }
  if (args.length !== 1 || key === undefined) {
    console.error('usage: node cloud/api/verify-image.mjs [--key <public key>] <image>');
    return 2;
  }
  const template = readFileSync(TEMPLATE, 'utf8');
  try {
    const info = validateImage(readFileSync(args[0]), loadSigningKey(readFileSync(key)), {
      maxSize: templateDefault(template, 'SlotSize'),
      loadAddress: templateDefault(template, 'LoadAddress'),
    });
    console.log(JSON.stringify({
      version: info.version,
      size: info.size,
      sha256: info.sha256,
      imageHash: info.imageHash,
      keyHash: info.keyHash,
    }));
    return 0;
  } catch (error) {
    console.error(`${args[0]}: ${error instanceof ImageError ? `${error.code}: ` : ''}${error.message}`);
    return 1;
  }
}

// Node gives this module's real path, and the command line whatever path it was called by.
if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) process.exitCode = main(process.argv.slice(2));
