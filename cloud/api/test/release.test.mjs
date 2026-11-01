// Tests for what stands between a build and a GitHub Release: scripts/github-release.sh, what the
// workflow runs on a published release, and the workflow itself. They run against a real git
// repository and a real bare origin in a temporary folder, with a stand-in for gh first on the PATH:
// nothing here reaches GitHub, and every call to gh is written down and looked at.
//
// The images are real MCUboot images in the layout of lib/mcuboot.mjs, signed here with a key that
// only exists in memory, so that one can hold whatever a test needs in its body.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync,
  statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { templateDefault } from '../verify-image.mjs';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const work = realpathSync(mkdtempSync(join(tmpdir(), 'cranium-release-')));
after(() => rmSync(work, { recursive: true, force: true }));

const STUB = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$STUB_LOG"
case "$1 $2" in
  "auth status") exit "\${STUB_AUTH:-0}" ;;
  "release view") exit "\${STUB_RELEASE_VIEW:-1}" ;;
  "release create")
    mkdir -p "$STUB_UPLOADS"
    for argument in "$@"; do
      if [ -f "$argument" ]; then cp "$argument" "$STUB_UPLOADS/"; fi
    done
    echo "https://github.example/owner/repo/releases/tag/$3"
    ;;
esac
`;
const stubDir = join(work, 'bin');
mkdirSync(stubDir);
writeFileSync(join(stubDir, 'gh'), STUB);
chmodSync(join(stubDir, 'gh'), 0o755);

function environment(extra = {}) {
  const clean = Object.fromEntries(Object.entries(process.env)
    .filter(([name]) => !/^(GIT_|GH_|GITHUB_)/.test(name)));
  return { ...clean, HOME: work, PATH: `${stubDir}:${process.env.PATH}`, ...extra };
}

function git(cwd, ...args) {
  const result = spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.org', '-c', 'init.defaultBranch=main',
    '-c', 'advice.detachedHead=false', ...args], { cwd, encoding: 'utf8', env: environment() });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

const makeKey = () => generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const KEY = makeKey();
const OTHER_KEY = makeKey();
const publicPem = (key) => key.publicKey.export({ type: 'spki', format: 'pem' });
const sha256 = (data) => createHash('sha256').update(data).digest();

function makeImage({ version = [1, 2, 3, 4], body = Buffer.alloc(600, 0x41), key = KEY } = {}) {
  const headerSize = 0x200;
  const header = Buffer.alloc(headerSize);
  header.writeUInt32LE(0x96f3b83d, 0);
  header.writeUInt32LE(0x30000, 4);
  header.writeUInt16LE(headerSize, 8);
  header.writeUInt32LE(body.length, 12);
  header.writeUInt32LE(0x100, 16); // ROM_FIXED
  header.writeUInt8(version[0], 20);
  header.writeUInt8(version[1], 21);
  header.writeUInt16LE(version[2], 22);
  header.writeUInt32LE(version[3], 24);
  const signed = Buffer.concat([header, body]);
  const entry = (type, data) => {
    const head = Buffer.alloc(4);
    head.writeUInt16LE(type, 0);
    head.writeUInt16LE(data.length, 2);
    return Buffer.concat([head, data]);
  };
  const entries = Buffer.concat([
    entry(0x10, sha256(signed)),
    entry(0x01, sha256(key.publicKey.export({ type: 'spki', format: 'der' }))),
    entry(0x22, sign('sha256', signed, { key: key.privateKey, dsaEncoding: 'der' })),
  ]);
  const info = Buffer.alloc(4);
  info.writeUInt16LE(0x6907, 0);
  info.writeUInt16LE(entries.length + 4, 2);
  return Buffer.concat([signed, info, entries]);
}

const VERSION_FILE = (major, minor, patch, tweak, extra = '') =>
  `VERSION_MAJOR = ${major}\nVERSION_MINOR = ${minor}\nPATCHLEVEL = ${patch}\nVERSION_TWEAK = ${tweak}\nEXTRAVERSION = ${extra}\n`.replace(/ \n/g, '\n');

let repos = 0;

/** A checkout with an origin, pushed, and with what a build of its HEAD leaves in binaries/. */
function checkout({ versionFile = VERSION_FILE(1, 2, 3, 4), image = makeImage(), name = 'cranium-1.2.3-4.signed.bin', version = '1.2.3+4' } = {}) {
  repos += 1;
  const root = join(work, `repo-${repos}`);
  const dir = join(root, 'checkout');
  const origin = join(root, 'origin.git');
  mkdirSync(dir, { recursive: true });
  git(root, 'init', '-q', '--bare', origin);
  git(dir, 'init', '-q');
  git(dir, 'remote', 'add', 'origin', origin);
  for (const file of ['scripts/github-release.sh', 'scripts/release-lib.sh', 'scripts/verify-github-release.sh',
    'scripts/scan-tracked-files.sh', 'cloud/api/verify-image.mjs', 'cloud/api/src/lib/mcuboot.mjs', 'cloud/infra/template.yaml']) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    copyFileSync(join(REPO, file), join(dir, file));
    chmodSync(join(dir, file), statSync(join(REPO, file)).mode);
  }
  mkdirSync(join(dir, 'firmware/keys'), { recursive: true });
  mkdirSync(join(dir, 'firmware/app'), { recursive: true });
  writeFileSync(join(dir, 'firmware/keys/fw_signing_pub.pem'), publicPem(KEY));
  writeFileSync(join(dir, 'firmware/app/VERSION'), versionFile);
  writeFileSync(join(dir, 'firmware/golden.json'), JSON.stringify({ file_sha256: '00'.repeat(32), hash_tlv: '11'.repeat(32) }));
  writeFileSync(join(dir, '.gitignore'), '/binaries/\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'A commit');
  git(dir, 'push', '-q', 'origin', 'main');
  const state = { dir, origin, binaries: join(dir, 'binaries'), name, version };
  build(state, image);
  return state;
}

/** What tools/store_binary.py leaves behind. */
function build(state, image, latest = {}) {
  mkdirSync(state.binaries, { recursive: true });
  writeFileSync(join(state.binaries, state.name), image);
  writeFileSync(join(state.binaries, 'latest.signed.bin'), image);
  writeFileSync(join(state.binaries, 'latest.json'), JSON.stringify({
    version: state.version,
    file: state.name,
    size: image.length,
    sha256: sha256(image).toString('hex'),
    commit: git(state.dir, 'rev-parse', '--short', 'HEAD'),
    command_line: [],
    built: '2026-11-01T00:00:00Z',
    ...latest,
  }));
}

let runs = 0;

function script(state, name, args, env = {}) {
  runs += 1;
  const log = join(work, `calls-${runs}`);
  const uploads = join(work, `uploads-${runs}`);
  const result = spawnSync('bash', [join(state.dir, 'scripts', name), ...args], {
    // Not from the checkout, to show that a script finds its own way there.
    cwd: work,
    encoding: 'utf8',
    env: environment({ STUB_LOG: log, STUB_UPLOADS: uploads, ...env }),
  });
  return {
    ...result,
    calls: existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [],
    uploads,
  };
}

const release = (state, args = ['1.2.3+4', '--dry-run'], env) => script(state, 'github-release.sh', args, env);
const created = (result) => result.calls.filter((call) => call.startsWith('release create'));

function assertRefused(result, reason) {
  assert.equal(result.status, 1, `it should have refused: ${result.stdout}${result.stderr}`);
  assert.match(result.stderr, reason);
  assert.deepEqual(created(result), [], 'nothing was published');
}

/** Every file with its size and time, so that a run that writes anything at all shows. */
function snapshot(folder) {
  const listing = {};
  for (const entry of readdirSync(folder, { recursive: true })) {
    const stat = statSync(join(folder, entry));
    listing[entry] = `${stat.size} ${stat.mtimeMs}`;
  }
  return listing;
}

// scripts/github-release.sh: what it does when everything holds.

test('a dry run does every check, says what would go out, and writes nothing at all', () => {
  const state = checkout();
  const before = [snapshot(state.dir), snapshot(state.origin)];
  const result = release(state);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /nothing was written/);
  assert.match(result.stdout, /v1\.2\.3\+4/);
  assert.match(result.stdout, new RegExp(`${sha256(readFileSync(join(state.binaries, state.name))).toString('hex')} {2}cranium-1\\.2\\.3-4\\.signed\\.bin`));
  assert.deepEqual(created(result), []);
  assert.deepEqual(result.calls, ['auth status', 'release view v1.2.3+4']);
  assert.deepEqual([snapshot(state.dir), snapshot(state.origin)], before);
  assert.equal(existsSync(result.uploads), false);
});

test('a real run publishes the image, latest.json and SHA256SUMS on this commit, and prints the address', () => {
  const state = checkout();
  const result = release(state, ['1.2.3+4']);
  assert.equal(result.status, 0, result.stderr);
  const [call] = created(result);
  const head = git(state.dir, 'rev-parse', 'HEAD');
  assert.ok(call.startsWith(`release create v1.2.3+4 --target ${head} --title Firmware 1.2.3+4 `), call);
  assert.match(result.stdout, /https:\/\/github\.example\/owner\/repo\/releases\/tag\/v1\.2\.3\+4\n$/);

  assert.deepEqual(readdirSync(result.uploads).sort(), ['SHA256SUMS', 'cranium-1.2.3-4.signed.bin', 'latest.json']);
  const image = readFileSync(join(result.uploads, 'cranium-1.2.3-4.signed.bin'));
  assert.deepEqual(image, readFileSync(join(state.binaries, state.name)));
  assert.equal(readFileSync(join(result.uploads, 'SHA256SUMS'), 'utf8'),
    `${sha256(image).toString('hex')}  cranium-1.2.3-4.signed.bin\n` +
    `${sha256(readFileSync(join(state.binaries, 'latest.json'))).toString('hex')}  latest.json\n`);
});

test('a version with no build number has the tag without one', () => {
  const state = checkout({ versionFile: VERSION_FILE(1, 2, 3, 0), image: makeImage({ version: [1, 2, 3, 0] }), name: 'cranium-1.2.3-0.signed.bin', version: '1.2.3+0' });
  const result = release(state, ['1.2.3']);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(created(result)[0].startsWith('release create v1.2.3 --target'));
  assertRefused(release(state, ['1.2.3+0', '--dry-run']), /write 1\.2\.3\+0 as 1\.2\.3/);
});

test('a file nobody has committed does not matter, and a pushed commit behind the branch is fine', () => {
  const state = checkout();
  writeFileSync(join(state.dir, 'notes.txt'), 'not tracked');
  assert.equal(release(state).status, 0);
  const head = git(state.dir, 'rev-parse', 'HEAD');
  writeFileSync(join(state.dir, 'firmware/app/other'), 'later');
  git(state.dir, 'add', 'firmware/app/other');
  git(state.dir, 'commit', '-q', '-m', 'A later commit');
  git(state.dir, 'push', '-q', 'origin', 'main');
  git(state.dir, 'checkout', '-q', '--detach', head);
  assert.equal(release(state).status, 0);
});

// What it refuses.

test('a change to a tracked file is refused, staged or not', () => {
  const state = checkout();
  writeFileSync(join(state.dir, 'cloud/infra/template.yaml'), `${readFileSync(join(state.dir, 'cloud/infra/template.yaml'))}\n`);
  assertRefused(release(state), /tracked files have changed/);
  git(state.dir, 'add', '.');
  assertRefused(release(state), /tracked files have changed/);
});

test('a commit that is not on origin is refused', () => {
  const state = checkout();
  writeFileSync(join(state.dir, 'firmware/app/other'), 'later');
  git(state.dir, 'add', 'firmware/app/other');
  git(state.dir, 'commit', '-q', '-m', 'Not pushed');
  build(state, makeImage());
  assertRefused(release(state), /on no branch of origin: push it first/);
  git(state.dir, 'push', '-q', 'origin', 'main');
  assert.equal(release(state).status, 0);
});

test('what this checkout remembers about origin is not taken for what origin holds', () => {
  const state = checkout();
  git(state.dir, 'fetch', '-q', 'origin');
  rmSync(join(state.origin, 'refs/heads/main'));
  assert.ok(git(state.dir, 'branch', '-r').includes('origin/main'));
  assertRefused(release(state), /on no branch of origin/);
});

test('a version that is not the one in firmware/app/VERSION is refused', () => {
  const state = checkout({ versionFile: VERSION_FILE(1, 2, 3, 5) });
  assertRefused(release(state), /firmware\/app\/VERSION says 1\.2\.3\+5, and this release is 1\.2\.3\+4/);
  assertRefused(release(checkout(), ['1.2.4', '--dry-run']), /firmware\/app\/VERSION says 1\.2\.3\+4/);
});

test('an image whose header says another version is refused', () => {
  const state = checkout({ image: makeImage({ version: [1, 2, 3, 5] }) });
  assertRefused(release(state), /image's header says 1\.2\.3\+5, and this release is 1\.2\.3\+4/);
});

test('an image signed with another key is refused', () => {
  assertRefused(release(checkout({ image: makeImage({ key: OTHER_KEY }) })), /wrong_key|does not verify against firmware\/keys\/fw_signing_pub\.pem/);
});

test('a damaged image and a damaged signature are refused, even when latest.json agrees with them', () => {
  for (const [offset, code] of [[0x210, /hash_mismatch/], [-3, /bad_signature/]]) {
    const state = checkout();
    const image = Buffer.from(readFileSync(join(state.binaries, state.name)));
    image[offset < 0 ? image.length + offset : offset] ^= 1;
    build(state, image);
    const result = release(state);
    assertRefused(result, code);
    assert.match(result.stderr, /does not verify against firmware\/keys\/fw_signing_pub\.pem/);
  }
});

test('something that is not an image is refused', () => {
  const state = checkout();
  build(state, Buffer.from('not an image'));
  assertRefused(release(state), /does not verify/);
});

test('latest.json has to describe this image, of this commit', () => {
  const cases = [
    [{ commit: '0000000' }, /built from 0000000/],
    [{ commit: 'unknown' }, /does not say which commit/],
    [{ sha256: 'ab'.repeat(32) }, /SHA-256 is not that of/],
    [{ size: 1 }, /size is not that of/],
    [{ version: '1.2.3+3' }, /describes version 1\.2\.3\+3/],
    [{ file: 'golden/cranium-1.2.3-4.signed.bin' }, /describes the file golden\//],
  ];
  for (const [latest, reason] of cases) {
    const state = checkout();
    build(state, readFileSync(join(state.binaries, state.name)), latest);
    assertRefused(release(state), reason);
  }
});

test('an image built with uncommitted changes is refused by name', () => {
  const state = checkout();
  const commit = `${git(state.dir, 'rev-parse', '--short', 'HEAD')}+uncommitted`;
  build(state, readFileSync(join(state.binaries, state.name)), { commit });
  assertRefused(release(state), /built with uncommitted changes/);
});

test('an older build of another commit is refused', () => {
  const state = checkout();
  const image = readFileSync(join(state.binaries, state.name));
  const latest = readFileSync(join(state.binaries, 'latest.json'));
  writeFileSync(join(state.dir, 'firmware/app/other'), 'later');
  git(state.dir, 'add', 'firmware/app/other');
  git(state.dir, 'commit', '-q', '-m', 'A later commit');
  git(state.dir, 'push', '-q', 'origin', 'main');
  writeFileSync(join(state.binaries, state.name), image);
  writeFileSync(join(state.binaries, 'latest.json'), latest);
  assertRefused(release(state), /this image was built from/);
});

test('an image with settings from the command line is refused, a fault or Bluetooth above all', () => {
  for (const setting of ['app_CONFIG_APP_TEST_FAULT_NO_CONFIRM=y', 'SB_EXTRA_CONF_FILE=bt_ota_sysbuild.conf', 'app_CONFIG_LOG=n']) {
    const state = checkout();
    build(state, readFileSync(join(state.binaries, state.name)), { command_line: [setting] });
    const result = release(state);
    assertRefused(result, /settings from the command line/);
    assert.ok(result.stderr.includes(setting));
  }
  const state = checkout();
  build(state, readFileSync(join(state.binaries, state.name)), { command_line: undefined });
  assertRefused(release(state), /does not say how this image was configured/);
});

test('a test image that got into binaries/ by hand is told by its log lines, and a Bluetooth image by its stack', () => {
  const cases = [
    ['Test image: hanging on purpose, the watchdog will fire', /test fault built in/],
    ['test image: losing power before the init flag', /test fault built in/],
    ['Bluetooth could not start: %d', /over Bluetooth built in/],
    ['bt_hci_core', /over Bluetooth built in/],
  ];
  for (const [text, reason] of cases) {
    const body = Buffer.concat([Buffer.alloc(64, 0x41), Buffer.from(text), Buffer.alloc(64, 0x41)]);
    assertRefused(release(checkout({ image: makeImage({ body }) })), reason);
  }
});

test('those log lines are still what the firmware says', () => {
  const source = (name) => readFileSync(join(REPO, 'firmware/app/src', name), 'utf8');
  for (const text of ['Test image: crashing on purpose', 'Test image: hanging on purpose', 'Test image: damaging both image slots',
    'Test image: damaging the golden copy']) {
    assert.ok(source('main.c').includes(text), text);
  }
  assert.ok(source('console.c').includes('test image: losing power'));
  assert.ok(source('bt_ota.c').includes('Bluetooth could not start'));
});

test('the golden image never goes out, however it got there', () => {
  const pinned = (mutate) => {
    const state = checkout();
    const image = readFileSync(join(state.binaries, state.name));
    mutate(state, image);
    git(state.dir, 'add', '.');
    git(state.dir, 'commit', '-q', '--amend', '--no-edit');
    git(state.dir, 'push', '-q', '-f', 'origin', 'main');
    build(state, image);
    return state;
  };
  const byFile = pinned((state, image) => writeFileSync(join(state.dir, 'firmware/golden.json'),
    JSON.stringify({ file_sha256: sha256(image).toString('hex'), hash_tlv: '11'.repeat(32) })));
  assertRefused(release(byFile), /this is the golden image/);

  // What MCUboot verifies is the same, and the file around it is not.
  const byHash = pinned((state, image) => writeFileSync(join(state.dir, 'firmware/golden.json'),
    JSON.stringify({ file_sha256: '00'.repeat(32), hash_tlv: sha256(image.subarray(0, 0x200 + 600)).toString('hex') })));
  assertRefused(release(byHash), /this is the golden image/);

  const kept = checkout();
  mkdirSync(join(kept.binaries, 'golden'));
  copyFileSync(join(kept.binaries, kept.name), join(kept.binaries, 'golden/anything.bin'));
  assertRefused(release(kept), /same file as binaries\/golden\/anything\.bin/);

  const linked = checkout();
  mkdirSync(join(linked.binaries, 'golden'));
  copyFileSync(join(linked.binaries, linked.name), join(linked.binaries, `golden/${linked.name}`));
  rmSync(join(linked.binaries, linked.name));
  symlinkSync(join(linked.binaries, `golden/${linked.name}`), join(linked.binaries, linked.name));
  assertRefused(release(linked), /missing or is a link/);
});

test('a tag or a release that exists already is refused', () => {
  const onOrigin = checkout();
  git(onOrigin.dir, 'tag', 'v1.2.3+4');
  git(onOrigin.dir, 'push', '-q', 'origin', 'v1.2.3+4');
  assertRefused(release(onOrigin), /origin already has the tag/);

  const elsewhere = checkout();
  writeFileSync(join(elsewhere.dir, 'firmware/app/other'), 'later');
  git(elsewhere.dir, 'tag', 'v1.2.3+4');
  git(elsewhere.dir, 'add', 'firmware/app/other');
  git(elsewhere.dir, 'commit', '-q', '-m', 'A later commit');
  git(elsewhere.dir, 'push', '-q', 'origin', 'main');
  build(elsewhere, readFileSync(join(elsewhere.binaries, elsewhere.name)));
  assertRefused(release(elsewhere), /a tag v1\.2\.3\+4 on another commit/);

  assertRefused(release(checkout(), ['1.2.3+4', '--dry-run'], { STUB_RELEASE_VIEW: '0' }), /already has a release/);
});

test('it says so when gh is not signed in, when the image is missing, and when the version makes no sense', () => {
  assertRefused(release(checkout(), ['1.2.3+4', '--dry-run'], { STUB_AUTH: '1' }), /gh is not signed in/);
  const state = checkout();
  rmSync(join(state.binaries, state.name));
  assertRefused(release(state), /is missing or is a link/);
  const noLatest = checkout();
  rmSync(join(noLatest.binaries, 'latest.json'));
  assertRefused(release(noLatest), /latest\.json is missing/);
  for (const version of ['1.2', '1.2.3-rc1', 'latest', '1.2.3+', '1.2.3;id']) {
    assertRefused(release(checkout(), [version, '--dry-run']), /is not a version/);
  }
  assert.equal(release(checkout(), []).status, 2);
  assert.equal(release(checkout(), ['1.2.3+4', '--force']).status, 2);
});

test('an EXTRAVERSION is refused, because the image could not carry it', () => {
  assertRefused(release(checkout({ versionFile: VERSION_FILE(1, 2, 3, 4, 'rc1') })), /has an EXTRAVERSION/);
});

// scripts/verify-github-release.sh, which the workflow runs on what a release holds.

function published(state = checkout(), tag = 'v1.2.3+4') {
  const folder = join(dirname(state.dir), 'release');
  mkdirSync(folder);
  copyFileSync(join(state.binaries, state.name), join(folder, state.name));
  copyFileSync(join(state.binaries, 'latest.json'), join(folder, 'latest.json'));
  const sums = (entries) => entries.map((name) => `${sha256(readFileSync(join(folder, name))).toString('hex')}  ${name}\n`).join('');
  writeFileSync(join(folder, 'SHA256SUMS'), sums([state.name, 'latest.json']));
  return { state, folder, tag, sums: () => sums([state.name, 'latest.json']) };
}

const verify = ({ state, folder, tag }) => script(state, 'verify-github-release.sh', [tag, folder]);

function assertFails(result, reason) {
  assert.equal(result.status, 1, `it should have failed: ${result.stdout}${result.stderr}`);
  assert.match(result.stderr, reason);
  assert.match(result.stderr, /^::error title=Release check failed::/m, 'loudly, as an annotation');
}

test('what github-release.sh publishes passes the check on the release, and that check calls no gh', () => {
  const state = checkout();
  const made = release(state, ['1.2.3+4']);
  assert.equal(made.status, 0, made.stderr);
  const result = verify({ state, folder: made.uploads, tag: 'v1.2.3+4' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /SHA256SUMS is right/);
  assert.match(result.stdout, /signature verifies/);
  assert.deepEqual(result.calls, []);
});

test('the check fails when SHA256SUMS is wrong, in the image, in latest.json or in itself', () => {
  const inImage = published();
  const image = readFileSync(join(inImage.folder, inImage.state.name));
  writeFileSync(join(inImage.folder, 'SHA256SUMS'), inImage.sums().replace(sha256(image).toString('hex'), 'ab'.repeat(32)));
  assertFails(verify(inImage), /SHA256SUMS is not right/);

  const inJson = published();
  writeFileSync(join(inJson.folder, 'latest.json'), `${readFileSync(join(inJson.folder, 'latest.json'))}\n`);
  assertFails(verify(inJson), /SHA256SUMS is not right/);

  const cut = published();
  writeFileSync(join(cut.folder, 'SHA256SUMS'), cut.sums().split('\n')[0]);
  assertFails(verify(cut), /SHA256SUMS is not right/);
});

test('the check fails when a signature is not the project\'s, even with right sums', () => {
  const release_ = published(checkout({ image: makeImage({ key: OTHER_KEY }) }));
  assertFails(verify(release_), /does not verify against firmware\/keys\/fw_signing_pub\.pem/);

  const damaged = published();
  const image = Buffer.from(readFileSync(join(damaged.folder, damaged.state.name)));
  image[0x210] ^= 1;
  build(damaged.state, image);
  copyFileSync(join(damaged.state.binaries, damaged.state.name), join(damaged.folder, damaged.state.name));
  copyFileSync(join(damaged.state.binaries, 'latest.json'), join(damaged.folder, 'latest.json'));
  writeFileSync(join(damaged.folder, 'SHA256SUMS'), damaged.sums());
  assertFails(verify(damaged), /does not verify/);
});

test('the check fails when the version is not the tag\'s, in the header, in latest.json or in the repository', () => {
  // The file is named for the tag, and the header says otherwise.
  const header = published(checkout({ image: makeImage({ version: [1, 2, 3, 5] }) }));
  assertFails(verify(header), /image's header says 1\.2\.3\+5/);

  const json = published();
  const latest = JSON.parse(readFileSync(join(json.folder, 'latest.json')));
  writeFileSync(join(json.folder, 'latest.json'), JSON.stringify({ ...latest, version: '1.2.3+9' }));
  writeFileSync(join(json.folder, 'SHA256SUMS'), json.sums());
  assertFails(verify(json), /describes version 1\.2\.3\+9/);

  const repository = published(checkout({ versionFile: VERSION_FILE(1, 2, 3, 5) }));
  assertFails(verify(repository), /firmware\/app\/VERSION at this tag says 1\.2\.3\+5/);
});

test('the check fails when the image is of another commit than the tag', () => {
  const state = checkout();
  const release_ = published(state);
  writeFileSync(join(state.dir, 'firmware/app/other'), 'later');
  git(state.dir, 'add', 'firmware/app/other');
  git(state.dir, 'commit', '-q', '-m', 'What the tag is on');
  assertFails(verify(release_), /this image was built from/);
});

test('the check fails when the release holds more or less than it should', () => {
  const extra = published();
  writeFileSync(join(extra.folder, 'cranium-1.5.0-0.signed.bin'), 'the golden image, say');
  assertFails(verify(extra), /should hold exactly/);

  const missing = published();
  rmSync(join(missing.folder, 'SHA256SUMS'));
  assertFails(verify(missing), /should hold exactly/);

  // A file name that tries to be a workflow command stays in the middle of a line.
  const named = published();
  writeFileSync(join(named.folder, '::add-mask::x'), '');
  const result = verify(named);
  assertFails(result, /should hold exactly/);
  assert.doesNotMatch(result.stderr, /^::add-mask::/m);
  assert.doesNotMatch(result.stderr, /::add-mask::x/);
});

test('the check fails on a test image and on the golden image, as the script does', () => {
  const fault = published(checkout({ image: makeImage({ body: Buffer.concat([Buffer.alloc(64), Buffer.from('Test image: crashing on purpose')]) }) }));
  assertFails(verify(fault), /test fault built in/);

  const state = checkout();
  build(state, readFileSync(join(state.binaries, state.name)), { command_line: ['SB_EXTRA_CONF_FILE=bt_ota_sysbuild.conf'] });
  assertFails(verify(published(state)), /settings from the command line/);

  const golden = checkout();
  const image = readFileSync(join(golden.binaries, golden.name));
  writeFileSync(join(golden.dir, 'firmware/golden.json'), JSON.stringify({ file_sha256: sha256(image).toString('hex'), hash_tlv: '11'.repeat(32) }));
  assertFails(verify(published(golden)), /this is the golden image/);
});

test('a tag that is not a version never gets further than that', () => {
  for (const tag of ['v1.2', 'nightly', 'v1.2.3;id', '$(id)', '--dry-run', 'v1.2.3+0']) {
    const result = verify({ ...published(), tag });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /does not look like|write 1\.2\.3\+0/);
    assert.doesNotMatch(result.stdout, /uid=/);
  }
});

// cloud/api/verify-image.mjs, which both of them use.

test('the image check on the command line is the console\'s, with the console\'s limits', () => {
  const run = (...args) => spawnSync(process.execPath, [join(REPO, 'cloud/api/verify-image.mjs'), ...args], { encoding: 'utf8' });
  const key = join(FIXTURES, 'test_signing_pub.pem');
  const good = run('--key', key, join(FIXTURES, 'valid-1.2.3+4.signed.bin'));
  assert.equal(good.status, 0, good.stderr);
  assert.equal(JSON.parse(good.stdout).version, '1.2.3+4');
  assert.match(run('--key', key, join(FIXTURES, 'signed-with-other-key.signed.bin')).stderr, /wrong_key/);
  assert.match(run('--key', key, join(FIXTURES, 'other-load-address.signed.bin')).stderr, /wrong_target/);
  assert.match(run('--key', key, join(FIXTURES, 'padded-and-confirmed.signed.bin')).stderr, /trailing_data/);
  assert.match(run('--key', key, join(FIXTURES, 'hash-only-unsigned.bin')).stderr, /unsigned/);
  assert.equal(run('--key', key, join(work, 'no such file')).status, 1);
  assert.equal(run().status, 2);

  const template = readFileSync(join(REPO, 'cloud/infra/template.yaml'), 'utf8');
  assert.equal(templateDefault(template, 'SlotSize'), 0xe4000);
  assert.equal(templateDefault(template, 'LoadAddress'), 0x30000);
  assert.throws(() => templateDefault(template, 'NoSuchParameter'), /no default/);
});

// scripts/scan-tracked-files.sh.

const scan = (state) => script(state, 'scan-tracked-files.sh', []);
// Put together here, so that this file is no hit itself.
const PEM_HEADERS = ['PRIVATE KEY', 'EC PRIVATE KEY', 'RSA PRIVATE KEY', 'OPENSSH PRIVATE KEY', 'ENCRYPTED PRIVATE KEY'].map((name) => `-----BEGIN ${name}-----`);

test('the scan passes on what has no key in it, and says what it looked at', () => {
  const state = checkout();
  writeFileSync(join(state.dir, 'public.pem'), publicPem(KEY));
  git(state.dir, 'add', 'public.pem');
  mkdirSync(join(state.dir, 'secrets'));
  writeFileSync(join(state.dir, 'secrets/wifi_secrets.h.example'), '#define WIFI_SSID "x"\n');
  git(state.dir, 'add', 'secrets');
  const result = scan(state);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /tracked files, with no private key/);
});

test('the scan finds a private key of any kind, in a text file or a binary one, and never prints it', () => {
  for (const [at, header] of PEM_HEADERS.entries()) {
    const state = checkout();
    const secret = `some-key-material-${at}`;
    mkdirSync(join(state.dir, 'deep/down'), { recursive: true });
    writeFileSync(join(state.dir, 'deep/down/innocent.txt'), `${header}\n${secret}\n`);
    git(state.dir, 'add', 'deep');
    const result = scan(state);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /deep\/down\/innocent\.txt/);
    assert.ok(!result.stdout.includes(secret) && !result.stderr.includes(secret));
    assert.ok(!result.stdout.includes(header) && !result.stderr.includes(header));
  }
  const state = checkout();
  writeFileSync(join(state.dir, 'blob.bin'), Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from(PEM_HEADERS[0])]));
  git(state.dir, 'add', 'blob.bin');
  assert.match(scan(state).stderr, /blob\.bin/);
});

test('the scan finds a wifi_secrets.h anywhere in the tree, and leaves alone what is not tracked', () => {
  const state = checkout();
  writeFileSync(join(state.dir, 'wifi_secrets.h'), 'not tracked');
  assert.equal(scan(state).status, 0);
  mkdirSync(join(state.dir, 'firmware/app/src'), { recursive: true });
  writeFileSync(join(state.dir, 'firmware/app/src/wifi_secrets.h'), '#define WIFI_PSK "x"\n');
  git(state.dir, 'add', 'firmware/app/src/wifi_secrets.h');
  const result = scan(state);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /firmware\/app\/src\/wifi_secrets\.h/);
});

test('the scan passes on this repository as it is', () => {
  const result = spawnSync('bash', [join(REPO, 'scripts/scan-tracked-files.sh')], { encoding: 'utf8', env: environment() });
  assert.equal(result.status, 0, result.stderr);
});

// scripts/check-west-workspace.sh, with a stand-in for west: what stands between a stale cache and a pass.

function workspace() {
  repos += 1;
  const top = join(work, `workspace-${repos}`);
  const project = (path) => {
    const dir = join(top, path);
    mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q');
    writeFileSync(join(dir, 'file'), 'as released\n');
    git(dir, 'add', 'file');
    git(dir, 'commit', '-q', '-m', 'Released');
    return dir;
  };
  const nrf = project('nrf');
  const zephyr = project('zephyr');
  git(zephyr, 'branch', 'manifest-rev');
  const bin = join(top, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'west'), `#!/usr/bin/env bash\nprintf 'manifest|${nrf}\\nzephyr|${zephyr}\\n'\n`);
  chmodSync(join(bin, 'west'), 0o755);
  const check = (commit = git(nrf, 'rev-parse', 'HEAD')) => spawnSync('bash', [join(REPO, 'scripts/check-west-workspace.sh'), top, commit], {
    encoding: 'utf8', env: environment({ PATH: `${bin}:${process.env.PATH}` }),
  });
  return { nrf, zephyr, check };
}

test('a workspace that is exactly the SDK passes, and files the build leaves behind do not matter', () => {
  const { zephyr, check } = workspace();
  writeFileSync(join(zephyr, 'untracked.pyc'), 'x');
  const result = check();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /1 other projects/);
});

test('a cached workspace with sdk-nrf on another commit fails, or with a change in it', () => {
  const first = workspace();
  const result = first.check('0'.repeat(40));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /nrf is on .* and should be on 0{40}/);

  const second = workspace();
  writeFileSync(join(second.nrf, 'file'), 'changed\n');
  assert.match(second.check().stderr, /nrf has changed files/);
});

test('a cached project off its manifest revision fails, or with a change in it, or never fetched', () => {
  const moved = workspace();
  writeFileSync(join(moved.zephyr, 'file'), 'something else\n');
  git(moved.zephyr, 'add', 'file');
  git(moved.zephyr, 'commit', '-q', '-m', 'Not the release');
  assert.match(moved.check().stderr, /zephyr is on .* and the manifest says/);

  const changed = workspace();
  writeFileSync(join(changed.zephyr, 'file'), 'changed\n');
  assert.match(changed.check().stderr, /zephyr has changed files/);

  const unfetched = workspace();
  git(unfetched.zephyr, 'branch', '-q', '-D', 'manifest-rev');
  assert.match(unfetched.check().stderr, /zephyr has no manifest-rev/);
});

// The workflow. These are the decisions in docs/ci.md, held to as text: this file takes no YAML library.

const WORKFLOW = readFileSync(join(REPO, '.github/workflows/ci.yml'), 'utf8');

test('every action is pinned to a full commit id, with its version in a comment', () => {
  const uses = [...WORKFLOW.matchAll(/^\s*(?:- )?uses: (.+)$/gm)].map((match) => match[1]);
  assert.ok(uses.length >= 8);
  for (const line of uses) assert.match(line, /^[\w./-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
});

test('the workflow has read-only permissions, no dangerous trigger and no secrets', () => {
  assert.match(WORKFLOW, /^permissions:\n {2}contents: read\n/m);
  const permissions = [...WORKFLOW.matchAll(/^\s*permissions:\n((?:\s+[\w-]+: \w+\n)+)/gm)].map((match) => match[1].trim());
  assert.deepEqual(permissions, ['contents: read', 'contents: read']);
  assert.doesNotMatch(WORKFLOW, /pull_request_target|workflow_run|\bsecrets\.|write-all/);
});

test('no expression is ever pasted into a run step', () => {
  const lines = WORKFLOW.split('\n');
  let inside = null;
  const blocks = [];
  for (const line of lines) {
    const indent = line.search(/\S/);
    if (inside !== null && line.trim() !== '' && indent <= inside) inside = null;
    const run = /^(\s*)(?:- )?run: ?(.*)$/.exec(line);
    if (run) {
      inside = indent;
      blocks.push(run[2]);
    } else if (inside !== null) {
      blocks.push(line);
    }
  }
  assert.ok(blocks.length > 40);
  for (const line of blocks) assert.doesNotMatch(line, /\$\{\{/);
});

test('the signing key comes from nowhere but the job, and is neither cached nor uploaded', () => {
  assert.match(WORKFLOW, /imgtool\.py" keygen -t ecdsa-p256 -k "\$HOME\/\.cranium\/mcuboot_signing_key\.pem"/);
  assert.doesNotMatch(WORKFLOW, /python3? tools\/keys\.py/, 'it would write over the public key in the repository');
  for (const path of WORKFLOW.matchAll(/^\s+path: (.+)$/gm)) assert.ok(['~/ncs', 'ci-artifact/'].includes(path[1]), path[1]);
  assert.doesNotMatch(WORKFLOW, /^\s+restore-keys:/m, 'only a cache of exactly this SDK');
});

test('the artifact says what it is, and lasts thirty days', () => {
  assert.match(WORKFLOW, /name: \$\{\{ steps\.report\.outputs\.artifact \}\}\n\s+path: ci-artifact\/\n\s+if-no-files-found: error\n\s+retention-days: 30\n/);
  assert.match(readFileSync(join(REPO, 'tools/build_report.py'), 'utf8'), /ci-key-not-installable/);
});

test('the SDK named in the workflow, the fetch script and the image is one SDK', () => {
  const commit = /NCS_COMMIT: ([0-9a-f]{40})/.exec(WORKFLOW)[1];
  const version = /NCS_VERSION: (v[\d.]+)/.exec(WORKFLOW)[1];
  assert.ok(readFileSync(join(REPO, 'firmware/tests/fetch-sdk-files.sh'), 'utf8').includes(`fetch nrfconnect/sdk-nrf ${commit} nrf`));
  assert.match(WORKFLOW, new RegExp(`image: ghcr\\.io/nrfconnect/sdk-nrf-toolchain:${version}@sha256:[0-9a-f]{64}\\n`));
  assert.ok(readFileSync(join(REPO, 'firmware/README.md'), 'utf8').includes(version));
});

test('the job that checks a release runs on publishing, and nothing else runs then', () => {
  assert.match(WORKFLOW, /^ {2}release:\n {4}types: \[published\]$/m);
  const jobs = WORKFLOW.slice(WORKFLOW.indexOf('\njobs:\n')).split(/\n(?= {2}[\w-]+:\n)/).slice(1);
  assert.equal(jobs.length, 6);
  for (const job of jobs) {
    const expected = job.startsWith('  release-assets:') ? "github.event_name == 'release'" : "github.event_name != 'release'";
    assert.ok(job.includes(`if: ${expected}`), job.split('\n')[0]);
  }
});
